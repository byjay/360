/**
 * OSC(Open Spherical Camera) API 목 서버 — 실제 카메라 없이 70_ThetaOSC.js 를 검증한다.
 * 공식 응답 형식(osc/info, osc/state, osc/commands/execute·status) 준수. 실 HTTP 소켓을 열지
 * 않고 fetch 호환 함수(fetchImpl)를 직접 주입한다(결정적·빠름 — 포트 바인딩 플레이키 회피).
 *
 * vendor: "theta" | "insta360" | "unknown" — /osc/info 의 manufacturer/model 분기.
 * previewFailFirst: getLivePreview 처음 N회 500 실패(재연결 테스트).
 * previewMidStreamDisconnectAfter: 프레임 N개 받은 뒤 스트림 1회 끊김(재연결 테스트).
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

  let takeState = null;
  let previewCallCount = 0;
  let disconnectedOnce = false;
  const calls = []; // 호출 로그(테스트 assertion 용)

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
        const id = "0001";
        const fileUrl = "http://192.168.1.1/files/100RICOH/R" + (1000000 + calls.length) + ".JPG";
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
      const bytes = new TextEncoder().encode("JPEGDATA-" + u.split("/").pop());
      return { ok: true, status: 200, headers: { get: () => "image/jpeg" }, blob: async () => new Blob([bytes], { type: "image/jpeg" }) };
    }
    return jsonResponse({ error: "not found" }, 404);
  }

  return { fetchImpl, calls, _optionsStore: optionsStore };
}
