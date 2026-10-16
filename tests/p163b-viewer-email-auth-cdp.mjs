/**
 * p163b-cdp — WO 20261016-viewmail 열람 링크 이메일 인증 — 실 Chrome · 실 워커(src/index.tsx 번들, Miniflare) · 실 D1 · 목 0
 *   외부 호출만 가로챈다: Resend 메일 = 캡처(실발송 0) · Firebase 공개키 = 테스트 RSA 키 · 클라 Firebase 어댑터 = window.WM_VIEWER_AUTH_FB 스텁.
 *
 *  V(서버 메일 수단): V1 링크만 연 브라우저 = 이메일 입력 화면 · 도면 데이터 요청 0 · 대비 ≥ 4.5
 *                     V2 비수신자/수신자 입력 → 같은 안내 문구 · 메일은 수신자에게만
 *                     V3 메일 링크 열기 → 인증 화면 사라지고 열람 · 주소창 비밀 제거 · 열람 시작(open) 기록
 *                     V4 새로고침 → 재인증 없이 열람 · V5 같은 브라우저 새 탭 → 저장된 통행증으로 열람
 *                     V6 저장소를 비운 브라우저(링크만 재전달) → 다시 인증 화면
 *                     V7 디자이너 배포 패널 [열람자 기록] → 관리 화면(상태·목록·차단) → 차단 후 열람 탭 새로고침 = 인증 화면
 *  F(Firebase 수단): F1 이메일 입력 → 어댑터 send(이메일·같은 /v 주소) · F2 메일 링크(?mode=signIn&oobCode) → 열람 · 주소 정리
 *
 * 실행: TEMP=<repo>\.tmp TMP=<repo>\.tmp node tests/p163b-viewer-email-auth-cdp.mjs
 *   뮤테이션: P163B_MUT=<이름> → 격리 사본만 고쳐 빌드, EXIT=1 이어야 한다.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import { Miniflare } from "miniflare";
import WebSocket from "ws";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = path.join(ROOT, ".tmp");
const MUT = process.env.P163B_MUT || "";
const OUT = path.join(TMP, "p163b" + (MUT ? "-mut-" + MUT : ""));
const WORK = path.join(OUT, "work");
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
let failed = 0;
const ok = (c, label, d) => { console.log((c ? "  PASS " : "  FAIL ") + label + (d != null ? " :: " + JSON.stringify(d).slice(0, 400) : "")); if (!c) failed++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
if (!fs.existsSync(CHROME)) { console.log("FAIL Chrome 없음"); process.exit(2); }
const watchdog = setTimeout(() => { console.log("\nWATCHDOG — 300s 초과 → FAIL"); cleanup().finally(() => process.exit(1)); }, 300000);

const MUTS = {
  // 클라 훅 제거 — 401 email_auth_required 를 받아도 인증 화면을 띄우지 않는다
  nohook: ["public/js/modules/22_Auth.js", "if (j401 && j401.email_auth_required) return await ViewerAuth.ensure(this._viewLinkParams());", ""],
  // 메일 링크 비밀을 주소창에 남김
  noclean: ["public/js/modules/68_ViewerAuth.js", "if (m) { this._cleanUrl(); return await this._complete(params, { challenge: m[1] }); }", "if (m) { return await this._complete(params, { challenge: m[1] }); }"],
  // 배포 패널 버튼 배선 제거(렌더 고아)
  nobutton: ["public/js/modules/20_App.js", "if (vw && typeof ViewerAuth !== \"undefined\") {", "if (false) {"],
  // 서버 — 링크 토큰만으로 통행증 발급(이메일 게이트 제거)
  srvgate: ["src/index.tsx", "if (await viewEmailGate(c, sc.p, null, null)) return c.json(", "if (false) return c.json("],
};
if (MUT && !MUTS[MUT]) { console.log("알 수 없는 뮤테이션: " + MUT); process.exit(2); }

/* ── 격리 사본 + 번들 조립(작업트리 main.js 는 건드리지 않는다) ── */
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
for (const f of ["public", "src", "migrations"]) fs.cpSync(path.join(ROOT, f), path.join(WORK, f), { recursive: true, filter: (s) => !/[\\/]public[\\/]js[\\/]main\.js$/.test(s) && !/[\\/]public[\\/](images|manual|vendor)[\\/].*\.(mp4|zip|apk)$/i.test(s) });
if (MUT) {
  const [file, from, to] = MUTS[MUT];
  const fp = path.join(WORK, file);
  const src = fs.readFileSync(fp, "utf8").replace(/\r\n/g, "\n");
  if (src.indexOf(from) < 0) { console.log("  FAIL 뮤테이션 대상 문자열 없음: " + MUT); process.exit(2); }
  fs.writeFileSync(fp, src.replace(from, to));
  console.log("[MUT] " + MUT);
}
const man = fs.readFileSync(path.join(WORK, "public/js/modules/_manifest.txt"), "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
fs.writeFileSync(path.join(WORK, "public/js/main.js"), man.map((f) => fs.readFileSync(path.join(WORK, "public/js/modules", f), "utf8")).join("\n"));
const workerOut = path.join(OUT, "worker.mjs");
await esbuild.build({ entryPoints: [path.join(WORK, "src/index.tsx")], bundle: true, format: "esm", platform: "neutral", outfile: workerOut, jsx: "automatic", jsxImportSource: "hono/jsx", logLevel: "silent", conditions: ["workerd", "worker", "browser"] });

/* ── 정적 자산(ASSETS) = 격리 사본 public · 외부 호출 스텁 ── */
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".woff2": "font/woff2" };
const assets = async (req) => {
  const u = new URL(req.url);
  let p = decodeURIComponent(u.pathname);
  if (p === "/") p = "/index.html";
  const fp = path.join(WORK, "public", p);
  if (!fp.startsWith(path.join(WORK, "public")) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) return new Response("not found", { status: 404 });
  return new Response(fs.readFileSync(fp), { headers: { "content-type": MIME[path.extname(fp).toLowerCase()] || "application/octet-stream", "cache-control": "no-store" } });
};
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "p163bkid";
const spkiPem = "-----BEGIN CERTIFICATE-----\n" + publicKey.export({ type: "spki", format: "der" }).toString("base64").replace(/(.{64})/g, "$1\n") + "\n-----END CERTIFICATE-----\n";
const outbox = [];
const outbound = async (req) => {
  const u = new URL(req.url);
  if (u.hostname === "api.resend.com") { outbox.push(await req.json()); return new Response("{\"id\":\"re\"}", { status: 200, headers: { "content-type": "application/json" } }); }
  if (u.hostname === "www.googleapis.com" && u.pathname.includes("securetoken")) return new Response(JSON.stringify({ [KID]: spkiPem }), { headers: { "content-type": "application/json" } });
  return new Response("blocked", { status: 599 });
};
const b64u = (b) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fbToken = (fp, email) => { const n = Math.floor(Date.now() / 1000); const h = b64u(JSON.stringify({ alg: "RS256", kid: KID })); const p = b64u(JSON.stringify({ iss: "https://securetoken.google.com/" + fp, aud: fp, iat: n, exp: n + 3600, auth_time: n, sub: "fbuser", email, email_verified: true })); return h + "." + p + "." + b64u(crypto.sign("RSA-SHA256", Buffer.from(h + "." + p), privateKey)); };

const mfs = [];
async function boot(tag, port, extra) {
  const mf = new Miniflare({
    modules: true, scriptPath: workerOut, d1Databases: { DB: "p163b" + tag + Date.now() }, r2Buckets: { R2: "p163br2" + tag + Date.now() },
    bindings: Object.assign({ DEMO_LOGIN: "0", AUTO_ENTRY_SECRET: "p163b-secret-0123456789abcdef0123", SUPER_ADMIN_EMAIL: "sup@seastar.test", SUPER_ADMIN_EMAILS: "sup@seastar.test" }, extra),
    serviceBindings: { ASSETS: assets }, outboundService: outbound, compatibilityDate: "2025-01-01", host: "127.0.0.1", port,
  });
  mfs.push(mf);
  const url = String(await mf.ready).replace(/\/$/, "");
  const db = await mf.getD1Database("DB");
  for (const f of fs.readdirSync(path.join(WORK, "migrations")).filter((f) => /^\d+_.*\.sql$/.test(f)).sort()) {
    for (const st of fs.readFileSync(path.join(WORK, "migrations", f), "utf8").replace(/\r\n/g, "\n").replace(/--[^\n]*/g, "").split(";").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean)) await db.exec(st);
  }
  const run = (q, a = []) => db.prepare(q).bind(...a).run();
  const now = Date.now();
  const O = "owner@seastar.test", OT = "local-p163b-owner-" + crypto.randomBytes(5).toString("hex");
  await run("INSERT INTO designers (email, name, added_by, created_at, updated_at, deleted) VALUES (?, 'owner', 'seed', ?, ?, 0)", [O, now, now]);
  await run("INSERT INTO local_users (email, name, domain, pw_hash, pw_salt, email_verified, created_at, updated_at, deleted) VALUES (?, 'owner', 'x', 'h', 's', 1, ?, ?, 0)", [O, now, now]);
  await run("INSERT INTO local_sessions (token, email, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, 0)", [OT, O, now, now + 8.64e7]);
  const P = "prj_p163b_" + tag, D = "dep_p163b_" + tag;
  await run("INSERT INTO projects (id, name, description, owner, created_at, updated_at, deleted) VALUES (?, 'P163B비밀현장', '', ?, ?, ?, 0)", [P, O, now, now]);
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  await run("INSERT INTO deployments (id, title, file_name, pins, zones, annotations, pages_data, page_count, created_at, updated_at, deleted, version, project_id, tenant_id) VALUES (?, 'T', 'a.png', ?, '[]', '[]', ?, 1, ?, ?, 0, 1, ?, 'tnt_default')",
    [D, JSON.stringify([{ id: 1, x: 30, y: 30, page: 1, no: 1, label: "P-1", imageUrl: "/api/r2/object/pano/p163b.jpg" }]), JSON.stringify([png]), now, now, P]).catch(async () =>
    run("INSERT INTO deployments (id, title, file_name, pins, zones, annotations, created_at, updated_at, deleted, version, project_id, tenant_id) VALUES (?, 'T', 'a.png', ?, '[]', '[]', ?, ?, 0, 1, ?, 'tnt_default')",
      [D, JSON.stringify([{ id: 1, x: 30, y: 30, page: 1, no: 1, label: "P-1", imageUrl: "/api/r2/object/pano/p163b.jpg" }]), now, now, P]));
  await run("INSERT INTO decks (id, project_id, name, deployment_id, created_at, updated_at, deleted) VALUES (?, ?, '구역A', ?, ?, ?, 0)", ["dk_p163b_" + tag, P, D, now, now]);
  const api = async (method, u, body, tok) => { const r = await fetch(url + u, { method, headers: Object.assign({ "Content-Type": "application/json" }, tok ? { Authorization: "Bearer " + tok } : {}), body: body == null ? undefined : JSON.stringify(body) }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) {} return { s: r.status, j, t }; };
  const pub = await api("POST", "/api/projects/" + P + "/publish", null, OT);
  const tok = pub.j && pub.j.project && pub.j.project.share_path ? pub.j.project.share_path.replace(/^\/v\//, "") : null;
  return { mf, url, db, run, api, P, D, O, OT, tok };
}

/* ── Chrome(CDP) ── */
let chrome = null; const sockets = [];
async function cleanup() { sockets.forEach((s) => { try { s.close(); } catch (e) {} }); try { chrome && chrome.kill(); } catch (e) {} for (const m of mfs) { try { await m.dispose(); } catch (e) {} } }
const getJson = (u) => new Promise((res, rej) => http.get(u, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on("error", rej));
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl, { maxPayload: 64 * 1024 * 1024 }); sockets.push(ws);
  await new Promise((r) => ws.on("open", r));
  let idc = 0; const pend = new Map(); const listeners = [];
  ws.on("message", (raw) => { const m = JSON.parse(raw); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); return; } listeners.forEach((f) => { try { f(m); } catch (e) {} }); });
  const send = (method, params = {}) => new Promise((res, rej) => { const id = ++idc; pend.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value; };
  const evS = async (e) => { try { return await ev(e); } catch (x) { return { __err: String(x.message).slice(0, 200) }; } };
  const waitFor = async (cond, t = 25000) => { const t0 = Date.now(); while (Date.now() - t0 < t) { if ((await evS("(function(){try{return !!(" + cond + ")}catch(e){return false}})()")) === true) return Date.now() - t0; await wait(150); } return -1; };
  return { send, ev, evS, waitFor, listeners };
}
async function openPage(port, url) {
  const t = await getJson("http://127.0.0.1:" + port + "/json/new?" + encodeURIComponent("about:blank")).catch(async () => {
    return await new Promise((res, rej) => { const rq = http.request({ host: "127.0.0.1", port, path: "/json/new?about:blank", method: "PUT" }, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => res(JSON.parse(d))); }); rq.on("error", rej); rq.end(); });
  });
  const P = await connect(t.webSocketDebuggerUrl);
  await P.send("Page.enable"); await P.send("Runtime.enable"); await P.send("Network.enable");
  P.reqs = [];
  P.listeners.push((m) => { if (m.method === "Network.requestWillBeSent") P.reqs.push(m.params.request.method + " " + m.params.request.url); });
  if (url) await P.send("Page.navigate", { url });
  return P;
}
// 대비 계산(WCAG) — 실행 시점 computed style 기준(소스가 아니라 런타임)
const CONTRAST = `function(el, bgEl){ function rgb(s){ var m=String(s).match(/rgba?\\(([^)]+)\\)/); if(!m) return null; var p=m[1].split(',').map(function(x){return parseFloat(x)}); return p; }
  function lum(p){ var a=p.slice(0,3).map(function(v){ v/=255; return v<=0.03928? v/12.92 : Math.pow((v+0.055)/1.055,2.4); }); return 0.2126*a[0]+0.7152*a[1]+0.0722*a[2]; }
  function bgOf(e){ while(e){ var b=rgb(getComputedStyle(e).backgroundColor); if(b && (b.length<4 || b[3]>0.5)) return b; e=e.parentElement; } return [255,255,255]; }
  var fg=rgb(getComputedStyle(el).color), bg=bgOf(bgEl||el); var L1=lum(fg), L2=lum(bg); return Math.round(((Math.max(L1,L2)+0.05)/(Math.min(L1,L2)+0.05))*100)/100; }`;

try {
  const A = await boot("v", 0, { RESEND_API_KEY: "re_test_not_real" });
  ok(!!A.tok, "준비 — 배포(새 링크 = 이메일 인증 기본 ON)", A.tok);
  await A.api("POST", "/api/projects/" + A.P + "/viewer-access/recipients", { emails: ["alice@example.com"] }, A.OT);
  const linkUrl = A.url + "/v/" + A.tok;

  const profile = path.join(TMP, "p163b-chrome-" + Date.now());
  chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--remote-debugging-port=0", "--user-data-dir=" + profile, "--window-size=1280,900", "about:blank"], { stdio: "ignore" });
  let port = 0;
  for (let i = 0; i < 80 && !port; i++) { try { port = parseInt(fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0], 10); } catch (e) {} if (!port) await wait(150); }

  console.log("\n[V 서버 메일 수단]");
  const V = await openPage(port, linkUrl);
  const tModal = await V.waitFor("document.getElementById('va-modal') && document.getElementById('va-email')", 30000);
  await wait(800);
  const v1 = await V.ev(`(function(){ var c=${CONTRAST}; var m=document.getElementById('va-modal');
    if (!m) return { vis: false, title: '', gates: ['login-gate','share-gate-modal','access-gate'].filter(function(id){ var e=document.getElementById(id); return e && e.classList.contains('on'); }) };
    var r=m.getBoundingClientRect();
    return { vis: r.width>200 && getComputedStyle(m).display!=='none', title: document.getElementById('va-title').textContent,
      cTitle: c(document.getElementById('va-title')), cSub: c(document.getElementById('va-sub')), cInput: c(document.getElementById('va-email')), cBtn: c(document.getElementById('va-send')),
      name: document.documentElement.textContent.indexOf('P163B비밀현장')>=0, pins: (window.__wm && __wm.State && __wm.State.pins) ? __wm.State.pins.length : 0,
      gates: ['login-gate','share-gate-modal','access-gate'].filter(function(id){ var e=document.getElementById(id); return e && e.classList.contains('on'); }) }; })()`);
  ok(tModal >= 0 && v1.vis && /초대받은 이메일/.test(v1.title), "V1a 🔴 링크만 연 브라우저 = 이메일 입력 화면", v1);
  if (!v1.vis) throw new Error("인증 화면 없음 — 이후 단계 생략");
  ok(v1.cTitle >= 4.5 && v1.cSub >= 4.5 && v1.cInput >= 4.5 && v1.cBtn >= 4.5, "V1b 대비 ≥ 4.5(런타임 computed — 제목·설명·입력칸·버튼)", { t: v1.cTitle, s: v1.cSub, i: v1.cInput, b: v1.cBtn });
  ok(!v1.name && v1.pins === 0 && v1.gates.length === 0, "V1c 프로젝트명·핀 0 · 다른 게이트 0", v1);
  ok(!V.reqs.some((r) => /GET .*\/tables\/deployments\/dep_/.test(r)), "V1d 인증 전 도면 데이터 요청 0", V.reqs.filter((r) => /tables|r2/.test(r)));

  const typeSend = async (P, email) => {
    await P.ev(`(function(){ document.getElementById('va-msg').textContent=''; var i=document.getElementById('va-email'); i.value=${JSON.stringify(email)}; document.getElementById('va-send').click(); return true; })()`);
    await P.waitFor("/보냈습니다|잦습니다|실패|설정/.test(document.getElementById('va-msg').textContent)", 10000);
    return await P.ev("document.getElementById('va-msg').textContent");
  };
  const n0 = outbox.length;
  const msgNon = await typeSend(V, "eve@example.com");
  const msgMem = await typeSend(V, "Alice@Example.com");
  await wait(500);
  const mails = outbox.slice(n0);
  ok(msgNon === msgMem && /보냈습니다/.test(msgMem), "V2a 🔴 비수신자/수신자 같은 안내 문구", [msgNon, msgMem]);
  ok(mails.length === 1 && mails[0].to[0] === "alice@example.com", "V2b 메일은 수신자에게만(정규화 주소)", mails.map((m) => m.to));
  const link = mails[0] && String(mails[0].text).match(/https?:\/\/\S+#va=\S+/);

  // 메일 링크 클릭 = 새 문서 로드(같은 주소 + #va= 는 해시만 바뀌어 같은 문서 이동이 되므로 빈 페이지를 거친다)
  await V.send("Page.navigate", { url: "about:blank" });
  await V.waitFor("location.href === 'about:blank'");
  await V.send("Page.navigate", { url: link ? link[0] : linkUrl });
  const tView = await V.waitFor("!document.getElementById('va-modal') && window.__wm && __wm.State.pins && __wm.State.pins.length > 0", 40000);
  const v3 = await V.ev(`({ href: location.href, email: __wm.Auth.user && __wm.Auth.user.email, ro: __wm.Auth.readonly, pins: __wm.State.pins.length, name: document.documentElement.textContent.indexOf('P163B비밀현장')>=0 })`);
  ok(tView >= 0 && v3.pins === 1 && v3.ro === true, "V3a 🔴 메일 링크 → 인증 화면 사라지고 열람(핀 1)", { tView, v3 });
  ok(!/va=/.test(v3.href) && /\/v\//.test(v3.href), "V3b 주소창에서 1회용 비밀 제거", v3.href);
  ok(v3.email === "" && !v3.name, "V3c 세션 email 빈값 · 프로젝트명 0(비식별 유지)", v3);
  await wait(1500);
  const evs = (await A.db.prepare("SELECT kind FROM viewer_events WHERE email = 'alice@example.com' ORDER BY id").all()).results.map((r) => r.kind);
  ok(evs.includes("auth") && evs.includes("open") && evs.includes("zone"), "V3d 기록 — auth·open(열람 시작)·zone", evs);

  await V.send("Page.reload", {});
  const tRe = await V.waitFor("window.__wm && __wm.State.pins && __wm.State.pins.length > 0", 40000);
  ok(tRe >= 0 && (await V.ev("!document.getElementById('va-modal')")), "V4 새로고침 → 재인증 없이 열람", tRe);

  const V2 = await openPage(port, linkUrl);
  const tTab = await V2.waitFor("window.__wm && __wm.State.pins && __wm.State.pins.length > 0", 40000);
  ok(tTab >= 0 && (await V2.ev("!document.getElementById('va-modal')")), "V5 같은 브라우저 새 탭 → 저장된 통행증으로 열람", tTab);

  await V2.ev("(function(){ localStorage.clear(); sessionStorage.clear(); return true; })()");
  await V2.send("Page.navigate", { url: linkUrl });
  const tClr = await V2.waitFor("document.getElementById('va-modal')", 30000);
  ok(tClr >= 0 && (await V2.ev("!(window.__wm && __wm.State.pins && __wm.State.pins.length)")), "V6 🔴 저장소 없는 브라우저(링크만 재전달) → 다시 인증 화면 · 핀 0", tClr);

  console.log("\n[V7 디자이너 배포 패널 → 열람자 기록]");
  const Dz = await openPage(port, A.url + "/manifest.webmanifest");
  await Dz.waitFor("location.pathname === '/manifest.webmanifest'");
  await Dz.ev(`(function(){ localStorage.setItem('wm_local_token', ${JSON.stringify(A.OT)}); return true; })()`);
  await Dz.send("Page.navigate", { url: A.url + "/" });
  const tD = await Dz.waitFor("window.__wm && __wm.Auth && __wm.Auth.user && __wm.Auth.isDesigner", 40000);
  await Dz.ev(`(function(){ var s=document.createElement('div'); s.id='p163-deploy-status'; s.style.cssText='position:fixed;left:0;top:0;z-index:1000;background:#0f172a;color:#e2e8f0;padding:12px;width:600px'; document.body.appendChild(s);
    __wm.App._renderDeployStatus(s, { origin: location.origin, project: { id: ${JSON.stringify(A.P)} }, sharePath: '/v/${A.tok}', pageCount: 1, pins: 1 }); return true; })()`);
  const tLine = await Dz.waitFor("/이메일 인증 켜짐/.test((document.getElementById('deploy-viewer-auth')||{}).textContent||'')", 10000);
  ok(tD >= 0 && tLine >= 0, "V7a 배포 패널 상태 줄 = 이메일 인증 켜짐(서버 상태)", await Dz.evS("(document.getElementById('deploy-viewer-auth')||{}).textContent"));
  await Dz.ev("document.getElementById('btn-deploy-viewers').click(), true");
  const tMgr = await Dz.waitFor("document.getElementById('va-mgr') && /alice@example.com/.test(document.getElementById('va-mgr-list').textContent)", 10000);
  const mg = await Dz.ev(`(function(){ var c=${CONTRAST}; var t=document.getElementById('va-mgr-title'); return { on: document.getElementById('va-mgr-on').checked, method: document.getElementById('va-mgr-method').textContent, list: document.getElementById('va-mgr-list').textContent, cT: c(t), cL: c(document.querySelector('#va-mgr-list td')) }; })()`);
  ok(tMgr >= 0 && mg.on === true && /서버 메일/.test(mg.method) && /허용/.test(mg.list) && /[1-9]\d*회/.test(mg.list), "V7b 🔴 [열람자 기록] → 관리 화면(인증 ON · 수단 · alice 허용 · 열람 횟수)", mg);
  ok(mg.cT >= 4.5 && mg.cL >= 4.5, "V7c 관리 화면 대비 ≥ 4.5(런타임)", { t: mg.cT, l: mg.cL });
  await Dz.ev("document.querySelector('[data-log=\"alice@example.com\"]').click(), true");
  const tTl = await Dz.waitFor("/인증 완료/.test(document.getElementById('va-mgr-tl').textContent) && /열람 시작/.test(document.getElementById('va-mgr-tl').textContent)", 10000);
  ok(tTl >= 0, "V7d [기록] → 이메일 타임라인(인증 완료·열람 시작)", await Dz.evS("document.getElementById('va-mgr-tl').textContent.slice(0,200)"));
  // 차단 — Prompt.confirm 은 자동 승인(테스트 범위 = 관리 화면 배선)
  await Dz.ev("(function(){ __wm.Prompt.confirm = function(){ return Promise.resolve(true); }; document.querySelector('[data-block=\"alice@example.com\"]').click(); return true; })()");
  const tBl = await Dz.waitFor("/차단/.test(document.getElementById('va-mgr-list').textContent) && document.querySelector('[data-reinvite=\"alice@example.com\"]')", 10000);
  ok(tBl >= 0, "V7e [차단] → 목록 상태 차단 · [재초대] 버튼", tBl);
  // 같은 출처 localStorage 공유 — 디자이너 탭의 로컬 세션 토큰이 열람 탭을 디자이너로 로그인시키지 않게 지운다(실사용 = 다른 사람·다른 기기)
  await Dz.ev("(function(){ localStorage.removeItem('wm_local_token'); return true; })()");
  await V.send("Page.reload", {});
  const tBlk = await V.waitFor("document.getElementById('va-modal')", 30000);
  ok(tBlk >= 0 && (await V.ev("!(window.__wm && __wm.State.pins && __wm.State.pins.length)")), "V7f 🔴 차단된 열람 탭 새로고침 → 인증 화면 · 핀 0", tBlk);

  console.log("\n[F Firebase 수단(클라 어댑터 스텁)]");
  const FP = "p163b-fb";
  const F = await boot("f", 0, { FIREBASE_PROJECT_ID: FP });
  await F.api("POST", "/api/projects/" + F.P + "/viewer-access/recipients", { emails: ["dan@example.com"] }, F.OT);
  const fUrl = F.url + "/v/" + F.tok;
  const Fp = await openPage(port, null);
  const idTok = fbToken(FP, "dan@example.com");
  await Fp.send("Page.addScriptToEvaluateOnNewDocument", { source: `window.WM_VIEWER_AUTH_FB = { projectId: ${JSON.stringify(FP)},
    isLink: function(h){ return /[?&]oobCode=/.test(h) && /[?&]mode=signIn/.test(h); },
    send: function(email, url){ localStorage.setItem('__p163fbsent', JSON.stringify({ email: email, url: url })); return Promise.resolve(); },
    complete: function(email, href){ localStorage.setItem('__p163fbdone', JSON.stringify({ email: email, href: href })); return Promise.resolve(${JSON.stringify(idTok)}); } };` });
  await Fp.send("Page.navigate", { url: fUrl });
  await Fp.waitFor("document.getElementById('va-email')", 30000);
  const fm = await typeSend(Fp, "Dan@example.com");
  const sent = await Fp.ev("JSON.parse(localStorage.getItem('__p163fbsent')||'null')");
  ok(/보냈습니다/.test(fm) && sent && sent.email === "dan@example.com" && sent.url === fUrl, "F1 🔴 method=firebase → 어댑터 send(정규화 이메일 · 같은 /v 주소)", { fm, sent });
  await Fp.send("Page.navigate", { url: fUrl + "?apiKey=AIzaTest&oobCode=OOB123&mode=signIn&lang=ko" });
  const tF = await Fp.waitFor("!document.getElementById('va-modal') && window.__wm && __wm.State.pins && __wm.State.pins.length > 0", 40000);
  const f2 = await Fp.ev("({ href: location.href, done: JSON.parse(localStorage.getItem('__p163fbdone')||'null') })");
  ok(tF >= 0 && f2.done && f2.done.email === "dan@example.com" && !/oobCode|apiKey|mode=signIn/.test(f2.href), "F2 🔴 메일 링크(oobCode) → 서버 검증(Firebase ID 토큰) → 열람 · 주소 정리", { tF, f2 });
} catch (e) {
  console.log("  FAIL 예외: " + (e && e.stack || e)); failed++;
}
clearTimeout(watchdog);
await cleanup();
console.log("\n" + (failed ? "FAIL " + failed : "ALL PASS"));
process.exit(failed ? 1 : 0);
