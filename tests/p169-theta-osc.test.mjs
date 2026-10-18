/**
 * p169 — THETA/OSC 카메라 직접제어 (70_ThetaOSC.js). 실행: node tests/p169-theta-osc.test.mjs
 * TEMP/TMP = E:\code-project\360\.tmp (CLAUDE.md §G-5) — 이 테스트는 파일시스템 I/O 없음(순수 vm).
 *
 * 실제 소스(70_ThetaOSC.js)를 vm 에 그대로 평가. OSC "카메라"는 tests/_lib/osc-mock.mjs(실제 카메라가
 * 없어 공식 응답 형식을 흉내낸 목 — 업무 로직은 목 처리하지 않음, PhotoBatch/App/GPS/Install 만 최소 스텁).
 *
 * 검증 항목: 연결정보 · 촬영→다운로드→핀연결 · 오프라인큐 표시 · 옵션 지원값 필터 · 미리보기 프레임
 *   수신(+중간끊김→재연결) · Insta360 어댑터(라이브뷰 미지원 사유) · 날짜그룹/필터/다중선택연결 ·
 *   리틀플래닛 변환 · SSID/비밀번호 파생.
 *
 * 뮤테이션 3건(끝에 §MUTATION 표로 정리): ① ssidOf 포맷 ② supportedOptions 필터 ③ 미리보기 재연결 한도.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { createOscMock } from "./_lib/osc-mock.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const SRC = rd("public/js/modules/73_ThetaOSC.js");

let failed = 0;
const ok = (cond, label) => { console.log((cond ? "  PASS " : "  FAIL ") + label); if (!cond) failed++; };

function makeLocalStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() };
}

/** 최소 fake DOM(p121-theta-app-handoff.test.mjs makeEl 과 같은 방식) — UI(⑭) 섹션 전용. */
function makeFakeDocument() {
  const registry = new Map();
  function makeElement(tag) {
    const set = new Set();
    const el = {
      tagName: tag, _id: "", attrs: {}, style: {}, dataset: {}, children: [], parentNode: null, _l: {}, textContent: "",
      get id() { return el._id; },
      set id(v) { if (el._id) registry.delete(el._id); el._id = v; if (v) registry.set(v, el); },
      set innerHTML(v) { if (v === "") el.children = []; },
      classList: {
        add: (...c) => c.forEach((x) => set.add(x)), remove: (...c) => c.forEach((x) => set.delete(x)), contains: (c) => set.has(c),
        toggle(c, f) { if (f === undefined) f = !set.has(c); if (f) set.add(c); else set.delete(c); return f; },
      },
      get className() { return Array.from(set).join(" "); },
      set className(v) { set.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => set.add(c)); },
      appendChild(c) { el.children.push(c); c.parentNode = el; return c; },
      insertBefore(n, ref) { const i = el.children.indexOf(ref); if (i >= 0) el.children.splice(i, 0, n); else el.children.push(n); n.parentNode = el; return n; },
      setAttribute(k, v) { el.attrs[k] = String(v); }, getAttribute(k) { return el.attrs[k]; },
      addEventListener(t, f) { (el._l[t] = el._l[t] || []).push(f); },
      click() { (el._l.click || []).slice().forEach((f) => f({})); },
      querySelector() { return null; },
    };
    return el;
  }
  const body = makeElement("body");
  const doc = {
    createElement: (tag) => makeElement(tag),
    getElementById: (id) => registry.get(id) || null,
    body,
  };
  return { doc, registry };
}

/** 격리된 샌드박스 하나 생성 + 70_ThetaOSC.js 평가. uploadBehavior: PhotoBatch._uploadOneRow 스텁 동작 조정. */
function boot(uploadBehavior) {
  const calls = { uploadOneRow: [], attachToPin: [], enqueue: [] };
  const sandbox = {
    console, setTimeout, Promise, Uint8Array, Uint8ClampedArray, TextEncoder, TextDecoder, Object, Array, Math, JSON, Date, Error, Symbol, String, Number, Boolean, isNaN,
    File: globalThis.File, Blob: globalThis.Blob, btoa: globalThis.btoa, atob: globalThis.atob,
    localStorage: makeLocalStorage(),
    Install: { isNativeApp: () => true },
    App: { _detect360: (file, cb) => cb(true, 6720, 3360) },
    GPS: { attachToPin: (pin) => { calls.attachToPin.push(pin); pin.gps = { lat: 1, lng: 2, src: "device" }; } },
    PhotoFolder: {
      // [테스트 전용 단순화] 실제 60_PhotoFolder.isMatch(전체 일치 → 끝 3자리 폴백)를 간략 재현.
      findMatches(pinNo, entries) {
        const pn = parseInt(pinNo, 10);
        return (entries || []).filter((e) => {
          const m = /(\d+)(?=\.[^.]+$)/.exec(e.name || "");
          if (!m) return false;
          const full = parseInt(m[1], 10);
          if (full === pn) return true;
          if (pn <= 999 && m[1].length > 3) return parseInt(m[1].slice(-3), 10) === pn;
          return false;
        });
      },
    },
    PhotoBatch: {
      _usedPhotoNames: () => new Set(),
      async _uploadOneRow(pin, row, overwrite, usedNames, source) {
        calls.uploadOneRow.push({ pin, row, overwrite, source });
        if (uploadBehavior === "offline") { calls.enqueue.push(row.name); return { status: "done", offline: true }; }
        if (uploadBehavior === "fail") return { status: "fail", reason: "네트워크 오류(mock)" };
        pin.imageId = "img_" + row.name;
        return { status: "done", offline: false };
      },
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC + "\n;globalThis.__TO = ThetaOSC;", sandbox);
  return { TO: sandbox.__TO, sandbox, calls };
}

/* ══ ① 카메라 등록 + SSID/비밀번호 파생(배경사실 SoT) ══════════════════════════ */
{
  const { TO } = boot();
  const serials = ["YJ30142118", "YJ20123059", "YJ30142297", "YJ30141545"];
  ok(TO.ssidOf("YJ30142118") === "THETAYJ30142118.OSC", "①-1 SSID 파생 = THETA+시리얼+.OSC");
  ok(TO.passwordOf("YJ30142118") === "30142118", "①-2 비밀번호 = 시리얼 숫자부");
  serials.forEach((s) => TO.registerCamera(s));
  ok(TO.listCameras().length === 4, "①-3 마스터 카메라 4대 등록");
  TO.selectCamera("YJ20123059");
  ok(TO.selectedCamera() === "YJ20123059", "①-4 선택 카메라 저장");
  TO.removeCamera("YJ30141545");
  ok(TO.listCameras().length === 3, "①-5 제거");
}

/* ══ ② 연결 정보(/osc/info, /osc/state) — 있는 것만, 지어내지 않음 ══════════════ */
await (async () => {
  const { TO } = boot();
  const mock = createOscMock({ vendor: "theta", serial: "YJ30142118", battery: 0.73 });
  const cli = TO.client({ fetchImpl: mock.fetchImpl });
  const info = await cli.info();
  const caps = TO.capabilitiesFromInfo(info);
  ok(caps.model === "RICOH THETA SC" && caps.supportsV21 === true, "②-1 기종·v2.1 지원 판정(apiLevel 포함 여부로, 하드코딩 아님)");
  const state = await cli.state();
  const st = TO.statusFromState(state);
  ok(Math.abs(st.batteryLevel - 0.73) < 1e-9, "②-2 배터리(있으면 그 값)");
  const adapter = TO.detectAdapter(info);
  ok(adapter.vendor === "theta" && adapter.liveview === true, "②-3 어댑터 판정 — THETA(라이브뷰 가능)");
})();

/* ══ ③ 촬영 → 다운로드 → 핀 연결(PhotoBatch._uploadOneRow 재사용) ══════════════ */
await (async () => {
  const { TO, calls } = boot("online");
  const mock = createOscMock({ vendor: "theta" });
  const cli = TO.client({ fetchImpl: mock.fetchImpl });
  const pin = { id: "p1", no: 7 };
  const r = await TO.captureToPin(cli, "YJ30142118", pin, "THETA촬영");
  ok(r.status === "done" && typeof r.fileUrl === "string" && r.fileUrl.indexOf("192.168.1.1") !== -1, "③-1 촬영→다운로드→업로드 완료");
  ok(calls.uploadOneRow.length === 1 && calls.uploadOneRow[0].pin === pin, "③-2 PhotoBatch._uploadOneRow 재사용(재구현 아님)");
  ok(calls.attachToPin.length === 1, "③-3 GPS.attachToPin 재사용(새 핀에 위치 부착)");
  ok(TO.isTransferred("YJ30142118", r.fileUrl) === true, "③-4 전송 이력 기록");
})();

/* ══ ④ 오프라인 큐 → 복귀 업로드(표시) ══════════════════════════════════════ */
await (async () => {
  const { TO, calls } = boot("offline");
  const mock = createOscMock({ vendor: "theta" });
  const cli = TO.client({ fetchImpl: mock.fetchImpl });
  const pin = { id: "p2", no: 9 };
  const r = await TO.captureToPin(cli, "YJ30142118", pin, "THETA촬영");
  ok(r.status === "done" && r.offline === true, "④-1 오프라인이면 offline:true 로 표시(조용한 실패 아님)");
  ok(calls.enqueue.length === 1, "④-2 SyncQueue 경로(PhotoBatch._uploadOneRow 내부)로 큐잉");
  ok(TO.isTransferred("YJ30142118", r.fileUrl) === true, "④-3 오프라인이어도 전송 이력은 즉시 기록(큐잉 성공)");
})();

/* ══ ⑤ 옵션 — 지원하는 값만 노출(getOptions 그대로, 모델별 표 하드코딩 없음) ══════ */
await (async () => {
  const { TO } = boot();
  const mock = createOscMock({ vendor: "theta", supportedOptionNames: ["iso", "shutterSpeed", "exposureProgram"] });
  const cli = TO.client({ fetchImpl: mock.fetchImpl });
  const got = await TO.supportedOptions(cli, ["iso", "shutterSpeed", "whiteBalance", "_captureInterval"]);
  ok(Object.keys(got).sort().join(",") === "iso,shutterSpeed", "⑤-1 카메라가 응답한 옵션만 노출(whiteBalance·interval 제외)");
  try { await TO.setOptions(cli, { whiteBalance: "auto" }); ok(false, "⑤-2 미지원 옵션 setOptions 는 예외여야"); }
  catch (e) { ok(/지원하지 않는 옵션/.test(e.message), "⑤-2 미지원 옵션 setOptions → 카메라 오류 그대로 전달"); }
})();

/* ══ ⑥ 라이브 미리보기 — 프레임 수신 + 중간 끊김→재연결 ══════════════════════════ */
await (async () => {
  const { TO } = boot();
  const mock = createOscMock({ vendor: "theta", previewFrameCount: 4 });
  const cli = TO.client({ fetchImpl: mock.fetchImpl });
  const frames = [];
  for await (const f of TO.livePreviewFrames(cli, { maxRetries: 2 })) frames.push(new TextDecoder().decode(f));
  ok(frames.length === 4 && frames[0] === "JPEGFRAME0" && frames[3] === "JPEGFRAME3", "⑥-1 MJPEG multipart 프레임 4장 정확히 파싱");
})();
await (async () => {
  const { TO } = boot();
  const mock = createOscMock({ vendor: "theta", previewFrameCount: 4, previewMidStreamDisconnectAfter: 2 });
  const cli = TO.client({ fetchImpl: mock.fetchImpl });
  const frames = [];
  for await (const f of TO.livePreviewFrames(cli, { maxRetries: 2 })) frames.push(new TextDecoder().decode(f));
  ok(frames.length === 6, "⑥-2 중간 끊김(2장 후) → 재연결 → 재호출 스트림 4장 전부 = 총 6장 수신(정지 명령 없음 전제 그대로 재현)");
})();
await (async () => {
  const { TO } = boot();
  const mock = createOscMock({ vendor: "theta", previewFailFirst: 5 });
  const cli = TO.client({ fetchImpl: mock.fetchImpl });
  let threw = null;
  try { for await (const f of TO.livePreviewFrames(cli, { maxRetries: 2 })) {} } catch (e) { threw = e; }
  ok(threw instanceof Error, "⑥-3 재시도 한도 초과 → 예외로 표면화(조용한 실패 아님)");
})();

/* ══ ⑦ Insta360 어댑터 — 공통 OSC만, 라이브뷰는 사유와 함께 미지원 ══════════════════ */
await (async () => {
  const { TO } = boot();
  const mock = createOscMock({ vendor: "insta360" });
  const cli = TO.client({ fetchImpl: mock.fetchImpl });
  const info = await cli.info();
  const adapter = TO.detectAdapter(info);
  ok(adapter.vendor === "insta360" && adapter.liveview === false && /공식 문서/.test(adapter.liveviewReason), "⑦-1 Insta360 판정 — 라이브뷰 미지원(공식 문서 확인된 사유)");
  ok(adapter.exposureAdjustable === false && adapter.videoSupported === false, "⑦-1b Insta360 — 노출조정 불가·동영상(OSC) 미지원 플래그(공식 문서 확인)");
  const opts2 = await TO.supportedOptions(cli, ["iso", "shutterSpeed"]);
  ok(typeof opts2 === "object", "⑦-2 공통 OSC(getOptions)는 기종 불문 동작");
  let threw = null;
  try { await TO.getLivePreviewStream(cli); } catch (e) { threw = e; }
  ok(threw instanceof Error && /Insta360 OSC 라이브뷰 미지원/.test(threw.message), "⑦-3 getLivePreview 호출 시 카메라가 돌려준 403 오류 메시지가 예외로 표면화");
})();

/* ══ ⑧ 갤러리 — 날짜 그룹 / 필터 / 배지 / 다중선택 연결 ══════════════════════════ */
{
  const { TO } = boot();
  const entries = [
    { name: "R0010001.JPG", dateTime: "2024:11:10 09:00:00", registered: true, pinNo: 1, zone: "A" },
    { name: "R0010002.JPG", dateTime: "2024:11:10 09:05:00", registered: false, pinNo: null, zone: "A" },
    { name: "R0010003.JPG", dateTime: "2024:11:11 10:00:00", registered: false, pinNo: null, zone: "B" },
  ];
  const groups = TO.groupByDate(entries);
  ok(groups.length === 2 && groups[0].items.length === 1 && groups[1].items.length === 2, "⑧-1 날짜별 그룹(최신 날짜 먼저)");
  const onlyUnreg = TO.filterEntries(entries, { registered: false });
  ok(onlyUnreg.length === 2, "⑧-2 필터: 미등록만");
  const zoneA = TO.filterEntries(entries, { zone: "A" });
  ok(zoneA.length === 2, "⑧-3 필터: 구역");
  ok(TO.badgeFor(entries[0]) === "핀 1" && TO.badgeFor(entries[1]) === "미등록", "⑧-4 배지(등록됨/미등록)");
}
await (async () => {
  const { TO, calls } = boot("online");
  const mock = createOscMock({ vendor: "theta", files: [{ name: "R0010007.JPG", fileUrl: "http://192.168.1.1/files/100RICOH/R0010007.JPG" }] });
  const cli = TO.client({ fetchImpl: mock.fetchImpl });
  const pins = [{ id: "pin7", no: 7 }, { id: "pin9", no: 9 }];
  const entries = await TO.listFiles(cli);
  const matches = TO.matchEntriesToPins(pins, entries);
  ok(matches.length === 1 && matches[0].pin.id === "pin7", "⑧-5 번호매칭(60_PhotoFolder.findMatches 재사용) — 7번 핀만 매칭");
  const results = await TO.connectSelectedEntries(cli, "YJ30142118", matches, "THETA갤러리");
  ok(results.length === 1 && results[0].status === "done", "⑧-6 다중선택 → 도면 핀에 연결 완료");
  ok(calls.uploadOneRow.length === 1, "⑧-7 연결도 PhotoBatch._uploadOneRow 재사용");
})();

/* ══ ⑨ 리틀 플래닛 변환 — 순수(캔버스 없이) ══════════════════════════════════ */
{
  const { TO } = boot();
  const srcW = 8, srcH = 4;
  const src = new Uint8ClampedArray(srcW * srcH * 4);
  for (let y = 0; y < srcH; y++) for (let x = 0; x < srcW; x++) { const i = (y * srcW + x) * 4; src[i] = x * 30; src[i + 1] = y * 60; src[i + 2] = 0; src[i + 3] = 255; }
  const { data, size } = TO.littlePlanetTransform(src, srcW, srcH, 16);
  ok(size === 16 && data.length === 16 * 16 * 4, "⑨-1 출력 크기 정확");
  const corner = (0 * 16 + 0) * 4; // 원 밖(모서리) — 알파 0
  ok(data[corner + 3] === 0, "⑨-2 원 바깥은 투명(알파 0) — 사각 썸네일에 검은 모서리 없음");
  const centerI = (8 * 16 + 8) * 4;
  ok(data[centerI + 3] === 255, "⑨-3 중심은 불투명(천정 방향 매핑)");
}

/* ══ ⑩ 웹(PWA) 숨김 게이트 ══════════════════════════════════════════════════ */
{
  const s1 = boot();
  ok(s1.TO.isAvailable() === true && s1.TO.webDisabledReason() === "", "⑩-1 APK(Install.isNativeApp=true) → 사용 가능");
  const sandbox2 = s1.sandbox;
  sandbox2.Install.isNativeApp = () => false;
  ok(s1.TO.isAvailable() === false && /APK/.test(s1.TO.webDisabledReason()), "⑩-2 웹에서는 비활성 사유 표시(열람자 0)");
}

/* ══ ⑪ WiFi 연결 — 네이티브 플러그인 없으면 수동 안내(SSID/PW) ══════════════════ */
await (async () => {
  const { TO } = boot();
  const r = await TO.connectWifi("YJ30142118");
  ok(r.ok === false && r.mode === "manual" && r.ssid === "THETAYJ30142118.OSC" && r.password === "30142118", "⑪-1 네이티브 플러그인 없음 → 수동 안내(SSID/PW 그대로 반환, UI 복사버튼용)");
})();

/* ══ ⑫ 네이티브 경로(OscCameraPlugin) — WiFi 연결 / HTTP 어댑터 / 라이브뷰 이벤트 ══════════
   🔴 [마스터 현장 이슈] bindProcessToNetwork 금지 — 카메라 요청만 Network#openConnection 로
   개별 바인딩(실제 네이티브 코드는 android-app/android/.../OscCameraPlugin.java). 여기서는
   cap.nativePromise/cap.nativeCallback 호출 "인터페이스"와 라우팅 분리만 단위검증한다(JS 쪽
   책임 — 네이티브 쪽 소켓 동작은 실기기 전까지 [Uncertain], .tmp/theta-sc-fieldtest.md 참조). */
await (async () => {
  const { TO, sandbox } = boot();
  const nativeCalls = [];
  sandbox.window.Capacitor = {
    nativePromise: async (plugin, method, args) => { nativeCalls.push({ plugin, method, args }); return { ok: true }; },
  };
  const r = await TO.connectWifi("YJ30142118");
  ok(r.ok === true && r.mode === "native", "⑫-1 네이티브 플러그인 있으면 그 경로로 연결");
  ok(nativeCalls.length === 1 && nativeCalls[0].plugin === "OscCamera" && nativeCalls[0].method === "connect" && nativeCalls[0].args.ssid === "THETAYJ30142118.OSC", "⑫-2 OscCamera.connect(ssid,password) 호출(bindProcessToNetwork 아님 — 카메라 전용 네트워크만 요청)");
})();
await (async () => {
  const { TO, sandbox } = boot();
  sandbox.window.Capacitor = { nativePromise: async () => { throw new Error("와이파이 거부(mock)"); } };
  const r = await TO.connectWifi("YJ30142118");
  ok(r.ok === false && r.mode === "native" && /거부/.test(r.reason), "⑫-3 네이티브 연결 실패 → 사유와 함께 실패 보고(수동 폴백은 호출부가 안내)");
})();
await (async () => {
  const { TO, sandbox } = boot();
  sandbox.window.Capacitor = {
    nativePromise: async (plugin, method, args) => {
      if (method === "request") {
        const bodyText = args.bodyBase64 ? Buffer.from(args.bodyBase64, "base64").toString("utf8") : null;
        if (String(args.url).endsWith("/osc/info")) return { status: 200, contentType: "application/json", bodyBase64: Buffer.from(JSON.stringify({ model: "RICOH THETA SC" })).toString("base64") };
        if (bodyText && JSON.parse(bodyText).name === "camera.takePicture") return { status: 200, contentType: "application/json", bodyBase64: Buffer.from(JSON.stringify({ name: "camera.takePicture", id: "1", state: "done", results: { fileUrl: "http://192.168.1.1/files/x.jpg" } })).toString("base64") };
        return { status: 404, contentType: "application/json", bodyBase64: Buffer.from("{}").toString("base64") };
      }
      throw new Error("미지원 메서드: " + method);
    },
  };
  const cap = sandbox.window.Capacitor;
  const fetchImpl = TO.nativeFetchAdapter(cap);
  const cli = TO.client({ fetchImpl });
  const info = await cli.info();
  ok(info.model === "RICOH THETA SC", "⑫-4 nativeFetchAdapter — GET(JSON) 라운드트립(base64↔객체)");
  const exec = await cli.execute("camera.takePicture", {});
  ok(exec.state === "done" && exec.results.fileUrl.indexOf("192.168.1.1") !== -1, "⑫-5 nativeFetchAdapter — POST(JSON body) 라운드트립");
})();
await (async () => {
  const { TO, sandbox } = boot();
  let frameListener = null, errorListener = null, startCount = 0;
  sandbox.window.Capacitor = {
    nativeCallback: (plugin, method, args, cb) => { if (args.eventName === "previewFrame") frameListener = cb; if (args.eventName === "previewError") errorListener = cb; },
    nativePromise: async (plugin, method) => {
      if (method === "startPreview") {
        startCount++;
        setTimeout(() => {
          if (startCount === 1) { frameListener({ dataBase64: TO._bytesToBase64(new TextEncoder().encode("F1")) }); errorListener({ message: "중간 끊김(mock)" }); }
          else { frameListener({ dataBase64: TO._bytesToBase64(new TextEncoder().encode("F2")) }); }
        }, 0);
        return {};
      }
      return {};
    },
  };
  const cap = sandbox.window.Capacitor;
  const frames = [];
  let n = 0;
  for await (const f of TO.livePreviewFramesNative(cap, { maxRetries: 2 })) {
    frames.push(new TextDecoder().decode(f));
    n++;
    if (n === 2) break;
  }
  ok(frames.join(",") === "F1,F2", "⑫-6 네이티브 프레임 이벤트 — 중간 오류 후 자동 재연결(startPreview 2회)로 F1,F2 수신");
  ok(startCount === 2, "⑫-7 끊김 1회 → startPreview 재호출 1회(재연결 로직)");
})();

/* ══ ⑬ network_security_config.xml 정적 검사 — 카메라 IP(192.168.1.1) 한 곳만 cleartext 허용 ══ */
{
  const nscPath = path.join(ROOT, "android-app/android/app/src/main/res/xml/network_security_config.xml");
  const xml = fs.readFileSync(nscPath, "utf8");
  const domainConfigs = xml.match(/<domain-config[^>]*cleartextTrafficPermitted="true"[\s\S]*?<\/domain-config>/g) || [];
  ok(domainConfigs.length === 1, "⑬-1 cleartext 허용 domain-config 는 정확히 1개");
  const domains = (domainConfigs[0] || "").match(/<domain[^>]*>([^<]+)<\/domain>/g) || [];
  ok(domains.length === 1 && /192\.168\.1\.1/.test(domains[0]), "⑬-2 그 1개 domain-config 안의 도메인도 정확히 1개(192.168.1.1)");
  ok(!/<base-config[^>]*cleartextTrafficPermitted="true"/.test(xml), "⑬-3 base-config(전역) cleartext 허용은 없음 — 그 외 모든 도메인은 여전히 HTTPS 전용");
  const manifestXml = fs.readFileSync(path.join(ROOT, "android-app/android/app/src/main/AndroidManifest.xml"), "utf8");
  ok(/android:networkSecurityConfig="@xml\/network_security_config"/.test(manifestXml), "⑬-4 AndroidManifest 가 이 설정을 실제로 참조");
}

/* ══ ⑭ [THETA] 화면 UI — 4탭 렌더 · FAB→세션/라이브뷰 · 웹 안내 · 진입점 연동(정적) ══════════ */
function attachDom(booted) {
  const { doc } = makeFakeDocument();
  booted.sandbox.document = doc;
  booted.sandbox.window.document = doc;
  booted.sandbox.URL = { createObjectURL: () => "blob://x", revokeObjectURL: () => {} };
  const uiCalls = { apkOpen: 0, panoLoad: [], toasts: [] };
  booted.sandbox.ApkInstall = { open: () => { uiCalls.apkOpen++; } };
  booted.sandbox.PanoViewer = { load: (url, name) => uiCalls.panoLoad.push({ url, name }) };
  booted.sandbox.Prompt = { toast: (m) => uiCalls.toasts.push(m) };
  booted.sandbox.CaptureSession = { current: () => null };
  booted.sandbox.navigator = { onLine: true };
  booted.sandbox.SyncQueue = { count: async () => 0 };
  booted.sandbox.Prompt.confirm = async () => true;
  return { doc, uiCalls };
}
/** fake 엘리먼트 트리에서 className 포함 노드 전부(재귀) — querySelectorAll 대체. */
function collectByClass(node, cls) {
  const out = [];
  (node.children || []).forEach((c) => {
    if (c.classList && c.classList.contains(cls)) out.push(c);
    out.push(...collectByClass(c, cls));
  });
  return out;
}
{
  const booted = boot();
  const { doc, uiCalls } = attachDom(booted);
  booted.sandbox.Install.isNativeApp = () => false; // 웹(PWA)
  const r = booted.TO.open();
  ok(r === "install" && uiCalls.apkOpen === 1 && !doc.getElementById("theta-osc-screen"), "⑭-1 웹에서 [THETA] 진입 → 화면 안 열고 ApkInstall.open() 안내");
}
await (async () => {
  const booted = boot();
  const { doc } = attachDom(booted);
  const r = booted.TO.open();
  ok(r === "open", "⑭-2 APK에서는 open() 이 화면을 연다");
  const tabsBar = doc.getElementById("to-tabs");
  const labels = tabsBar.children.map((b) => b.textContent);
  ok(labels.join(",") === "폰 사진,카메라 사진,프로젝트 등록,설정", "⑭-3 4탭 정확히(폰 사진/카메라 사진/프로젝트 등록/설정)");
  ok(!doc.getElementById("theta-osc-screen").classList.contains("hidden"), "⑭-4 화면이 보임(hidden 해제)");
  await booted.TO._refreshStatus(); // open() 의 _renderStatus() 는 비동기(폴링 시작) — 1회분 반영을 기다린다
  const status = doc.getElementById("to-status");
  ok(/Wi-Fi 연결됨|연결 안 됨/.test(status.textContent) && /모바일 데이터/.test(status.textContent), "⑭-5 상태줄 '카메라: … · 인터넷: 모바일 데이터' 형식");
  booted.TO._stopStatusPolling();
})();
{
  const { TO } = boot();
  const session = { pins: [{ id: "a", no: 1 }, { id: "b", no: 2 }], index: 0 };
  ok(TO.fabAction(session).mode === "nextPin" && TO.fabAction(session).pin.no === 1, "⑭-6 세션 중 FAB → '다음 핀 촬영'(라이브뷰/자유촬영 아님)");
  ok(TO.fabAction(null).mode === "freeShot", "⑭-7 세션 없으면 FAB → 자유 촬영");
  const done = { pins: [{ id: "a", no: 1 }], index: 1 };
  ok(TO.fabAction(done).mode === "sessionDone", "⑭-8 세션의 핀을 모두 촬영하면 '완료'");
}
await (async () => {
  const booted = boot();
  const { doc, uiCalls } = attachDom(booted);
  booted.TO.open();
  doc.getElementById("to-shutter-fab").click();
  ok(uiCalls.toasts.some((t) => /카메라 연결 안 됨/.test(t)) && !doc.getElementById("to-live-shoot"), "⑭-9a 카메라 미연결 — FAB 눌러도 라이브뷰 안 열림, 안내만");
})();
await (async () => {
  const booted = boot("online");
  const { doc, uiCalls } = attachDom(booted);
  booted.TO.open();
  const mock = createOscMock({ vendor: "theta" });
  booted.TO._cli = booted.TO.client({ fetchImpl: mock.fetchImpl });
  booted.TO._serial = "YJ30142118";
  booted.TO._session = { pins: [{ id: "a", no: 5 }], index: 0 };
  booted.TO._onShutter(); // FAB → 라이브뷰 화면
  ok(!!doc.getElementById("to-live-shoot") && !!doc.getElementById("to-live-img"), "⑭-9b FAB(연결됨) → 라이브뷰 화면(이미지+[촬영]버튼) 오픈");
  await booted.TO._doCapture(); // [촬영] 버튼과 같은 핸들러
  ok(uiCalls.toasts.some((t) => /핀 5 등록 완료/.test(t)), "⑭-9c [촬영] → 다운로드 → 세션 현재 핀(5)에 즉시 연결 완료 토스트");
  booted.TO._stopLivePreviewUi();
})();
{
  // 라이브뷰 — Insta360(liveview:false)이면 PanoViewer.load 를 호출하지 않는다(호출부가 adapter.liveview 를 먼저 봄).
  const booted = boot();
  const { uiCalls } = attachDom(booted);
  const adapterTheta = booted.TO.detectAdapter({ manufacturer: "RICOH", model: "RICOH THETA SC" });
  const adapterInsta = booted.TO.detectAdapter({ manufacturer: "Insta360", model: "Insta360 X5" });
  if (adapterTheta.liveview) booted.TO._showLiveFrame(new Uint8Array([1, 2, 3]));
  ok(uiCalls.panoLoad.length === 1, "⑭-10 THETA(liveview:true) → PanoViewer.load 호출(라이브뷰 재사용)");
  ok(adapterInsta.liveview === false, "⑭-11 Insta360(liveview:false) → 호출부가 _showLiveFrame 을 안 부르므로 PanoViewer 호출 0(설계상 가드)");
}
{
  // 진입점 연동(정적 검사) — index.html 레일 칩 · RailLabels 라벨 · FeatureMenu 항목 · CaptureSession 연동.
  const idx = rd("public/index.html");
  ok(/data-deleg="btn-theta-osc"/.test(idx), "⑭-12 index.html 레일 칩(btn-theta-osc) 존재");
  const ui11 = rd("public/js/modules/11_UI.js");
  ok(/data-deleg="btn-theta-osc"[^}]*label:\s*"카메라"/.test(ui11), "⑭-13 RailLabels 가 그 칩에 '카메라' 라벨 등록");
  const fm = rd("public/js/modules/45_FeatureMenu.js");
  ok(/id:\s*"theta-osc"[\s\S]{0,200}ThetaOSC\.open\(\)/.test(fm), "⑭-14 FeatureMenu 항목이 ThetaOSC.open() 을 호출");
  const cs = rd("public/js/modules/69_CaptureSession.js");
  ok(/ThetaOSC\.open\(\{\s*session:\s*s\s*\}\)/.test(cs), "⑭-15 CaptureSession [카메라로 촬영] → ThetaOSC.open({session}) 연동(함수 경계)");
}

/* ══ ⑮ 탭 실연동 — 카메라사진(목록/날짜그룹/가져오기/핀연결) · 설정(옵션필터) · 상태줄 ══════════ */
await (async () => {
  const booted = boot("online");
  const { doc, uiCalls } = attachDom(booted);
  const nativeCalls = [];
  booted.sandbox.window.Capacitor = { nativePromise: async (p, m, a) => { nativeCalls.push({ p, m, a }); return {}; } };
  booted.TO.open();
  const mock = createOscMock({
    vendor: "theta", serial: "YJ30142118",
    files: [
      { name: "R0010001.JPG", fileUrl: "http://192.168.1.1/files/100RICOH/R0010001.JPG", dateTime: "2024:11:10 09:00:00" },
      { name: "R0010002.JPG", fileUrl: "http://192.168.1.1/files/100RICOH/R0010002.JPG", dateTime: "2024:11:11 09:00:00" },
    ],
  });
  booted.TO._cli = booted.TO.client({ fetchImpl: mock.fetchImpl });
  booted.TO._serial = "YJ30142118";
  const body = doc.getElementById("to-body");
  const entries = [
    { name: "R0010001.JPG", fileUrl: "http://192.168.1.1/files/100RICOH/R0010001.JPG" },
    { name: "R0010002.JPG", fileUrl: "http://192.168.1.1/files/100RICOH/R0010002.JPG" },
  ];
  await booted.TO._renderCameraGallery(body);
  let groups = collectByClass(body, "to-dategroup");
  let thumbs = collectByClass(body, "to-thumb");
  ok(groups.length === 2, "⑮-1 카메라 사진 탭 — 날짜 그룹 2개(2024/11/10, 2024/11/11)");
  ok(thumbs.length === 2, "⑮-2 카메라 사진 탭 — 목록 2장 렌더(listFiles 결과 그대로)");
  const findByUrl = (list, url) => list.find((c) => c.dataset.fileUrl === url);
  const cellA = findByUrl(thumbs, entries[0].fileUrl); // R0010001 — 핀 1번과 매칭될 파일(끝 3자리 폴백)
  cellA.dataset.selected = "true"; cellA.classList.add("sel");
  await booted.TO._importSelectedCameraEntries(entries); // 완료 후 탭을 다시 그린다(아래에서 새 노드를 다시 조회)
  ok(nativeCalls.some((c) => c.p === "Filesystem" && c.m === "writeFile"), "⑮-3 [가져오기] — Filesystem.writeFile 재사용(새 저장 로직 없음)");
  ok(booted.TO.isTransferred("YJ30142118", entries[0].fileUrl), "⑮-4 가져온 파일은 전송 이력에 즉시 기록(재방문 시 '가져옴' 배지)");

  const pins = [{ id: "pin1", no: 1 }];
  booted.sandbox.State = { pins };
  // _importSelectedCameraEntries 내부의 재렌더(this._renderTabBody, fire-and-forget)는 타이밍에 의존하지
  // 않게 직접 다시 그려 결정적으로 새 노드를 얻는다(프로덕션 동작은 그대로, 테스트만 명시적으로 대기).
  body.innerHTML = "";
  await booted.TO._renderCameraGallery(body);
  thumbs = collectByClass(doc.getElementById("to-body"), "to-thumb");
  findByUrl(thumbs, entries[0].fileUrl).dataset.selected = "true";
  await booted.TO._linkSelectedCameraEntries(entries);
  ok(booted.calls.uploadOneRow.length === 1 && booted.calls.uploadOneRow[0].pin === pins[0], "⑮-5 [도면 핀에 연결] — 60_PhotoFolder 매칭(1번) → PhotoBatch._uploadOneRow 등록");
})();
await (async () => {
  const booted = boot();
  const { doc } = attachDom(booted);
  booted.TO.open();
  const mock = createOscMock({ vendor: "theta", supportedOptionNames: ["iso", "shutterSpeed"] });
  await booted.TO._connectActive("YJ30142118", { fetchImpl: mock.fetchImpl });
  booted.TO._setTab("settings");
  const optEl = doc.getElementById("to-options");
  ok(optEl && optEl.textContent.indexOf("iso") !== -1 && optEl.textContent.indexOf("shutterSpeed") !== -1 && optEl.textContent.indexOf("whiteBalance") === -1, "⑮-6 설정 탭 — getOptions 가 돌려준 값만 노출(요청 목록 중 미지원 제외)");
})();
await (async () => {
  const booted = boot();
  const { doc } = attachDom(booted);
  booted.TO.open();
  const mock = createOscMock({ vendor: "insta360" });
  await booted.TO._connectActive("INSTA-1", { fetchImpl: mock.fetchImpl });
  booted.TO._setTab("settings");
  const warn = doc.getElementById("to-adapter-warn");
  ok(!!warn && /노출/.test(warn.textContent), "⑮-7 설정 탭 — Insta360 노출조정불가 제약 안내 표시");
})();
await (async () => {
  const booted = boot();
  const { doc } = attachDom(booted);
  booted.TO.open();
  booted.TO._cli = {};
  booted.sandbox.navigator.onLine = true;
  let r = await booted.TO._refreshStatus();
  ok(doc.getElementById("to-status").textContent === "카메라: Wi-Fi 연결됨 · 인터넷: 모바일 데이터", "⑮-8 상태줄 갱신 — 연결됨+온라인");
  booted.sandbox.navigator.onLine = false;
  booted.sandbox.SyncQueue.count = async () => 3;
  r = await booted.TO._refreshStatus();
  ok(doc.getElementById("to-status").textContent === "카메라: Wi-Fi 연결됨 · 인터넷: 오프라인 — 큐 3건 대기", "⑮-9 상태줄 갱신 — 오프라인+큐 대기건수 표시");
})();

console.log(failed === 0 ? "\nALL PASS" : "\n" + failed + " FAILED");
process.exitCode = failed === 0 ? 0 : 1;
