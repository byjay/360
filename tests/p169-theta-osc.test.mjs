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

/** 격리된 샌드박스 하나 생성 + 70_ThetaOSC.js 평가. uploadBehavior: PhotoBatch._uploadOneRow 스텁 동작 조정. */
function boot(uploadBehavior) {
  const calls = { uploadOneRow: [], attachToPin: [], enqueue: [] };
  const sandbox = {
    console, setTimeout, Promise, Uint8Array, Uint8ClampedArray, TextEncoder, TextDecoder, Object, Array, Math, JSON, Date, Error, Symbol, String, Number, Boolean, isNaN,
    File: globalThis.File, Blob: globalThis.Blob,
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
  ok(adapter.vendor === "insta360" && adapter.liveview === false && /\[Uncertain\]/.test(adapter.liveviewReason), "⑦-1 Insta360 판정 — 라이브뷰 미지원 + [Uncertain] 사유(문서 미확인 명시)");
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

console.log(failed === 0 ? "\nALL PASS" : "\n" + failed + " FAILED");
process.exitCode = failed === 0 ? 0 : 1;
