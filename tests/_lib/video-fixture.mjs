// tests/_lib/video-fixture.mjs — 실 재생 가능한 초소형 webm 동영상 픽스처를 생성한다.
// [WO 20261016-routevideo-e2e] ffmpeg 등 외부 의존성 0 — 이미 쓰는 헤드리스 Chrome의
// 네이티브 MediaRecorder(canvas.captureStream)로 실제 디코드 가능한 영상 바이트를 만든다
// (가짜 바이트 금지 — CLAUDE.md §5. <video> 가 실제로 loadeddata·duration 을 내야 한다).
// 산출물은 .tmp/fixtures/ 에 캐시(이미 있으면 재생성하지 않음) — git 커밋 대상 아님(.tmp).
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";

export async function ensureVideoFixture(tmpRoot, chromePath) {
  const out = path.join(tmpRoot, "fixtures", "route-fixture.webm");
  if (fs.existsSync(out) && fs.statSync(out).size > 500) return out;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const profileDir = path.join(tmpRoot, "genfix-chrome-" + Date.now());
  const chrome = spawn(chromePath, [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
    "--remote-debugging-port=0", "--user-data-dir=" + profileDir, "--window-size=320,240",
    "--use-fake-ui-for-media-stream", "about:blank"
  ], { stdio: "ignore" });
  try {
    let port = 0;
    for (let i = 0; i < 80 && !port; i++) { try { port = parseInt(fs.readFileSync(path.join(profileDir, "DevToolsActivePort"), "utf8").split("\n")[0], 10); } catch (e) {} if (!port) await wait(150); }
    const getJson = (url) => new Promise((res, rej) => http.get(url, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on("error", rej));
    let pageWs = null;
    for (let i = 0; i < 40 && !pageWs; i++) { try { const l = await getJson("http://127.0.0.1:" + port + "/json/list"); const pg = l.find((t) => t.type === "page"); if (pg) pageWs = pg.webSocketDebuggerUrl; } catch (e) {} if (!pageWs) await wait(250); }
    const ws = new WebSocket(pageWs);
    await new Promise((r) => ws.on("open", r));
    let idc = 0; const pending = new Map();
    ws.on("message", (raw) => { const msg = JSON.parse(raw); if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result); } });
    const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++idc; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
    const ev = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error("eval: " + JSON.stringify(r.exceptionDetails).slice(0, 800)); return r.result.value; };
    await send("Page.enable"); await send("Runtime.enable");
    await send("Page.navigate", { url: "about:blank" });
    await wait(300);
    const b64 = await ev(`(async function(){
      const canvas = document.createElement('canvas'); canvas.width=160; canvas.height=120;
      const ctx = canvas.getContext('2d');
      let hue=0;
      const stream = canvas.captureStream(10);
      const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8', videoBitsPerSecond: 3000000 });
      const chunks = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      const done = new Promise((res) => { rec.onstop = res; });
      // 단색 채움은 과압축되어 몇십 KB로 줄어든다(초기 1회 요청에 전부 버퍼링되어 Range 재현 불가) —
      // 매 프레임 픽셀 단위 노이즈를 섞어 압축을 방해해 실제 수백 KB~1MB대 파일을 만든다.
      const img = ctx.createImageData(160, 120);
      const draw = () => {
        hue=(hue+10)%360;
        for (let i = 0; i < img.data.length; i += 4) {
          img.data[i] = Math.random() * 255; img.data[i+1] = Math.random() * 255; img.data[i+2] = Math.random() * 255; img.data[i+3] = 255;
        }
        ctx.putImageData(img, 0, 0);
        ctx.fillStyle='#fff'; ctx.font='20px sans-serif'; ctx.fillText(String(hue),10,60);
      };
      draw();
      rec.start();
      const iv = setInterval(draw, 100);
      await new Promise((r) => setTimeout(r, 15000));
      clearInterval(iv);
      rec.stop();
      await done;
      const blob = new Blob(chunks, { type: 'video/webm' });
      const buf = await blob.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return btoa(bin);
    })()`);
    fs.writeFileSync(out, Buffer.from(b64, "base64"));
    ws.close();
  } finally {
    chrome.kill();
  }
  return out;
}
