  const Cloud = {
    /** 업로드 목표 최대 용량(JPEG 바이트). THETA 고해상도도 D1에 안전히 저장되도록 제한 */
    MAX_UPLOAD_BYTES: 1400 * 1024, // ≈1.4MB (base64 환산 ≈1.9MB)

    /** File → 디코딩된 비트맵 소스(ImageBitmap 또는 HTMLImageElement) 반환
     *  THETA 등 고해상도/특수 JPEG도 안정적으로 읽도록 createImageBitmap 우선 사용,
     *  실패 시 HTMLImageElement로 폴백한다. */
    async _decode(file, targetMax = 4096) {
      // 1순위: createImageBitmap — 디코딩과 동시에 다운스케일하여 메모리 폭증/탭 크래시 방지.
      //  (THETA 등 5376×2688↑ 초고해상도 JPEG를 원본 그대로 디코딩하면 메모리 한계로 크래시)
      if (typeof createImageBitmap === "function") {
        // THETA 등 초고해상도 JPEG(6720×3360 등)를 createImageBitmap(file) 으로
        //    "원본 그대로" 디코딩하면 메모리 한계로 탭이 크래시(=업로드 hang)된다.
        //    따라서 절대 풀해상도 probe 를 하지 않고, 처음부터 resizeWidth 만 지정해
        //    비율을 유지한 채 축소 디코딩한다. (360° 도면은 가로가 장변인 2:1 파노라마)
        try {
          const bmp = await createImageBitmap(file, {
            imageOrientation: "from-image",
            resizeWidth: targetMax,        // 가로를 targetMax 이하로 (비율 자동 유지)
            resizeQuality: "high"
          });
          if (bmp && bmp.width && bmp.height) {
            // 혹시 세로가 더 긴 이미지면 면적이 클 수 있으니, draw 단계(resizeImage)에서
            // MAX_AREA 로 한 번 더 제한된다. 여기서는 안전한 비트맵만 반환.
            return { src: bmp, w: bmp.width, h: bmp.height, bitmap: true };
          }
        } catch (e) { /* 폴백으로 진행 */ }
      }
      // 2순위: HTMLImageElement (objectURL → 실패 시 dataURL)
      const tryImg = (srcUrl) => new Promise((resolve, reject) => {
        const img = new Image();
        const to = setTimeout(() => reject(new Error("timeout")), 20000);
        img.onload  = () => { clearTimeout(to); resolve(img); };
        img.onerror = () => { clearTimeout(to); reject(new Error("decode")); };
        img.src = srcUrl;
      });
      const objUrl = URL.createObjectURL(file);
      try {
        const img = await tryImg(objUrl);
        if (img.naturalWidth && img.naturalHeight)
          return { src: img, w: img.naturalWidth, h: img.naturalHeight, bitmap: false, _objUrl: objUrl };
        throw new Error("empty");
      } catch (e) {
        URL.revokeObjectURL(objUrl);
        // 3순위: FileReader → dataURL → Image (objectURL이 막힌 환경 대응)
        const dataUrl = await new Promise((res, rej) => {
          const r = new FileReader();
          r.onload = () => res(r.result);
          r.onerror = () => rej(new Error("파일 읽기 실패"));
          r.readAsDataURL(file);
        });
        const img2 = await tryImg(dataUrl);
        if (img2.naturalWidth && img2.naturalHeight)
          return { src: img2, w: img2.naturalWidth, h: img2.naturalHeight, bitmap: false };
        throw new Error("이미지를 디코딩할 수 없습니다(지원하지 않는 형식일 수 있음)");
      }
    },

    /** File → 리사이즈 JPEG dataURL.
     *  장변 maxDim 이하로 줄이고, 목표 용량을 넘으면 품질/크기를 자동으로 낮춰 보장한다. */
    async resizeImage(file, maxDim = 4096, quality = 0.85) {
      if (!file) throw new Error("이미지 파일이 없습니다");

      let decoded;
      try {
        decoded = await this._decode(file, maxDim);
      } catch (e) {
        throw new Error("이미지 파일을 읽을 수 없습니다 (" + (e.message || "decode") + ")");
      }

      const draw = (targetMax, q) => {
        let w = decoded.w, h = decoded.h;
        // canvas 면적 제한(브라우저별 ~16M~268M px) 대응: 장변 + 면적 동시 제한
        const MAX_AREA = 24 * 1000 * 1000; // 2400만 px (≈ 6928px²)
        let ratio = Math.min(1, targetMax / Math.max(w, h));
        let aw = Math.round(w * ratio), ah = Math.round(h * ratio);
        if (aw * ah > MAX_AREA) {
          const ar = Math.sqrt(MAX_AREA / (aw * ah));
          aw = Math.round(aw * ar); ah = Math.round(ah * ar);
        }
        const cv = document.createElement("canvas");
        cv.width = aw; cv.height = ah;
        const ctx = cv.getContext("2d");
        if (!ctx) throw new Error("캔버스 컨텍스트를 만들 수 없습니다");
        ctx.drawImage(decoded.src, 0, 0, aw, ah);
        const durl = cv.toDataURL("image/jpeg", q);
        return { dataURL: durl, width: aw, height: ah };
      };

      // 1차 시도
      let dim = maxDim, q = quality;
      let out = draw(dim, q);
      if (!out.dataURL || out.dataURL.length < 100 || out.dataURL.indexOf("data:image/jpeg") !== 0) {
        throw new Error("이미지 인코딩에 실패했습니다(해상도가 너무 큼)");
      }

      // 목표 용량 초과 시: 품질 → 크기 순으로 단계적 축소
      const bytesOf = d => Math.floor((d.length - "data:image/jpeg;base64,".length) * 0.75);
      let guard = 0;
      while (bytesOf(out.dataURL) > this.MAX_UPLOAD_BYTES && guard < 8) {
        guard++;
        if (q > 0.55) q -= 0.1;          // 먼저 품질을 낮추고
        else { dim = Math.round(dim * 0.8); q = 0.7; } // 그래도 크면 해상도를 줄임
        out = draw(dim, Math.max(0.4, q));
      }

      // 비트맵 자원 정리
      if (decoded.bitmap && decoded.src.close) { try { decoded.src.close(); } catch (e) {} }
      if (decoded._objUrl) { try { URL.revokeObjectURL(decoded._objUrl); } catch (e) {} }

      return out;
    },

    /** 업로드 → 레코드 id 반환 (타임아웃·명확한 오류 처리 포함) */
    async uploadImage(name, dataURL, width, height) {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 60000); // 최대 60초
      let res;
      try {
        res = await fetch("/tables/pano_images", {
          method: "POST",
          headers: Auth.headers(),
          body: JSON.stringify({ name, image_data: dataURL, width, height }),
          signal: ctrl.signal
        });
      } catch (e) {
        clearTimeout(to);
        if (e.name === "AbortError") throw new Error("업로드 시간 초과(네트워크가 느리거나 파일이 큽니다)");
        throw new Error("네트워크 오류: " + (e.message || e));
      }
      clearTimeout(to);
      if (!res.ok) {
        let detail = "";
        try { detail = (await res.text()).slice(0, 120); } catch (e) {}
        throw new Error("서버 저장 실패 (HTTP " + res.status + (detail ? " · " + detail : "") + ")");
      }
      let rec;
      try { rec = await res.json(); } catch (e) { throw new Error("서버 응답을 해석할 수 없습니다"); }
      if (!rec || !rec.id) throw new Error("서버가 이미지 ID를 반환하지 않았습니다");
      return rec.id;
    },

    /** id → dataURL (간단 메모리 캐시) */
    _cache: {},
    async fetchImage(id) {
      if (this._cache[id]) return this._cache[id];
      // [보안 H4] pano_images 인증 게이트 동반 — 헤더 미전송 시 401
      const res = await fetch("/tables/pano_images/" + encodeURIComponent(id), { headers: (typeof Auth !== "undefined" ? Auth.headers() : {}) });
      if (!res.ok) throw new Error("저장된 이미지를 불러올 수 없습니다 (HTTP " + res.status + ")");
      const rec = await res.json();
      if (!rec.image_data) throw new Error("이미지 데이터가 비어 있습니다");
      this._cache[id] = rec.image_data;
      return rec.image_data;
    },

    /* ── 첨부 문서(PDF/Word 등) — pano_images 테이블을 범용 dataURL 저장소로 재사용 ── */
    /** 단일 첨부 최대 용량(원본 바이트). D1 안전 한도 내. */
    MAX_DOC_BYTES: 3 * 1024 * 1024, // 3MB (base64 환산 ≈4MB)

    /** File → base64 dataURL (그대로, 무손실) */
    fileToDataURL(file) {
      return new Promise((res, rej) => {
        const r = new FileReader();
        r.onload  = () => res(r.result);
        r.onerror = () => rej(new Error("파일 읽기 실패"));
        r.readAsDataURL(file);
      });
    },

    /** 문서 업로드 → docId 반환. name 에 표시명 그대로 저장. */
    async uploadDoc(name, dataURL) {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 60000);
      let res;
      try {
        res = await fetch("/tables/pano_images", {
          method: "POST",
          headers: Auth.headers(),
          body: JSON.stringify({ name: "[doc] " + name, image_data: dataURL }),
          signal: ctrl.signal
        });
      } catch (e) {
        clearTimeout(to);
        if (e.name === "AbortError") throw new Error("업로드 시간 초과(파일이 큽니다)");
        throw new Error("네트워크 오류: " + (e.message || e));
      }
      clearTimeout(to);
      if (!res.ok) {
        let detail = "";
        try { detail = (await res.text()).slice(0, 120); } catch (e) {}
        throw new Error("문서 저장 실패 (HTTP " + res.status + (detail ? " · " + detail : "") + ")");
      }
      const rec = await res.json();
      if (!rec || !rec.id) throw new Error("서버가 문서 ID를 반환하지 않았습니다");
      this._cache[rec.id] = dataURL; // 즉시 다운로드 캐시
      return rec.id;
    },

    /** docId → dataURL */
    async fetchDoc(id) {
      if (this._cache[id]) return this._cache[id];
      const res = await fetch("/tables/pano_images/" + encodeURIComponent(id), { headers: (typeof Auth !== "undefined" ? Auth.headers() : {}) });
      if (!res.ok) throw new Error("첨부 문서를 불러올 수 없습니다 (HTTP " + res.status + ")");
      const rec = await res.json();
      if (!rec.image_data) throw new Error("문서 데이터가 비어 있습니다");
      this._cache[id] = rec.image_data;
      return rec.image_data;
    }
  };

  /* ══════════════════════════════════════════
     SyncQueue — 오프라인 우선 동기화 큐 (IndexedDB)
     · 핀의 미디어/문서 업로드를 "작업(op)"으로 로컬에 영구 보관한다.
     · 온라인이면 즉시 서버로 일괄(batch) 업로드, 오프라인이면 큐에 쌓아두고
       'online' 이벤트(=WiFi/인터넷 복구) 시 자동으로 전체 업로드/업데이트한다.
     · 스마트폰에서 인터넷이 끊겨도 핀 등록이 가능하며, 새로고침 후에도 큐가 유지된다.
     · 서버 의존 없는 안정 설계: IndexedDB 미지원 환경은 localStorage 폴백.
  ══════════════════════════════════════════ */