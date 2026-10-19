  /* ══════════════════════════════════════════════════════════════
     PERSON BLUR — 360 사진 인물 자동감지 + 흐리기 (지휘자 발주 2026-10-15)
     마스터 선택: "① 자동 감지 + 흐림 먼저". 비용 제약: 무료(유료 API 금지) — 브라우저 내
     TensorFlow.js + COCO-SSD(lite_mobilenet_v2, jsdelivr CDN 고정 버전, 지연 로드)만 쓴다.
     ────────────────────────────────────────────────────────────────
     🔴 디자이너 전용 — 열람자 버튼 0(canEdit 가드, buttonState SoT). AiVision(49_AiVision.js)과
        같은 host-mount 패턴(mount/unmount/render)을 그대로 따른다(새 UI 패턴 발명 금지).
     🔴 새 CSS 규칙 0 — 인라인 스타일 + 리터럴 hex. 49_AiVision.js 가 이미 문서화한 대비 팔레트
        재사용(light #0f172a/#fff 17.9:1 · dark #f1f5f9/#0a1020 17:1 · 버튼 #fff/#1d4ed8 6.3:1).
     equirect 360 은 좌우가 이어진다(seam) — 감지는 가로 N조각(겹침 포함)으로 나눠 합치고,
     박스가 이은선을 넘으면 블러도 양끝에서 랩 처리한다(sliceRanges/mapBoxToFull/normalizeX/
     mergeBoxes/applyBoxBlur 전부 순수 함수로 분리 — tests/p157 단위검증 대상).
     🔴 [지휘자 실측 2026-10-19 R2] 기본 base=mobilenet_v2(lite 아님)·수평 띠 y 28~78%만 1차 감지·
     10조각·겹침25%·점수 하한 0.6(실 사진 7장: 정답1/1, 오탐0/7 — lite+전체높이+5조각일 때는
     정답을 놓치고 오탐 3건). "전체 높이로 다시 찾기" 로 위아래까지 확장 재검색 가능.
     점수 0.4~0.6 은 자동 미적용 — "확인 필요"(점선) 로 보여주고 탭하면 박스로 포함(review 버킷).
     저사양 기기(Device Memory API ≤2GB 또는 hardwareConcurrency ≤2 또는 WebGL MAX_TEXTURE_SIZE
     <4096 — 실제 WebGL 벤치마크는 비용이 커 생략, 휴리스틱임을 명시)는 lite_mobilenet_v2 로 폴백
     (모델 다운로드량 실측: lite 20.0MB/8req vs full 66.0MB/20req — 약 3.3배, 저사양에서 로드 지연
     가치가 큼). 모델 선택은 1회 계산 후 _modelBase 에 캐시.
     원본 보존 — 처리(블러)본을 pin.imageId(기본 표시)로 올리고, 블러 "이전" 원본은
        App._uploadToR2 로 R2 에 올려 pin.blurOrigUrl/blurOrigKind 에 보관한다(기존 pin.origKey
        관례와 같은 id/url 보관 스타일 — 단, origKey는 "고해상도 원본 보관"이라는 다른 의미로
        이미 쓰이고 있어 필드를 분리했다[SoT 혼동 방지]). canReadR2Key 는 키 문자열이 배포본
        pins 컬럼에 존재하면(필드 무관 substring 매칭) 그 배포본을 읽을 수 있는 사람 전원에게
        허용한다 — 기존 origKey 도 동일한 노출 범위이므로 새로운 보안 격차는 아니다. 완전한
        "디자이너만 원본 열람" 격리는 별도 테이블+전용 엔드포인트가 필요(미구현, 범위 밖 — 보고).
     🔴 반드시 `_manifest.txt` 에 등록해야 번들(main.js)에 포함된다.
  ══════════════════════════════════════════════════════════════ */
  const PersonBlur = {
    TF_SCRIPT: "https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.11.0/dist/tf.min.js",
    COCO_SCRIPT: "https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js",
    SLICE_COUNT: 10,
    SLICE_OVERLAP_FRAC: 0.25,     // 조각 하나 폭의 25%를 좌우로 더 겹쳐 자른다(R2 실측)
    CONF_DEFAULT: 0.6,            // 자동 적용 하한(R2 실측 — 이 이상만 바로 박스로 확정)
    CONF_REVIEW: 0.4,             // "확인 필요"(점선) 하한 — 이 미만은 버린다
    BAND_Y0_FRAC: 0.28,           // 1차 감지는 수평 띠만(상/하단 천장·바닥 오탐 배제) — R2 실측
    BAND_Y1_FRAC: 0.78,
    MAX_DETECT_WIDTH: 3200,       // 감지용 다운스케일 상한(메모리 안전) — 블러는 원해상도에 적용
    _inited: false,
    _hosts: {},
    _busy: false,
    _modelPromise: null,
    _modelBase: null,             // "mobilenet_v2" | "lite_mobilenet_v2" — _detectBase() 로 1회 계산
    _detectorOverride: null,      // 테스트 주입 — setDetector(fn) 로 교체
    _editors: {},                 // pinId → 에디터 상태(boxes, canvas 등)

    init() {
      if (this._inited || typeof window === "undefined" || !window.addEventListener) return;
      this._inited = true;
      window.addEventListener("online", () => this._refreshHosts());
      window.addEventListener("offline", () => this._refreshHosts());
    },

    /* ─── 공통 유틸(49_AiVision.js 관례 그대로) ─── */
    _esc(s) { return (typeof UI !== "undefined" && UI.escapeHtml) ? UI.escapeHtml(String(s == null ? "" : s)) : String(s == null ? "" : s); },
    _toast(m, ms) { try { if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast(m, ms || 3200); } catch (e) {} },
    _online() { return (typeof navigator === "undefined") ? true : navigator.onLine !== false; },
    canEdit() {
      const A = (typeof Auth !== "undefined") ? Auth : null;
      return !!(A && A.isDesigner && !A.readonly) && (typeof State === "undefined" || State.mode === "designer");
    },
    hasPhoto(pin) {
      if (!pin) return false;
      if (pin.imageId) return true;
      return typeof pin.imageUrl === "string" && /^\/api\/r2\/object\//.test(pin.imageUrl);
    },
    /** 🔴 버튼 상태 SoT(순수) — 권한 → 온라인 → 사진 순. "" = 사용 가능. */
    buttonState(a) {
      a = a || {};
      if (!a.canEdit) return { disabled: true, reason: "디자이너(편집) 전용 — 열람 화면에서는 사용할 수 없습니다" };
      if (!a.online) return { disabled: true, reason: "온라인에서 사용 — 오프라인에서는 사람 흐리기를 사용할 수 없습니다" };
      if (!a.pin || !this.hasPhoto(a.pin)) return { disabled: true, reason: "사진이 없습니다 — 먼저 360 사진을 등록하세요" };
      return { disabled: false, reason: "" };
    },

    /* ════════ 순수 함수 — 조각 분할 / 좌표 합치기 / 랩 처리(tests/p157) ════════ */
    /** 0..width 를 n 조각으로, 각 조각을 overlapFrac(조각폭 비율)만큼 좌우로 더 겹쳐 자른다.
     *  x0/x0+w 는 [0,width) 밖(음수·width 초과)일 수 있다 — 추출 시 normalizeX 로 랩. */
    sliceRanges(width, n, overlapFrac) {
      const W = Math.max(1, Math.round(width));
      const N = Math.max(1, Math.round(n));
      const step = W / N;
      const overlap = Math.round(step * (typeof overlapFrac === "number" ? overlapFrac : this.SLICE_OVERLAP_FRAC));
      const out = [];
      for (let i = 0; i < N; i++) {
        const x0 = Math.round(i * step - overlap);
        const w = Math.round(step + overlap * 2);
        out.push({ x0, w, i });
      }
      return out;
    },
    /** 임의 정수를 [0,width) 로 랩(360 좌우 이음선). width<=0 이면 그대로. */
    normalizeX(x, width) {
      const W = Math.round(width);
      if (!W || W <= 0) return x;
      let v = Math.round(x) % W;
      if (v < 0) v += W;
      return v;
    },
    /** 조각-로컬 박스(bbox:[x,y,w,h], 조각 내부 픽셀) → 전체 이미지 좌표(x 는 [0,width) 로 랩됨).
     *  yOffset — 수평 띠(band)만 잘라 감지했을 때 띠의 상단 y(bandY0)를 더해 전체 y로 되돌린다. */
    mapBoxToFull(bbox, slice, width, yOffset) {
      const fx = slice.x0 + bbox[0];
      return { x: this.normalizeX(fx, width), y: Math.round(bbox[1] + (yOffset || 0)), width: Math.round(bbox[2]), height: Math.round(bbox[3]) };
    },
    /** 두 박스의 IoU — shiftB(보통 0/+width/-width) 만큼 b.x 를 옮겨 비교(이음선 건너 중복 판정용). */
    _iou(a, b, shiftB) {
      const bx = b.x + (shiftB || 0);
      const ax1 = a.x, ay1 = a.y, ax2 = a.x + a.width, ay2 = a.y + a.height;
      const bx1 = bx, by1 = b.y, bx2 = bx + b.width, by2 = b.y + b.height;
      const ix1 = Math.max(ax1, bx1), iy1 = Math.max(ay1, by1);
      const ix2 = Math.min(ax2, bx2), iy2 = Math.min(ay2, by2);
      const iw = Math.max(0, ix2 - ix1), ih = Math.max(0, iy2 - iy1);
      const inter = iw * ih;
      if (inter <= 0) return 0;
      const union = a.width * a.height + b.width * b.height - inter;
      return union > 0 ? inter / union : 0;
    },
    /** 겹치는 조각 경계에서 같은 사람이 중복 감지된 박스를 하나로 합친다(이음선 랩 고려).
     *  🔴 width<=0(랩 비활성 취급) 이면 shift 시도를 0 하나로만 — 랩 병합 기능이 꺼진 셈이라
     *  뮤테이션 증명(이 분기를 지우면) 시 이음선 경계 사례가 병합되지 않아 테스트가 EXIT=1. */
    mergeBoxes(boxes, width, iouThresh) {
      const thr = typeof iouThresh === "number" ? iouThresh : 0.25;
      const W = Math.round(width) || 0;
      const shifts = W > 0 ? [0, W, -W] : [0];
      const items = (boxes || []).map((b) => Object.assign({}, b));
      const merged = [];
      const used = new Array(items.length).fill(false);
      for (let i = 0; i < items.length; i++) {
        if (used[i]) continue;
        let cur = items[i];
        used[i] = true;
        let changed = true;
        while (changed) {
          changed = false;
          for (let j = 0; j < items.length; j++) {
            if (used[j]) continue;
            let best = 0, bestShift = 0;
            for (const s of shifts) { const v = this._iou(cur, items[j], s); if (v > best) { best = v; bestShift = s; } }
            if (best >= thr) {
              const bx = items[j].x + bestShift;
              const x1 = Math.min(cur.x, bx), x2 = Math.max(cur.x + cur.width, bx + items[j].width);
              const y1 = Math.min(cur.y, items[j].y), y2 = Math.max(cur.y + cur.height, items[j].y + items[j].height);
              cur = { x: W > 0 ? this.normalizeX(x1, W) : x1, y: y1, width: x2 - x1, height: y2 - y1, score: Math.max(cur.score || 0, items[j].score || 0) };
              used[j] = true;
              changed = true;
            }
          }
        }
        merged.push(cur);
      }
      return merged;
    },

    /* ════════ 감지(실 캔버스 필요) ════════ */
    setDetector(fn) { this._detectorOverride = fn; },   // 테스트 주입: async (sliceCanvasLike) -> [{class,score,bbox:[x,y,w,h]}]
    /** 저사양 기기 판정(휴리스틱) — Device Memory API(Chrome/Edge/Android 한정, 다른 브라우저는
     *  undefined)·hardwareConcurrency·WebGL MAX_TEXTURE_SIZE 3종. 실 WebGL 렌더 벤치마크는 비용이
     *  커(수백ms~수초) 세션마다 돌리지 않고, 정적 파라미터 조회만 쓴다 — 정밀하진 않지만 0ms. */
    _shouldUseLite() {
      try {
        if (typeof navigator !== "undefined") {
          const mem = navigator.deviceMemory;
          if (typeof mem === "number" && mem > 0 && mem <= 2) return true;
          const cores = navigator.hardwareConcurrency;
          if (typeof cores === "number" && cores > 0 && cores <= 2) return true;
        }
        if (typeof document !== "undefined") {
          const c = document.createElement("canvas");
          const gl = c.getContext && (c.getContext("webgl") || c.getContext("experimental-webgl"));
          if (!gl) return true;   // WebGL 자체가 없으면 저사양으로 간주
          const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
          if (typeof maxTex === "number" && maxTex > 0 && maxTex < 4096) return true;
        }
      } catch (e) { /* 판정 실패 시 기본(full) 유지 — 보수적 */ }
      return false;
    },
    _detectBase() { return this._shouldUseLite() ? "lite_mobilenet_v2" : "mobilenet_v2"; },
    async _loadScript(src) {
      if (typeof document === "undefined") throw new Error("no-dom");
      return new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = src; s.async = true;
        s.onload = () => resolve(true);
        s.onerror = () => reject(new Error("모델 스크립트 로드 실패: " + src));
        document.head.appendChild(s);
      });
    },
    /** TF.js + COCO-SSD 지연 로드(1회) — 실제 모델 가중치는 CDN 첫 사용 시점에만 받는다(무료). */
    async _ensureModel() {
      if (this._detectorOverride) return true;   // 테스트 — 네트워크 0
      if (this._modelPromise) return this._modelPromise;
      this._modelPromise = (async () => {
        if (typeof window === "undefined") throw new Error("no-window");
        if (!window.tf) await this._loadScript(this.TF_SCRIPT);
        if (!window.cocoSsd) await this._loadScript(this.COCO_SCRIPT);
        if (!this._modelBase) this._modelBase = this._detectBase();
        if (!this._model) this._model = await window.cocoSsd.load({ base: this._modelBase });
        return true;
      })();
      return this._modelPromise;
    },
    async _runDetector(sliceCanvas) {
      if (this._detectorOverride) return this._detectorOverride(sliceCanvas);
      await this._ensureModel();
      const preds = await this._model.detect(sliceCanvas);
      return (preds || []).map((p) => ({ class: p.class, score: p.score, bbox: p.bbox }));
    },
    /** canvas(또는 동치 getContext 지원 캔버스) 에서 사람 박스를 N조각으로 나눠 감지 후 합친다.
     *  기본은 수평 띠(BAND_Y0_FRAC~BAND_Y1_FRAC)만 자르고, opts.fullHeight:true 면 전체 높이.
     *  반환: { auto:[...], review:[...] } — score>=confidence 는 auto, [reviewConfidence,confidence)
     *  구간은 review("확인 필요", 자동 미적용). confidence 미만(reviewConfidence 포함 안 함)은 버린다. */
    async detectPersons(canvas, opts) {
      const o = opts || {};
      const confAuto = typeof o.confidence === "number" ? o.confidence : this.CONF_DEFAULT;
      const confReview = typeof o.reviewConfidence === "number" ? o.reviewConfidence : this.CONF_REVIEW;
      const n = o.sliceCount || this.SLICE_COUNT;
      const overlapFrac = typeof o.overlapFrac === "number" ? o.overlapFrac : this.SLICE_OVERLAP_FRAC;
      const width = canvas.width, height = canvas.height;
      const useBand = !o.fullHeight;
      const bandY0 = useBand ? Math.round(height * (typeof o.bandY0Frac === "number" ? o.bandY0Frac : this.BAND_Y0_FRAC)) : 0;
      const bandY1 = useBand ? Math.round(height * (typeof o.bandY1Frac === "number" ? o.bandY1Frac : this.BAND_Y1_FRAC)) : height;
      const bandH = Math.max(1, bandY1 - bandY0);
      const slices = this.sliceRanges(width, n, overlapFrac);
      let all = [];
      for (const slice of slices) {
        const sc = (typeof document !== "undefined") ? document.createElement("canvas") : null;
        if (!sc) continue;
        sc.width = slice.w; sc.height = bandH;
        const sctx = sc.getContext("2d");
        // 이음선 랩 — 조각이 [0,width) 밖으로 나가면 모자란 구간을 반대쪽에서 채운다
        for (let col = 0; col < slice.w; ) {
          const srcX = this.normalizeX(slice.x0 + col, width);
          const run = Math.min(slice.w - col, width - srcX);
          sctx.drawImage(canvas, srcX, bandY0, run, bandH, col, 0, run, bandH);
          col += run;
        }
        const preds = await this._runDetector(sc);
        preds.filter((p) => p.class === "person" && p.score >= confReview)
          .forEach((p) => all.push(Object.assign(this.mapBoxToFull(p.bbox, slice, width, bandY0), { score: p.score })));
      }
      const merged = this.mergeBoxes(all, width, o.iouThresh);
      return {
        auto: merged.filter((b) => b.score >= confAuto),
        review: merged.filter((b) => b.score < confAuto && b.score >= confReview)
      };
    },

    /* ════════ 블러 적용(랩 포함) ════════ */
    /** box 영역을 강한 모자이크(다운샘플→업샘플, nearest)로 처리 — canvas filter 미지원 환경도 결정적으로 동작.
     *  box.x+box.width > fullWidth 면 이음선을 넘은 것 → 두 번(오른쪽 조각 + 랩된 왼쪽 조각)으로 나눠 그린다. */
    applyBoxBlur(ctx, box, fullWidth, fullHeight, opts) {
      const cell = (opts && opts.cell) || 14;
      const draw1 = (x, w) => {
        if (w <= 0) return;
        const y = Math.max(0, Math.round(box.y)), h = Math.min(Math.round(box.height), fullHeight - y);
        if (h <= 0) return;
        const small = (typeof document !== "undefined") ? document.createElement("canvas") : null;
        if (!small) return;
        const sw = Math.max(1, Math.round(w / cell)), sh = Math.max(1, Math.round(h / cell));
        small.width = sw; small.height = sh;
        const sctx = small.getContext("2d");
        sctx.imageSmoothingEnabled = true;
        sctx.drawImage(ctx.canvas, x, y, w, h, 0, 0, sw, sh);
        ctx.save();
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(small, 0, 0, sw, sh, x, y, w, h);
        ctx.restore();
      };
      const x = Math.round(box.x), w = Math.round(box.width);
      if (x + w <= fullWidth) { draw1(x, w); return; }
      // 이음선 랩 — 오른쪽 남은 폭 + 왼쪽(0부터) 넘친 폭
      const rightW = fullWidth - x;
      draw1(x, rightW);
      draw1(0, w - rightW);
    },
    /** boxes 전부를 캔버스에 적용(원본은 바꾸지 않도록 호출부가 복제 캔버스를 넘긴다). */
    applyBlur(canvas, boxes, opts) {
      const ctx = canvas.getContext("2d");
      (boxes || []).forEach((b) => this.applyBoxBlur(ctx, b, canvas.width, canvas.height, opts));
      return canvas;
    },

    /* ════════ 디코딩(대형 이미지 메모리 안전) ════════ */
    /** URL/dataURL → 캔버스. targetMax 이상이면 비율 유지 다운스케일(createImageBitmap resizeWidth) —
     *  5376×2688 급도 메모리 폭증 없이 처리(04_Cloud.js _decode 관례와 동일 원칙). */
    async _toCanvas(src, targetMax) {
      let bmp;
      if (typeof createImageBitmap === "function" && typeof fetch === "function" && /^(data:|blob:|https?:)/.test(src)) {
        const blob = /^data:/.test(src) ? await (await fetch(src)).blob() : await (await fetch(src)).blob();
        const opts = targetMax ? { resizeWidth: targetMax, resizeQuality: "high" } : {};
        bmp = await createImageBitmap(blob, opts);
      } else {
        bmp = await new Promise((res, rej) => { const img = new Image(); img.onload = () => res(img); img.onerror = rej; img.src = src; });
      }
      const w = bmp.width || bmp.naturalWidth, h = bmp.height || bmp.naturalHeight;
      const cv = document.createElement("canvas");
      cv.width = w; cv.height = h;
      cv.getContext("2d").drawImage(bmp, 0, 0, w, h);
      if (bmp.close) try { bmp.close(); } catch (e) {}
      return cv;
    },

    /* ════════ mount/unmount(49_AiVision.js 관례) ════════ */
    mount(hostId, pin, opts) {
      this._hosts[hostId] = { pin, opts: opts || {} };
      this.render(hostId);
    },
    unmount(hostId) { delete this._hosts[hostId]; },
    _refreshHosts() { Object.keys(this._hosts).forEach((id) => this.render(id)); },
    _theme(t) {
      return t === "dark"
        ? { text: "#f1f5f9", muted: "#cbd5e1", border: "rgba(255,255,255,.18)", btn: "#1d4ed8", btnText: "#ffffff", btn2: "rgba(255,255,255,.12)", btn2Text: "#f1f5f9" }
        : { text: "#0f172a", muted: "#475569", border: "rgba(0,0,0,.12)", btn: "#1d4ed8", btnText: "#ffffff", btn2: "#e2e8f0", btn2Text: "#0f172a" };
    },
    render(hostId) {
      const h = this._hosts[hostId]; if (!h) return;
      const host = document.getElementById(hostId); if (!host) return;
      const pin = h.pin, T = this._theme(h.opts.theme);
      const canEdit = (typeof h.opts.canEdit === "boolean") ? h.opts.canEdit : this.canEdit();
      if (!canEdit) { host.innerHTML = ""; return; }   // 🔴 열람자 버튼 0 — 숨김(디자이너 전용 기능은 사유표시 대상이 아님)
      const st = this.buttonState({ pin, online: this._online(), canEdit });
      const esc = (s) => this._esc(s);
      const hasOrig = !!(pin && pin.blurOrigUrl);
      let html = '<div class="pbl-box" style="color:' + T.text + ';font-size:12px;margin-top:8px;">';
      html += '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">';
      html += '<button type="button" id="' + esc(hostId) + '-open" class="pbl-open" aria-disabled="' + !!st.disabled + '" ' +
        'style="display:inline-flex;align-items:center;gap:6px;min-height:40px;padding:8px 14px;border-radius:10px;border:1px solid ' + (st.disabled ? T.border : "transparent") + ';font-size:13px;font-weight:700;cursor:' + (st.disabled ? "not-allowed" : "pointer") + ';' +
        'background:' + (st.disabled ? T.btn2 : T.btn) + ';color:' + (st.disabled ? T.btn2Text : T.btnText) + ';">' +
        '<span aria-hidden="true">🫥</span><span>사람 흐리게</span></button>';
      if (hasOrig) {
        html += '<button type="button" id="' + esc(hostId) + '-revert" class="pbl-revert" style="min-height:40px;padding:8px 12px;border-radius:10px;border:1px solid ' + T.border + ';background:' + T.btn2 + ';color:' + T.btn2Text + ';font-size:12px;font-weight:700;cursor:pointer;">원본으로 되돌리기</button>';
      }
      html += '</div>';
      if (st.disabled) html += '<div class="pbl-reason" style="margin-top:6px;color:' + T.muted + ';">' + esc(st.reason) + '</div>';
      html += '</div>';
      host.innerHTML = html;
      const openBtn = document.getElementById(hostId + "-open");
      if (openBtn) openBtn.addEventListener("click", () => { if (st.disabled) { this._toast("사람 흐리게 — " + st.reason, 4200); return; } this.openEditor(pin, hostId); });
      const revertBtn = document.getElementById(hostId + "-revert");
      if (revertBtn) revertBtn.addEventListener("click", () => this.revertOriginal(pin, hostId));
    },

    /* ════════ 편집 모달 ════════ */
    async openEditor(pin, hostId) {
      if (!this.canEdit()) { this._toast("디자이너(편집) 전용"); return; }
      if (this._editors[pin.id] && this._editors[pin.id].el) return;   // 이미 열림
      this._toast("사진을 불러오는 중…");
      let src;
      try {
        if (pin.imageId && typeof Cloud !== "undefined" && Cloud.fetchImage) src = await Cloud.fetchImage(pin.imageId);
        else if (pin.imageUrl) src = (typeof Auth !== "undefined" && Auth.r2) ? Auth.r2(pin.imageUrl) : pin.imageUrl;
        else throw new Error("사진 없음");
      } catch (e) { this._toast("사진을 불러올 수 없습니다"); return; }
      let canvas;
      try { canvas = await this._toCanvas(src, this.MAX_DETECT_WIDTH * 2); } catch (e) { this._toast("이미지 디코딩 실패"); return; }
      const ed = { pin, hostId, canvas, boxes: [], reviewBoxes: [], showBoxes: true, busy: false, fullHeight: false };
      this._editors[pin.id] = ed;
      this._renderEditor(ed);
      this._detectInto(ed);
    },
    /** 감지 실행 — ed.fullHeight 에 따라 수평 띠(기본)/전체 높이. "전체 높이로 다시 찾기" 는
     *  ed.fullHeight=true 로 바꾸고 이 함수를 재호출한다. 재호출 시 사용자가 직접 그린 박스
     *  (score 없음)는 보존하고 감지 결과만 교체한다. */
    async _detectInto(ed) {
      ed.busy = true; this._renderEditor(ed);
      const manualBoxes = (ed.boxes || []).filter((b) => b.score == null);
      try {
        const dCanvas = document.createElement("canvas");
        const scale = Math.min(1, this.MAX_DETECT_WIDTH / ed.canvas.width);
        dCanvas.width = Math.round(ed.canvas.width * scale); dCanvas.height = Math.round(ed.canvas.height * scale);
        dCanvas.getContext("2d").drawImage(ed.canvas, 0, 0, dCanvas.width, dCanvas.height);
        const result = await this.detectPersons(dCanvas, { fullHeight: !!ed.fullHeight });
        const back = (b) => ({ x: Math.round(b.x / scale), y: Math.round(b.y / scale), width: Math.round(b.width / scale), height: Math.round(b.height / scale), score: b.score });
        ed.boxes = manualBoxes.concat(result.auto.map(back));
        ed.reviewBoxes = result.review.map(back);
        const n = result.auto.length, r = ed.reviewBoxes.length;
        if (n || r) this._toast("감지된 사람 " + n + "명" + (r ? (" · 확인 필요 " + r + "건(점선 — 탭하면 포함)") : ""));
        else this._toast("감지된 사람이 없습니다 — 직접 박스를 추가하거나" + (ed.fullHeight ? "" : " [전체 높이로 다시 찾기] 를 눌러보세요"));
      } catch (e) {
        this._toast("자동 감지 실패 — 직접 박스를 추가하세요(" + (e && e.message ? e.message : "모델 로드 오류") + ")", 5000);
      }
      ed.busy = false; this._renderEditor(ed);
    },
    _renderEditor(ed) {
      let el = document.getElementById("pbl-modal");
      if (!el) {
        el = document.createElement("div");
        el.id = "pbl-modal";
        el.style.cssText = "position:fixed;inset:0;z-index:10070;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center;padding:16px;";
        document.body.appendChild(el);
      }
      ed.el = el;
      const esc = (s) => this._esc(s);
      el.innerHTML =
        '<div style="background:#ffffff;color:#0f172a;border-radius:12px;max-width:min(960px,96vw);max-height:92vh;overflow:auto;padding:16px;display:flex;flex-direction:column;gap:10px;">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">' +
        '<div style="font-weight:700;font-size:15px;">사람 흐리게 — 박스 확인 후 적용</div>' +
        '<button type="button" id="pbl-close" style="min-height:36px;min-width:36px;border-radius:8px;border:1px solid #cbd5e1;background:#f1f5f9;color:#0f172a;cursor:pointer;">✕</button></div>' +
        '<div style="position:relative;max-width:100%;overflow:auto;border:1px solid #cbd5e1;border-radius:8px;">' +
        '<canvas id="pbl-canvas" style="display:block;max-width:100%;height:auto;cursor:crosshair;"></canvas></div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;font-size:12px;color:#475569;">' +
        '<span>박스 ' + ed.boxes.length + '개' + (ed.reviewBoxes && ed.reviewBoxes.length ? (' · 확인 필요(점선) ' + ed.reviewBoxes.length + '건 — 탭하면 포함') : '') + ' · 드래그로 추가 · 박스 클릭으로 삭제</span>' +
        '<label style="display:inline-flex;align-items:center;gap:4px;"><input type="checkbox" id="pbl-toggle" ' + (ed.showBoxes ? "checked" : "") + '> 박스 표시</label>' +
        (ed.fullHeight ? '' : '<button type="button" id="pbl-fullheight" ' + (ed.busy ? "disabled" : "") + ' style="min-height:32px;padding:4px 10px;border-radius:8px;border:1px solid #cbd5e1;background:#f1f5f9;color:#0f172a;font-size:12px;font-weight:600;cursor:' + (ed.busy ? "default" : "pointer") + ';">전체 높이로 다시 찾기</button>') +
        '</div>' +
        '<div style="display:flex;gap:8px;justify-content:flex-end;">' +
        '<button type="button" id="pbl-cancel" style="min-height:40px;padding:8px 14px;border-radius:10px;border:1px solid #cbd5e1;background:#e2e8f0;color:#0f172a;font-weight:700;cursor:pointer;">취소</button>' +
        '<button type="button" id="pbl-apply" ' + (ed.busy ? "disabled" : "") + ' style="min-height:40px;padding:8px 14px;border-radius:10px;border:1px solid transparent;background:#1d4ed8;color:#ffffff;font-weight:700;cursor:' + (ed.busy ? "default" : "pointer") + ';">' + (ed.busy ? "처리 중…" : "적용(서버에 저장)") + '</button>' +
        '</div></div>';
      const cv = document.getElementById("pbl-canvas");
      cv.width = ed.canvas.width; cv.height = ed.canvas.height;
      const ctx = cv.getContext("2d");
      ctx.drawImage(ed.canvas, 0, 0);
      if (ed.showBoxes) {
        const drawBox = (b) => {
          if (b.x + b.width <= cv.width) ctx.strokeRect(b.x, b.y, b.width, b.height);
          else { ctx.strokeRect(b.x, b.y, cv.width - b.x, b.height); ctx.strokeRect(0, b.y, b.width - (cv.width - b.x), b.height); }
        };
        ctx.lineWidth = Math.max(2, Math.round(cv.width / 400));
        ctx.setLineDash([]);
        ctx.strokeStyle = "#dc2626";
        ed.boxes.forEach(drawBox);
        // "확인 필요" — 점선(주황), 자동 미적용 — 탭하면 포함(위 박스 ' + ed.boxes.length + '개' 안내문과 동일 UI 규칙)
        ctx.strokeStyle = "#d97706";
        ctx.setLineDash([Math.max(6, Math.round(cv.width / 160)), Math.max(4, Math.round(cv.width / 240))]);
        (ed.reviewBoxes || []).forEach(drawBox);
        ctx.setLineDash([]);
      }
      this._bindEditorEvents(ed, cv);
    },
    _bindEditorEvents(ed, cv) {
      const close = () => { if (ed.el && ed.el.parentNode) ed.el.parentNode.removeChild(ed.el); delete this._editors[ed.pin.id]; };
      const closeBtn = document.getElementById("pbl-close"); if (closeBtn) closeBtn.onclick = close;
      const cancelBtn = document.getElementById("pbl-cancel"); if (cancelBtn) cancelBtn.onclick = close;
      const toggle = document.getElementById("pbl-toggle"); if (toggle) toggle.onchange = () => { ed.showBoxes = toggle.checked; this._renderEditor(ed); };
      const applyBtn = document.getElementById("pbl-apply"); if (applyBtn) applyBtn.onclick = () => this._applyAndSave(ed);
      const fullBtn = document.getElementById("pbl-fullheight"); if (fullBtn) fullBtn.onclick = () => { ed.fullHeight = true; this._detectInto(ed); };
      let drag = null;
      const toImgXY = (ev) => {
        const r = cv.getBoundingClientRect();
        const sx = cv.width / r.width, sy = cv.height / r.height;
        return { x: Math.round((ev.clientX - r.left) * sx), y: Math.round((ev.clientY - r.top) * sy) };
      };
      const hit = (list, p) => list.findIndex((b) => p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height);
      cv.onpointerdown = (ev) => {
        const p = toImgXY(ev);
        const hitIdx = hit(ed.boxes, p);
        if (hitIdx >= 0) { ed.boxes.splice(hitIdx, 1); this._renderEditor(ed); return; }
        // "확인 필요"(점선) 박스 탭 → 포함(review → boxes 로 이동, 자동 적용은 아니고 사용자가 확정)
        const reviewIdx = hit(ed.reviewBoxes || [], p);
        if (reviewIdx >= 0) { ed.boxes.push(ed.reviewBoxes.splice(reviewIdx, 1)[0]); this._renderEditor(ed); return; }
        drag = { x0: p.x, y0: p.y };
      };
      cv.onpointermove = (ev) => {
        if (!drag) return;
        const p = toImgXY(ev);
        drag.x1 = p.x; drag.y1 = p.y;
      };
      cv.onpointerup = () => {
        if (!drag || drag.x1 == null) { drag = null; return; }
        const x = Math.min(drag.x0, drag.x1), y = Math.min(drag.y0, drag.y1);
        const w = Math.abs(drag.x1 - drag.x0), h = Math.abs(drag.y1 - drag.y0);
        drag = null;
        if (w > 6 && h > 6) { ed.boxes.push({ x, y, width: w, height: h }); this._renderEditor(ed); }
      };
    },
    /** [적용] — 블러 캔버스 생성 → 블러본을 기본 표시로 업로드 → 블러 전 원본을 R2 로 보관 → 저장. */
    async _applyAndSave(ed) {
      if (ed.busy) return;
      if (!ed.boxes.length) { this._toast("박스가 없습니다 — 직접 추가하거나 취소하세요"); return; }
      ed.busy = true; this._renderEditor(ed);
      const pin = ed.pin;
      try {
        // 1) 블러 전(현재 표시) 픽셀을 원본으로 R2 보관 — 이미 보관돼 있으면 중복 업로드 안 함
        if (!pin.blurOrigUrl && typeof App !== "undefined" && App._uploadToR2) {
          const origBlob = await new Promise((res) => ed.canvas.toBlob((b) => res(b), "image/jpeg", 0.92));
          if (origBlob) {
            const ab = await origBlob.arrayBuffer();
            const url = await App._uploadToR2(ab, "image/jpeg");
            if (url) { pin.blurOrigUrl = url; pin.blurOrigKind = pin.imageId ? "imageId" : "imageUrl"; pin.blurOrigImageId = pin.imageId || null; }
          }
        }
        // 2) 블러 적용(복제 캔버스 — 원본 ed.canvas 는 보존해 재시도/비교 가능하게 둔다)
        const blurred = document.createElement("canvas");
        blurred.width = ed.canvas.width; blurred.height = ed.canvas.height;
        blurred.getContext("2d").drawImage(ed.canvas, 0, 0);
        this.applyBlur(blurred, ed.boxes, {});
        // 3) 블러본을 새 "기본 표시" 이미지로 업로드(기존 사진 교체 경로 재사용)
        const dataURL = blurred.toDataURL("image/jpeg", 0.88);
        if (typeof Cloud === "undefined" || !Cloud.uploadImage) throw new Error("업로드 모듈 없음");
        const newId = await Cloud.uploadImage("blur-" + pin.id, dataURL, blurred.width, blurred.height);
        pin.imageId = newId; pin.imageUrl = null;
        if (typeof App !== "undefined" && App._saveSpots) { try { App._saveSpots(pin); } catch (e) {} }
        else if (typeof App !== "undefined" && App._markDirty) { try { App._markDirty(); } catch (e) {} }
        this._toast("사람 흐리게 적용 완료 — 원본은 보관되어 되돌릴 수 있습니다");
        if (ed.el && ed.el.parentNode) ed.el.parentNode.removeChild(ed.el);
        delete this._editors[pin.id];
        this._refreshHosts();
      } catch (e) {
        this._toast("적용 실패 — " + (e && e.message ? e.message : "오류"), 5000);
        ed.busy = false; this._renderEditor(ed);
      }
    },
    /** [원본으로 되돌리기] — blurOrig* 로 pin.imageId/imageUrl 복원. 원본 R2 객체는 지우지 않는다. */
    async revertOriginal(pin, hostId) {
      if (!this.canEdit()) { this._toast("디자이너(편집) 전용"); return false; }
      if (!pin.blurOrigUrl) { this._toast("보관된 원본이 없습니다"); return false; }
      if (pin.blurOrigKind === "imageId" && pin.blurOrigImageId) { pin.imageId = pin.blurOrigImageId; pin.imageUrl = null; }
      else { pin.imageUrl = pin.blurOrigUrl; pin.imageId = null; }
      pin.blurOrigUrl = null; pin.blurOrigKind = null; pin.blurOrigImageId = null;
      if (typeof App !== "undefined" && App._saveSpots) { try { App._saveSpots(pin); } catch (e) {} }
      else if (typeof App !== "undefined" && App._markDirty) { try { App._markDirty(); } catch (e) {} }
      this._toast("원본으로 되돌렸습니다");
      if (hostId) this.render(hostId);
      return true;
    }
  };
