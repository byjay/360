/**
 * OSC(Open Spherical Camera) API 목 서버 — 실제 카메라 없이 70_ThetaOSC.js 를 검증한다.
 * 공식 응답 형식(osc/info, osc/state, osc/commands/execute·status) 준수. 실 HTTP 소켓을 열지
 * 않고 fetch 호환 함수(fetchImpl)를 직접 주입한다(결정적·빠름 — 포트 바인딩 플레이키 회피).
 *
 * vendor: "theta" | "insta360" | "unknown" — /osc/info 의 manufacturer/model 분기.
 * previewFailFirst: getLivePreview 처음 N회 500 실패(재연결 테스트).
 * previewMidStreamDisconnectAfter: 프레임 N개 받은 뒤 스트림 1회 끊김(재연결 테스트).
 * chaos: { takePictureEvery, statusEvery, downloadEvery } — 결정적 "무작위" 끊김(참으로 랜덤이면
 *  CI 플레이키 — N번째 호출마다 실패해 ~1/N 비율을 재현 가능하게 흉내낸다). 명령이 "카메라에 닿기
 *  전" 실패를 흉내내므로(요청 자체를 throw) 재시도가 안전하다 — takeState 를 건드리기 전에 끊는다.
 */
export function createOscMock(opts) {
  opts = opts || {};
  const vendor = opts.vendor || "theta";
  const boundary = "boundary";
  const battery = opts.battery != null ? opts.battery : 0.8;
  const files = opts.files || [];
  const optionsStore = Object.assign(
    { captureMode: "image", exposureProgram: 2, iso: 100, shutterSpeed: 0.004, _captureInterval: 5 },
    opts.options || {}
  );
  const supportedOptionNames = opts.supportedOptionNames || Object.keys(optionsStore);
  const previewFailFirst = opts.previewFailFirst || 0;
  const previewMidStreamDisconnectAfter = opts.previewMidStreamDisconnectAfter;
  const previewFrameCount = opts.previewFrameCount != null ? opts.previewFrameCount : 3;
  const chaos = opts.chaos || null;
  const chaosN = { takePicture: 0, status: 0, download: 0 };
  function chaosFail(kind) {
    if (!chaos) return false;
    const every = chaos[kind + "Every"];
    if (!every) return false;
    chaosN[kind]++;
    return (chaosN[kind] % every) === 0;
  }

  let takeState = null;
  let previewCallCount = 0;
  let disconnectedOnce = false;
  const calls = []; // 호출 로그(테스트 assertion 용)
  const stats = { takePictureSent: 0 }; // "실제로 카메라(mock)에 닿은" 촬영 명령 수 — 중복촬영 검증용

  function jsonResponse(obj, status) {
    status = status || 200;
    return {
      ok: status >= 200 && status < 300, status,
      headers: { get: () => "application/json" },
      json: async () => obj,
      blob: async () => ({ type: "application/json" }),
    };
  }
  function errorExecResponse(name, message, status) {
    return jsonResponse({ name, state: "error", error: { code: "invalidParameterValue", message } }, status || 400);
  }
  function buildFramePart(jpegBytes) {
    const head = new TextEncoder().encode("--" + boundary + "\r\nContent-Type: image/jpeg\r\nContent-Length: " + jpegBytes.length + "\r\n\r\n");
    const tail = new TextEncoder().encode("\r\n");
    const out = new Uint8Array(head.length + jpegBytes.length + tail.length);
    out.set(head, 0); out.set(jpegBytes, head.length); out.set(tail, head.length + jpegBytes.length);
    return out;
  }
  function buildPreviewResponse() {
    async function* gen() {
      for (let i = 0; i < previewFrameCount; i++) {
        if (previewMidStreamDisconnectAfter != null && !disconnectedOnce && i === previewMidStreamDisconnectAfter) {
          disconnectedOnce = true;
          throw new Error("stream reset(mock)");
        }
        yield buildFramePart(new TextEncoder().encode("JPEGFRAME" + i));
      }
    }
    return {
      ok: true, status: 200,
      headers: { get: (k) => (String(k).toLowerCase() === "content-type" ? ("multipart/x-mixed-replace; boundary=" + boundary) : null) },
      body: gen(),
    };
  }

  async function fetchImpl(url, init) {
    init = init || {};
    const u = String(url);
    calls.push({ url: u, method: init.method || "GET" });
    if (u.endsWith("/osc/info")) {
      if (vendor === "insta360") return jsonResponse({ manufacturer: "Insta360", model: "Insta360 X5", serialNumber: "INSTA-TEST", firmwareVersion: "1.0.0", apiLevel: [2] });
      if (vendor === "unknown") return jsonResponse({ manufacturer: "Unknown Co", model: "Mystery Cam", apiLevel: [1] });
      return jsonResponse({ manufacturer: "RICOH", model: "RICOH THETA SC", serialNumber: opts.serial || "YJ30142118", firmwareVersion: "01.62", apiLevel: [1, 2] });
    }
    if (u.endsWith("/osc/state")) return jsonResponse({ state: { _batteryLevel: battery }, fingerprint: "FIG_0001" });
    if (u.endsWith("/osc/commands/status")) {
      if (chaosFail("status")) throw new Error("네트워크 끊김(mock chaos — 상태조회)");
      const body = JSON.parse(init.body || "{}");
      if (takeState && takeState.id === body.id) {
        if (takeState.state === "inProgress") { takeState.state = "done"; return jsonResponse({ id: body.id, state: "done", results: { fileUrl: takeState.fileUrl } }); }
        return jsonResponse({ id: body.id, state: "done", results: { fileUrl: takeState.fileUrl } });
      }
      return jsonResponse({ id: body.id, state: "error", error: { message: "unknown id" } }, 404);
    }
    if (u.endsWith("/osc/commands/execute")) {
      const body = JSON.parse(init.body || "{}");
      const name = body.name;
      if (name === "camera.takePicture") {
        if (chaosFail("takePicture")) throw new Error("네트워크 끊김(mock chaos — 촬영명령, 카메라 닿기 전)");
        stats.takePictureSent++;
        const id = "0001";
        const fileUrl = "http://192.168.1.1/files/100RICOH/R" + (1000000 + stats.takePictureSent) + ".JPG";
        takeState = { id, state: "inProgress", fileUrl };
        return jsonResponse({ name, id, state: "inProgress" });
      }
      if (name === "camera.getOptions") {
        const names = (body.parameters && body.parameters.optionNames) || [];
        const out = {};
        names.forEach((n) => { if (supportedOptionNames.indexOf(n) !== -1 && Object.prototype.hasOwnProperty.call(optionsStore, n)) out[n] = optionsStore[n]; });
        return jsonResponse({ name, state: "done", results: { options: out } });
      }
      if (name === "camera.setOptions") {
        const options = (body.parameters && body.parameters.options) || {};
        const badKey = Object.keys(options).find((k) => supportedOptionNames.indexOf(k) === -1);
        if (badKey) return errorExecResponse(name, "지원하지 않는 옵션: " + badKey, 400);
        Object.assign(optionsStore, options);
        return jsonResponse({ name, state: "done" });
      }
      if (name === "camera.listFiles") return jsonResponse({ name, state: "done", results: { entries: files } });
      if (name === "camera.delete") return jsonResponse({ name, state: "done" });
      if (name === "camera.startCapture" || name === "camera.stopCapture") {
        if (vendor === "insta360") return errorExecResponse(name, "Insta360 OSC 미지원 명령(공식 SDK 별도)", 403);
        return jsonResponse({ name, state: "done" });
      }
      if (name === "camera.getLivePreview") {
        previewCallCount++;
        if (vendor === "insta360") return errorExecResponse(name, "Insta360 OSC 라이브뷰 미지원(공식: 별도 SDK 승인 필요)", 403);
        if (previewCallCount <= previewFailFirst) return jsonResponse({ error: "preview not ready" }, 500);
        return buildPreviewResponse();
      }
      return errorExecResponse(name, "미지원 명령: " + name, 400);
    }
    if (u.indexOf("/files/") !== -1) {
      const bytesAll = new TextEncoder().encode("JPEGDATA-" + u.split("/").pop() + "-".padEnd(32, "x"));
      const rangeHeader = init.headers && (init.headers.Range || init.headers.range);
      if (rangeHeader) {
        const m = /bytes=(\d+)-/.exec(rangeHeader);
        const start = m ? parseInt(m[1], 10) : 0;
        const remaining = bytesAll.slice(start);
        return {
          ok: true, status: 206,
          headers: { get: (k) => { k = String(k).toLowerCase(); if (k === "content-range") return "bytes " + start + "-" + (bytesAll.length - 1) + "/" + bytesAll.length; if (k === "content-length") return String(remaining.length); return null; } },
          blob: async () => new Blob([remaining]),
          body: { [Symbol.asyncIterator]: async function* () { yield remaining; } },
        };
      }
      if (chaosFail("download")) {
        // 끊김 흉내 — 전체 크기는 Content-Length 로 알리지만 바이트는 절반만 준다(스트림 중단).
        // downloadFileResumable 이 크기불일치로 재시도 → Range 로 이어받기를 타게 된다.
        const half = bytesAll.slice(0, Math.max(1, Math.floor(bytesAll.length / 2)));
        return {
          ok: true, status: 200,
          headers: { get: (k) => (String(k).toLowerCase() === "content-length" ? String(bytesAll.length) : null) },
          blob: async () => new Blob([half]),
          body: { [Symbol.asyncIterator]: async function* () { yield half; } },
        };
      }
      return {
        ok: true, status: 200,
        headers: { get: (k) => { k = String(k).toLowerCase(); if (k === "content-length") return String(bytesAll.length); if (k === "content-type") return "image/jpeg"; return null; } },
        blob: async () => new Blob([bytesAll]),
        body: { [Symbol.asyncIterator]: async function* () { yield bytesAll; } },
      };
    }
    return jsonResponse({ error: "not found" }, 404);
  }

  return { fetchImpl, calls, stats, _optionsStore: optionsStore };
}
