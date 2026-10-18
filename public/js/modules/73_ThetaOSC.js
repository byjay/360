  /* ══════════════════════════════════════════════════════════════
     THETA OSC(Open Spherical Camera) 직접 제어 — "THETA 앱 대신 이 앱만으로"
     ────────────────────────────────────────────────────────────────
     발주: WORK_ORDER THETA-OSC(2026-10-19). 마스터 카메라: RICOH THETA SC(2016, API v2.1).
     🔴 [문서 한계] 이 세션은 web-fetch 도구가 없어 docs.theta360.com/osc 라이브 재확인을 하지 못했다.
       아래 상수·가정은 발주서가 제시한 "배경 사실"만 쓴다. SC 가 실제로 report 하는 필드명이
       다르면(예: getOptions 응답 키, /osc/state 배터리 필드) 이 코드는 "있는 것만" 쓰고 없으면
       null/빈 배열을 돌려준다 — 모델별 지원표를 하드코딩하지 않는다(§10-no-hardcoding).
       getLivePreview 지원여부·v2.1 지원 펌웨어·클라이언트모드 가능여부는 실기기 1회 확인 전까지
       [Uncertain] — .tmp/theta-sc-fieldtest.md 체크리스트로 넘긴다.
     · AP 모드: SSID="THETA"+시리얼+".OSC", 비밀번호=시리얼의 숫자부, IP 192.168.1.1(배경사실 SoT).
     · 브라우저(PWA)는 https→http 혼합콘텐츠로 호출 불가(android-app/capacitor.config.json
       cleartext:false, allowMixedContent:false 확인됨) → APK 네이티브 플러그인 필요.
       이 패스에서는 네이티브 WiFi 연결 플러그인을 새로 만들지 않았다(기존 의존성에 없고, 실기기
       없이 WifiNetworkSpecifier 코드를 검증 없이 배 넣는 것은 더 위험 — §G-4①). 대신 SSID/PW
       안내+복사 버튼(수동 연결)을 기본 경로로 둔다. connectWifi() 는 향후 네이티브 플러그인이
       Capacitor.Plugins.WifiConnect 로 등록되면 자동으로 그 경로를 탄다(폴백 구조 이미 분기).
     · OSC HTTP 호출 자체도 WebView cleartext 차단 대상이라, 실기기에서는 opts.fetchImpl 로
       네이티브 브리지(cap.nativePromise("OscHttp","request",…))를 주입해야 한다 — 그 네이티브
       플러그인도 이 패스에서는 미구현(동일 사유). 테스트는 opts.fetchImpl 에 mock 주입으로 진행.
     · 핀 연결은 재구현하지 않는다 — PhotoBatch._uploadOneRow/GPS.attachToPin/PhotoFolder.findMatches
       를 그대로 호출(§SoT, G-2-5). 오프라인 큐는 _uploadOneRow 내부 SyncQueue.enqueue 가 이미 처리.
     · 웹(PWA)에서는 숨김 — webDisabledReason() 참조(38_Install.isNativeApp SoT 재사용).
  ══════════════════════════════════════════════════════════════ */
  const ThetaOSC = {
    BASE_URL: "http://192.168.1.1",
    CAMERAS_KEY: "theta_osc_cameras_v1",
    SELECTED_KEY: "theta_osc_selected_v1",
    TRANSFER_KEY: "theta_osc_transferred_v1",
    RECONNECT: { max: 3, delayMs: 1200 },

    /* ══ 저장소(순수 I/O 래퍼) ══════════════════════════════════════ */
    _storage() { try { return (typeof localStorage !== "undefined") ? localStorage : null; } catch (e) { return null; } },
    _loadJSON(key, fallback) {
      try { const s = this._storage(); if (!s) return fallback; const v = s.getItem(key); return v ? JSON.parse(v) : fallback; }
      catch (e) { return fallback; }
    },
    _saveJSON(key, val) { try { const s = this._storage(); if (s) s.setItem(key, JSON.stringify(val)); } catch (e) {} },

    /* ══ 카메라 등록(복수 저장·선택) — 순수 ══════════════════════════ */
    /** SSID 파생(배경사실 SoT) — "THETA"+시리얼+".OSC". 순수. */
    ssidOf(serial) { const s = String(serial || "").trim(); return s ? "THETA" + s + ".OSC" : ""; },
    /** 비밀번호 파생 — 시리얼의 숫자부(앞 영문 접두 제거). 순수. 예: "YJ30142118"→"30142118". */
    passwordOf(serial) {
      const s = String(serial || "").trim();
      const m = /^([A-Za-z]*)(\d+)$/.exec(s);
      return m ? m[2] : s;
    },
    listCameras() { return this._loadJSON(this.CAMERAS_KEY, []); },
    registerCamera(serial, label) {
      const s = String(serial || "").trim();
      if (!s) return null;
      const list = this.listCameras();
      if (!list.some((c) => c.serial === s)) list.push({ serial: s, label: label || s, addedAt: Date.now() });
      this._saveJSON(this.CAMERAS_KEY, list);
      return s;
    },
    removeCamera(serial) { this._saveJSON(this.CAMERAS_KEY, this.listCameras().filter((c) => c.serial !== serial)); },
    selectCamera(serial) { this._saveJSON(this.SELECTED_KEY, serial); },
    selectedCamera() { return this._loadJSON(this.SELECTED_KEY, null); },

    /* ══ 웹(PWA) 숨김 게이트 — SoT: 38_Install.isNativeApp ══════════ */
    isAvailable() { try { return typeof Install !== "undefined" && Install.isNativeApp && !!Install.isNativeApp(); } catch (e) { return false; } },
    webDisabledReason() { return this.isAvailable() ? "" : "APK 에서 사용 가능 — 웹(브라우저)에서는 비활성"; },

    /** 이 페이지(WebView)에 실제 Capacitor 네이티브 브리지가 있는가 — SoT: 38c_ApkInstall._cap() 과
     *  같은 판정(cap.nativePromise 함수 존재 + Install.isNativeApp()). */
    _cap() {
      try {
        const cap = (typeof window !== "undefined") ? window.Capacitor : null;
        const isNative = (typeof Install !== "undefined" && Install.isNativeApp) ? Install.isNativeApp() : false;
        return (cap && typeof cap.nativePromise === "function" && isNative) ? cap : null;
      } catch (e) { return null; }
    },

    /* ══ WiFi 연결 — OscCameraPlugin(네이티브, android/.../OscCameraPlugin.java)이 있으면 그 경로,
       없거나 실패하면 SSID/PW 수동 안내(복사 버튼용) ══════════════════════════════════════════
       🔴 [마스터 현장 이슈] bindProcessToNetwork 로 앱 전체를 카메라망에 묶지 않는다 — 그러면 업로드까지
       끊긴다. OscCameraPlugin.connect() 는 ConnectivityManager.requestNetwork(WifiNetworkSpecifier)로
       "로컬 전용(인터넷 없음)" 네트워크만 따로 열어 보관하고, 이후 모든 카메라 요청은
       Network#openConnection(url) 로 그 네트워크에만 개별 바인딩한다(앱의 기본 네트워크/업로드는
       그대로 셀룰러·기존 와이파이). */
    async connectWifi(serial) {
      const ssid = this.ssidOf(serial), password = this.passwordOf(serial);
      const cap = this._cap();
      if (cap) {
        try { await cap.nativePromise("OscCamera", "connect", { ssid, password }); return { ok: true, mode: "native", ssid, password }; }
        catch (e) { return { ok: false, mode: "native", reason: (e && e.message) || String(e), ssid, password }; }
      }
      return { ok: false, mode: "manual", reason: "네이티브 카메라 플러그인 없음(Android10 미만 포함) — 휴대폰 와이파이 설정에서 수동 연결 필요", ssid, password };
    },
    async disconnectWifi() {
      const cap = this._cap();
      if (cap) { try { await cap.nativePromise("OscCamera", "disconnect", {}); } catch (e) {} }
    },

    async _sleep(ms) { return new Promise((res) => setTimeout(res, ms)); },

    /* ══ base64 ↔ 바이트(네이티브 브리지 전송용) — 순수 ══════════════════════════════ */
    _bytesToBase64(bytes) {
      let bin = "";
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return btoa(bin);
    },
    _base64ToBytes(b64) {
      if (!b64) return new Uint8Array(0);
      const bin = atob(b64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    },

    /** OscCameraPlugin.request() 를 fetch 와 같은 모양으로 감싼 어댑터 — 73_ThetaOSC.js 의 client()가
     *  fetchImpl 로 그대로 주입받는다(§재사용 — 네이티브 경로용 별도 클라이언트 구현 없음).
     *  🔴 스트리밍(getLivePreview) 은 이 어댑터로 안 된다 — request() 는 요청 1건이 끝나야 응답하는
     *  구조(네이티브 플러그인 호출 자체가 1회 Promise)라 끝나지 않는 MJPEG 스트림을 돌릴 수 없다.
     *  라이브뷰는 livePreviewFramesNative() 가 별도 네이티브 이벤트("previewFrame")로 받는다. */
    nativeFetchAdapter(cap) {
      const self = this;
      return async function nativeFetch(url, init) {
        init = init || {};
        const headers = {};
        if (init.headers) Object.keys(init.headers).forEach((k) => { headers[k] = init.headers[k]; });
        const bodyBase64 = (init.body != null) ? self._bytesToBase64(new TextEncoder().encode(init.body)) : undefined;
        let res;
        try {
          res = await cap.nativePromise("OscCamera", "request", { method: init.method || "GET", url: String(url), bodyBase64, headers });
        } catch (e) {
          return { ok: false, status: 0, headers: { get: () => null }, json: async () => ({}), blob: async () => new Blob([]) };
        }
        const status = res.status || 0;
        const bytes = self._base64ToBytes(res.bodyBase64);
        const contentType = res.contentType || "";
        return {
          ok: status >= 200 && status < 300,
          status,
          headers: { get: (k) => (String(k).toLowerCase() === "content-type" ? contentType : null) },
          json: async () => { try { return JSON.parse(new TextDecoder().decode(bytes)); } catch (e) { return {}; } },
          blob: async () => new Blob([bytes], { type: contentType || "application/octet-stream" }),
          body: null, // 버퍼링 응답(요청 1건 종료 후 전달) — 스트리밍 바디 없음, getLivePreviewStream 은 이 경로를 쓰지 않는다
        };
      };
    },

    /* ══ OSC HTTP 클라이언트(전송 주입 — 테스트는 mock fetchImpl, 실기기는 nativeFetchAdapter) ══ */
    client(opts) {
      opts = opts || {};
      const baseUrl = opts.baseUrl || this.BASE_URL;
      const fetchImpl = opts.fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
      if (!fetchImpl) throw new Error("HTTP 전송 없음(fetchImpl 필요)");
      const self = this;
      return {
        baseUrl, fetchImpl,
        async info() {
          const r = await fetchImpl(baseUrl + "/osc/info");
          if (!r.ok) throw new Error("osc/info " + r.status);
          return r.json();
        },
        async state() {
          const r = await fetchImpl(baseUrl + "/osc/state", { method: "POST" });
          if (!r.ok) throw new Error("osc/state " + r.status);
          return r.json();
        },
        async execute(name, parameters) {
          const r = await fetchImpl(baseUrl + "/osc/commands/execute", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, parameters: parameters || {} }),
          });
          const j = await r.json().catch(() => ({}));
          if (j && j.state === "error") throw new Error((j.error && j.error.message) || "카메라 오류");
          if (!r.ok && !(j && j.state)) throw new Error((j && j.error && j.error.message) || ("osc/commands/execute " + r.status));
          return j;
        },
        async status(id) {
          const r = await fetchImpl(baseUrl + "/osc/commands/status", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }),
          });
          return r.json();
        },
        /** execute 응답이 inProgress 면 status 를 폴링해 done/error 까지 기다린다. */
        async waitDone(execResp, pollMs, maxPolls) {
          let j = execResp, n = 0;
          pollMs = pollMs || 300; maxPolls = maxPolls || 40;
          while (j && j.state === "inProgress") {
            if (++n > maxPolls) throw new Error("타임아웃(촬영 상태 응답 없음)");
            await self._sleep(pollMs);
            j = await this.status(j.id);
          }
          if (j && j.state === "error") throw new Error((j.error && j.error.message) || "카메라 오류");
          return j;
        },
      };
    },

    /** /osc/info 원본에서 "있는 것만" 추출 — 모델별 지원표 하드코딩 금지. */
    capabilitiesFromInfo(info) {
      info = info || {};
      return {
        model: info.model || null,
        firmwareVersion: info.firmwareVersion || null,
        serialNumber: info.serialNumber || null,
        apiLevel: Array.isArray(info.apiLevel) ? info.apiLevel : [],
        supportsV21: Array.isArray(info.apiLevel) && info.apiLevel.indexOf(2) !== -1,
      };
    },
    /** /osc/state 원본에서 배터리·저장공간 "있는 것만" — 필드명 불확실 시 null(지어내지 않음). */
    statusFromState(state) {
      const st = (state && state.state) || {};
      return {
        batteryLevel: (typeof st._batteryLevel === "number") ? st._batteryLevel : null,
        storageUri: st.storageUri || null,
        raw: st,
      };
    },

    /* ══ 기종 어댑터(공통 OSC 계층 위 분기) ══════════════════════════════
       🔴 [에스컬레이션] Insta360(X5 등)은 이 세션에 WebFetch/WebSearch 도구가 없어
       onlinemanual.insta360.com/developer · insta360.com/developer/tutorial?type=osc
       를 직접 열어 엔드포인트·인증·지원 명령을 확인하지 못했다. 추측 금지 원칙(§10)에 따라
       Insta360 엔드포인트·파라미터를 지어내지 않는다 — detectAdapter 는 manufacturer 로
       "THETA 계열"과 "그 외(Insta360 포함)"만 가르고, 그 외는 공통 OSC 레이어(info/state/
       listFiles/setOptions/getOptions)만 시도 + liveview:false(사유 표시)로 제한한다.
       Insta360 전용 분기(인증 방식·지원 명령 목록)는 문서 확인이 가능한 사람이 보강해야 한다. */
    detectAdapter(info) {
      info = info || {};
      const mfr = String(info.manufacturer || "").toLowerCase();
      const model = String(info.model || "").toLowerCase();
      if (mfr.indexOf("ricoh") !== -1 || model.indexOf("theta") !== -1) {
        return { vendor: "theta", liveview: true, liveviewReason: "", exposureAdjustable: true, exposureReason: "", videoSupported: true, videoReason: "" };
      }
      if (mfr.indexOf("insta360") !== -1 || mfr.indexOf("arashi") !== -1 || model.indexOf("insta360") !== -1) {
        // [코디네이터 확인 2026-10-19, onlinemanual.insta360.com/developer/en-us/resource/integration]
        // OSC 는 와이파이 전용(블루투스 불가) · 라이브 피드 불가(별도 Media SDK, 승인 필요) · 사진은
        // 카메라 내부 스티칭 ON 필요 · 동영상은 내부 스티칭 불가(Media SDK 필요) · OSC 설정은 카메라
        // 화면 설정과 일치해야 하며 노출 파라미터는 조정 불가. 이 4가지는 "확인됨"(Uncertain 아님).
        // SSID·IP·엔드포인트는 그 문서에 없음 — /osc/info 로 판별, [Uncertain] 유지.
        return {
          vendor: "insta360",
          liveview: false, liveviewReason: "Insta360 OSC 는 라이브 피드 미지원(공식 문서 확인 — 별도 Media SDK·승인 필요)",
          exposureAdjustable: false, exposureReason: "Insta360 OSC 설정은 카메라 화면 설정과 일치해야 함(노출 파라미터 조정 불가, 공식 문서 확인)",
          videoSupported: false, videoReason: "동영상은 카메라 내부 스티칭이 불가(Media SDK 필요, 공식 문서 확인) — OSC 로는 사진만",
        };
      }
      return { vendor: "unknown", liveview: false, liveviewReason: "기종 미확인 — 공통 OSC 명령만 시도", exposureAdjustable: true, exposureReason: "", videoSupported: true, videoReason: "" };
    },

    /* ══ 촬영 ═══════════════════════════════════════════════════════ */
    async takePicture(cli) {
      const exec = await cli.execute("camera.takePicture", {});
      const done = await cli.waitDone(exec);
      const fileUrl = done && done.results && done.results.fileUrl;
      if (!fileUrl) throw new Error("fileUrl 없음(촬영 결과 이상)");
      return fileUrl;
    },
    async downloadFile(cli, fileUrl) {
      const r = await cli.fetchImpl(fileUrl);
      if (!r.ok) throw new Error("다운로드 실패 " + r.status);
      return r.blob();
    },

    /* ══ 옵션 — 지원하는 값만 노출(getOptions 응답 그대로, 하드코딩 금지) ══ */
    async supportedOptions(cli, names) {
      const resp = await cli.execute("camera.getOptions", { optionNames: names });
      const opts = (resp.results && resp.results.options) || {};
      return names.filter((n) => Object.prototype.hasOwnProperty.call(opts, n))
        .reduce((acc, n) => { acc[n] = opts[n]; return acc; }, {});
    },
    async setOptions(cli, options) { return cli.execute("camera.setOptions", { options }); },

    /* ══ 인터벌/동영상 — 지원 여부는 런타임 응답으로 판정(문서 추정 금지) ══ */
    async startCapture(cli, mode, params) {
      await this.setOptions(cli, Object.assign({ captureMode: mode === "video" ? "_video" : (mode === "interval" ? "interval" : "image") }, params || {}));
      return cli.execute("camera.startCapture", {});
    },
    async stopCapture(cli) { return cli.execute("camera.stopCapture", {}); },

    /* ══ 갤러리(카메라 속 사진) ═══════════════════════════════════════ */
    async listFiles(cli, opts) {
      const resp = await cli.execute("camera.listFiles", Object.assign({ fileType: "all", entryCount: 100, maxThumbSize: 0 }, opts || {}));
      return (resp.results && resp.results.entries) || [];
    },
    async deleteFiles(cli, fileUrls) { return cli.execute("camera.delete", { fileUrls }); },

    /* ══ 전송 이력(카메라별, "이미 전송한 파일" 표시) ═══════════════════ */
    transferredOf(serial) { return this._loadJSON(this.TRANSFER_KEY, {})[serial] || {}; },
    markTransferred(serial, fileUrl, pinId) {
      const all = this._loadJSON(this.TRANSFER_KEY, {});
      all[serial] = all[serial] || {};
      all[serial][fileUrl] = { downloadedAt: Date.now(), pinId: pinId != null ? pinId : null };
      this._saveJSON(this.TRANSFER_KEY, all);
    },
    isTransferred(serial, fileUrl) { return !!this.transferredOf(serial)[fileUrl]; },

    /* ══ 핀 연결 — 기존 경로 재사용(재구현 금지, §SoT) ══════════════════
       PhotoBatch._uploadOneRow 가 resizeImage/uploadImage/SyncQueue.enqueue 까지 전부 수행한다.
       navigator.onLine 이 참이어도 실제 업로드가 실패하면 그 안에서 SyncQueue.enqueue 로 자동
       폴백한다(카메라 와이파이 연결 중 "인터넷 없음" 상황을 코드 추가 없이 그대로 흡수). */
    async attachBlobToPin(pin, blob, filename, source) {
      if (typeof PhotoBatch === "undefined" || !PhotoBatch._uploadOneRow) throw new Error("PhotoBatch 미로드");
      const file = (typeof File !== "undefined" && blob instanceof File) ? blob : new File([blob], filename, { type: (blob && blob.type) || "image/jpeg" });
      const row = { file, name: filename, sortKey: Date.now(), timeSource: "THETA 촬영", is360: null };
      await new Promise((resolve) => {
        if (typeof App === "undefined" || !App._detect360) { resolve(); return; }
        App._detect360(file, (is360) => { row.is360 = is360; resolve(); });
      });
      const usedNames = (typeof PhotoBatch._usedPhotoNames === "function") ? PhotoBatch._usedPhotoNames() : new Set();
      return PhotoBatch._uploadOneRow(pin, row, false, usedNames, source || "THETA촬영");
    },
    /** 세션 촬영 1건 전체 흐름: 촬영→다운로드→(새 핀이면 GPS 부착)→핀 연결→전송이력 기록. */
    async captureToPin(cli, serial, pin, source) {
      const fileUrl = await this.takePicture(cli);
      const blob = await this.downloadFile(cli, fileUrl);
      const filename = String(fileUrl).split("/").pop() || ("theta_" + Date.now() + ".jpg");
      try { if (typeof GPS !== "undefined" && GPS.attachToPin) GPS.attachToPin(pin); } catch (e) {}
      const r = await this.attachBlobToPin(pin, blob, filename, source);
      if (r && r.status === "done") this.markTransferred(serial, fileUrl, pin && pin.id);
      return Object.assign({ fileUrl }, r);
    },

    /* ══ 카메라 갤러리 번호매칭(60_PhotoFolder 순수 매칭 재사용, 재구현 금지) ══ */
    matchEntriesToPins(pins, entries, existingNumbers) {
      if (typeof PhotoFolder === "undefined") return [];
      const out = [];
      (pins || []).forEach((pin) => {
        const m = PhotoFolder.findMatches(pin.no, entries, existingNumbers);
        if (m.length) out.push({ pin, entry: m[0] });
      });
      return out;
    },

    /* ══ 라이브 미리보기(MJPEG multipart) — 실제 바이트 파싱 + 끊김 재연결 ══ */
    /** 바이트 배열에서 needle 위치(없으면 -1). 순수. */
    _bytesIndexOf(hay, needle, from) {
      from = from || 0;
      outer: for (let i = from; i <= hay.length - needle.length; i++) {
        for (let j = 0; j < needle.length; j++) { if (hay[i + j] !== needle[j]) continue outer; }
        return i;
      }
      return -1;
    },
    _strToBytes(s) { return new TextEncoder().encode(s); },
    _concatBytes(a, b) { const out = new Uint8Array(a.length + b.length); out.set(a, 0); out.set(b, a.length); return out; },
    async *_iterateBody(body) {
      if (body && typeof body[Symbol.asyncIterator] === "function") { yield* body; return; }
      if (body && typeof body.getReader === "function") {
        const reader = body.getReader();
        for (;;) { const { done, value } = await reader.read(); if (done) return; if (value) yield value; }
        return;
      }
      throw new Error("body 를 읽을 수 없음");
    },
    /** multipart/x-mixed-replace 스트림 → JPEG 프레임(Uint8Array) 순차 산출. 순수(입력 스트림만 의존). */
    async *_mjpegFrames(body, boundary) {
      const marker = this._strToBytes("--" + boundary);
      const CRLFCRLF = this._strToBytes("\r\n\r\n");
      let buf = new Uint8Array(0);
      for await (const chunk of this._iterateBody(body)) {
        buf = this._concatBytes(buf, chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
        for (;;) {
          const mi = this._bytesIndexOf(buf, marker, 0);
          if (mi < 0) break;
          const headerStart = mi + marker.length;
          const hdrEnd = this._bytesIndexOf(buf, CRLFCRLF, headerStart);
          if (hdrEnd < 0) break; // 헤더가 아직 덜 옴 — 다음 청크 대기
          const headerText = new TextDecoder().decode(buf.slice(headerStart, hdrEnd));
          const clMatch = /Content-Length:\s*(\d+)/i.exec(headerText);
          const len = clMatch ? parseInt(clMatch[1], 10) : null;
          const bodyStart = hdrEnd + CRLFCRLF.length;
          if (len == null) {
            const next = this._bytesIndexOf(buf, marker, bodyStart);
            if (next < 0) break;
            yield buf.slice(bodyStart, next);
            buf = buf.slice(next);
            continue;
          }
          if (buf.length < bodyStart + len) break; // 프레임 바디가 아직 덜 옴
          yield buf.slice(bodyStart, bodyStart + len);
          buf = buf.slice(bodyStart + len);
        }
      }
    },
    /** getLivePreview 호출 — multipart 응답이 아니면(=미지원) 예외("라이브뷰 미지원"). */
    async getLivePreviewStream(cli) {
      const r = await cli.fetchImpl(cli.baseUrl + "/osc/commands/execute", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "camera.getLivePreview", parameters: {} }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => null);
        throw new Error((j && j.error && j.error.message) || ("getLivePreview " + r.status));
      }
      const ct = (r.headers && r.headers.get && r.headers.get("content-type")) || "";
      const m = /boundary=([^;]+)/i.exec(ct);
      const boundary = m ? m[1].trim().replace(/^"|"$/g, "") : null;
      if (!boundary || !r.body) throw new Error("라이브뷰 미지원(멀티파트 아님)");
      return { body: r.body, boundary };
    },
    /** [코디네이터 지시] getLivePreview 는 정지 명령이 없고, 촬영/모드변경으로 끊긴다 — 끊기면
     *  재호출(최대 RECONNECT.max 회)로 복구. 프레임을 1장이라도 받으면 재시도 카운터를 리셋한다. */
    async *livePreviewFrames(cli, opts) {
      opts = opts || {};
      const maxRetries = opts.maxRetries != null ? opts.maxRetries : this.RECONNECT.max;
      let attempt = 0;
      for (;;) {
        let stream;
        try { stream = await this.getLivePreviewStream(cli); }
        catch (e) { attempt++; if (attempt > maxRetries) throw e; await this._sleep(this.RECONNECT.delayMs); continue; }
        try {
          for await (const frame of this._mjpegFrames(stream.body, stream.boundary)) { attempt = 0; yield frame; }
          return; // 카메라가 정상적으로 스트림을 닫음(예: 촬영 시작) — 호출부가 필요시 재호출
        } catch (e) {
          attempt++;
          if (attempt > maxRetries) throw e;
          await this._sleep(this.RECONNECT.delayMs);
          continue;
        }
      }
    },

    /** 실기기 네이티브 경로 — OscCameraPlugin 이 자체 소켓으로 멀티파트를 파싱해 "previewFrame"
     *  이벤트로 프레임(바이트)을 push 한다(브리지가 끝나지 않는 스트림을 전달할 수 없어서, request()
     *  의 1회 Promise 대신 이벤트로 받는다). cap: window.Capacitor(_cap() 로 얻은 것). */
    async *livePreviewFramesNative(cap, opts) {
      opts = opts || {};
      const maxRetries = opts.maxRetries != null ? opts.maxRetries : this.RECONNECT.max;
      const baseUrl = opts.baseUrl || this.BASE_URL;
      const self = this;
      let queue = [], waiters = [];
      const push = (item) => { if (waiters.length) waiters.shift()(item); else queue.push(item); };
      const next = () => new Promise((resolve) => { if (queue.length) resolve(queue.shift()); else waiters.push(resolve); });
      cap.nativeCallback("OscCamera", "addListener", { eventName: "previewFrame" }, (data) => push({ type: "frame", bytes: self._base64ToBytes(data && data.dataBase64) }));
      cap.nativeCallback("OscCamera", "addListener", { eventName: "previewError" }, (data) => push({ type: "error", message: (data && data.message) || "스트림 오류" }));
      let attempt = 0;
      try {
        for (;;) {
          try { await cap.nativePromise("OscCamera", "startPreview", { url: baseUrl + "/osc/commands/execute" }); }
          catch (e) { attempt++; if (attempt > maxRetries) throw e; await this._sleep(this.RECONNECT.delayMs); continue; }
          let reconnect = false;
          while (!reconnect) {
            const item = await next();
            if (item.type === "frame") { attempt = 0; yield item.bytes; continue; }
            attempt++;
            if (attempt > maxRetries) throw new Error(item.message);
            await this._sleep(this.RECONNECT.delayMs);
            reconnect = true;
          }
        }
      } finally {
        try { await cap.nativePromise("OscCamera", "stopPreview", {}); } catch (e) {}
      }
    },

    /* ══ 리틀 플래닛 썸네일(equirect → 스테레오그래픽 근사) — 순수, canvas 없이도 테스트 가능 ══ */
    /** srcData: Uint8ClampedArray RGBA(equirect, srcW×srcH). 반환: {data,size} RGBA(outSize×outSize). */
    littlePlanetTransform(srcData, srcW, srcH, outSize) {
      const out = new Uint8ClampedArray(outSize * outSize * 4);
      const cx = outSize / 2, cy = outSize / 2, maxR = outSize / 2;
      for (let y = 0; y < outSize; y++) {
        for (let x = 0; x < outSize; x++) {
          const dx = x - cx, dy = y - cy;
          const r = Math.sqrt(dx * dx + dy * dy);
          const oi = (y * outSize + x) * 4;
          if (r > maxR) { out[oi + 3] = 0; continue; }
          const theta = Math.atan2(dy, dx);
          const lonNorm = ((theta + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2);
          const v = r / maxR; // 0(중심=천정)→1(가장자리=지평선 아래)
          const sx = Math.min(srcW - 1, Math.floor(lonNorm * srcW));
          const sy = Math.min(srcH - 1, Math.floor(v * srcH));
          const si = (sy * srcW + sx) * 4;
          out[oi] = srcData[si]; out[oi + 1] = srcData[si + 1]; out[oi + 2] = srcData[si + 2]; out[oi + 3] = 255;
        }
      }
      return { data: out, size: outSize };
    },
    /** DOM 환경에서 canvas 로 썸네일 생성 + 캐시(data URL, localStorage). 비순수(캔버스 의존). */
    littlePlanetThumbCached(cacheKey, equirectImage, outSize) {
      outSize = outSize || 96;
      const ckey = "theta_lp_thumb_" + cacheKey;
      const cached = this._loadJSON(ckey, null);
      if (cached) return cached;
      try {
        const sc = document.createElement("canvas");
        sc.width = equirectImage.naturalWidth || equirectImage.width;
        sc.height = equirectImage.naturalHeight || equirectImage.height;
        const sctx = sc.getContext("2d");
        sctx.drawImage(equirectImage, 0, 0, sc.width, sc.height);
        const srcData = sctx.getImageData(0, 0, sc.width, sc.height).data;
        const { data } = this.littlePlanetTransform(srcData, sc.width, sc.height, outSize);
        const oc = document.createElement("canvas");
        oc.width = outSize; oc.height = outSize;
        oc.getContext("2d").putImageData(new ImageData(data, outSize, outSize), 0, 0);
        const url = oc.toDataURL("image/jpeg", 0.7);
        this._saveJSON(ckey, url);
        return url;
      } catch (e) { return null; }
    },

    /* ══ 갤러리 화면 — 날짜 그룹 / 필터 / 배지 (순수) ═══════════════════ */
    _dateKeyOf(e) {
      const ts = (e && (e.ts || e.dateTimeZone || e.dateTime)) || null;
      if (!ts) return "날짜 없음";
      const p = (n) => String(n).padStart(2, "0");
      if (typeof ts === "number") {
        const d = new Date(ts);
        return isNaN(d.getTime()) ? "날짜 없음" : (d.getFullYear() + "/" + p(d.getMonth() + 1) + "/" + p(d.getDate()));
      }
      // OSC camera.listFiles dateTimeZone/dateTime 은 EXIF 식("YYYY:MM:DD HH:MM:SS±HH:MM") — Date() 가 못 읽는다.
      const m = /^(\d{4})[:\-](\d{2})[:\-](\d{2})/.exec(String(ts));
      if (m) return m[1] + "/" + m[2] + "/" + m[3];
      const d = new Date(String(ts).replace(/\+\d{2}:\d{2}$/, ""));
      return isNaN(d.getTime()) ? "날짜 없음" : (d.getFullYear() + "/" + p(d.getMonth() + 1) + "/" + p(d.getDate()));
    },
    /** 날짜별 그룹 — [{date, items}], 최신 날짜 먼저. 순수. */
    groupByDate(entries) {
      const groups = {};
      (entries || []).forEach((e) => { const k = this._dateKeyOf(e); (groups[k] = groups[k] || []).push(e); });
      return Object.keys(groups).sort().reverse().map((k) => ({ date: k, items: groups[k] }));
    },
    /** filter: {date, registered(true/false/undefined), zone}. 순수. */
    filterEntries(entries, filter) {
      filter = filter || {};
      return (entries || []).filter((e) => {
        if (filter.date && this._dateKeyOf(e) !== filter.date) return false;
        if (filter.registered === true && !e.registered) return false;
        if (filter.registered === false && e.registered) return false;
        if (filter.zone && e.zone !== filter.zone) return false;
        return true;
      });
    },
    /** 썸네일 배지 — "핀 N" 또는 "미등록". 순수. */
    badgeFor(entry) { return (entry && entry.registered && entry.pinNo != null) ? ("핀 " + entry.pinNo) : "미등록"; },

    /* ══ 셔터 FAB 세션 — "다음 핀 촬영" ══════════════════════════════ */
    nextSessionPin(session) { return (session && session.pins && session.pins[session.index || 0]) || null; },
    advanceSession(session) { if (session) session.index = (session.index || 0) + 1; return session; },

    /* ══ 다중선택 → 핀에 연결(갤러리 import) ═══════════════════════════
       선택 entries 를 매칭된 핀에 다운로드→연결. 매칭 안 되면 skip 으로 보고. */
    async connectSelectedEntries(cli, serial, matches, source) {
      const results = [];
      for (const { pin, entry } of matches) {
        try {
          const r = await cli.fetchImpl(entry.fileUrl || entry.url);
          if (!r.ok) { results.push({ pin, entry, status: "fail", reason: "다운로드 실패 " + r.status }); continue; }
          const blob = await r.blob();
          const rr = await this.attachBlobToPin(pin, blob, entry.name, source || "THETA갤러리");
          if (rr && rr.status === "done") this.markTransferred(serial, entry.fileUrl || entry.url, pin && pin.id);
          results.push(Object.assign({ pin, entry }, rr));
        } catch (e) { results.push({ pin, entry, status: "fail", reason: (e && e.message) || String(e) }); }
      }
      return results;
    },

    init() { /* DOM 마운트는 추후 메뉴 통합 시 open() 호출로 — 이 패스는 로직 완성에 집중(보고 참조) */ },
  };
