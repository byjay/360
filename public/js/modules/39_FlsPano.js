  /* ══════════════════════════════════════════════════════════════════════
     FlsPano — E57 스캔 격자(row/col) → 360° 등장방형(2:1) 사진 추출
     [WO flspano] FARO SCENE 로 내보낸 E57(구조화 격자: rowIndex/columnIndex + RGB)에서
     파노라마 사진을 복원해 핀 사진으로 바로 등록한다. SCENE 에서 내보낸 파노라마
     PNG/JPG(수직 FOV가 잘린 상태)는 padToEquirect 로 세로 패딩만 적용한다.
     의존: 09_FLS.js(FLS._parseE57(buf,{grid:true}) — SoT), 27_PinActionPop.js
     (PinActionPop._registerPhotoFile — 기존 단건 등록 경로 재사용, 수정 없음).
     색/스타일: public/css/style.css 의 .fls-ctrl / .fls-stats 에서 이미 쓰는
     색 조합(#8ec5ff on rgba(8,18,32,.9) 등)만 재사용 — 새 CSS 파일 수정 없음.
  ══════════════════════════════════════════════════════════════════════ */
  const FlsPano = {
    MIN_W: 2048, MAX_W: 8192,
    TOP_DEG: 90, BOTTOM_DEG: -60,   // FARO Focus 류 기본 수직 FOV(탐지 메타 없을 때 추정치)

    _e57: null,      // { buf, name } — 가장 최근 로드된 E57(격자 추출 대상)
    _btn: null, _panel: null,

    /* ── 09_FLS.js 훅: E57 로드 완료 시 호출(버튼 노출 여부만 결정, 전해상도 디코딩은 클릭 시) ── */
    onE57Loaded(buf, name) {
      this._e57 = { buf, name };
      this._ensureButton();
      const has = this._hasGridFields(buf);
      if (this._btn) this._btn.classList.toggle("hidden", !has);
      this._closePanel();
    },

    /** XML만 가볍게 훑어 rowIndex/columnIndex 존재 여부 확인(전체 비트 디코딩 없음) */
    _hasGridFields(buf) {
      try {
        const h = FLS._e57Header(buf);
        const u8 = new Uint8Array(buf);
        const xmlBytes = FLS._e57ReadLogical(u8, h.xmlPhysOffset, h.xmlLength, h.pageSize);
        const xml = new TextDecoder("utf-8").decode(xmlBytes);
        return /<rowIndex\b/.test(xml) && /<columnIndex\b/.test(xml);
      } catch (e) { return false; }
    },

    _doc() { return (typeof document !== "undefined") ? document : null; },

    /** FLS 패널 헤더(.fls-head-actions)에 [360 사진 추출] 버튼을 1회만 삽입(index.html 수정 금지 — 동적 생성) */
    _ensureButton() {
      const doc = this._doc();
      if (!doc || this._btn) return;
      const actions = doc.querySelector(".fls-head-actions");
      if (!actions) return;
      const btn = doc.createElement("button");
      btn.id = "btn-flspano-extract";
      btn.className = "fls-ctrl hidden";     // 기존 .fls-ctrl 재사용 — 대비 검증된 색 그대로
      btn.type = "button";
      btn.title = "스캔 격자에서 360° 사진 추출";
      btn.textContent = "360 사진 추출";
      btn.addEventListener("click", () => this._openPanel());
      const collapseBtn = doc.getElementById("btn-fls-collapse");
      if (collapseBtn && collapseBtn.parentNode) collapseBtn.parentNode.insertBefore(btn, collapseBtn);
      else actions.appendChild(btn);
      this._btn = btn;

      // SCENE 파노라마 PNG/JPG 직접 열기(수직 FOV 잘린 이미지 → padToEquirect) — E57 유무와 무관하게 상시 노출
      if (!doc.getElementById("btn-flspano-image")) {
        const imgBtn = doc.createElement("button");
        imgBtn.id = "btn-flspano-image"; imgBtn.className = "fls-ctrl"; imgBtn.type = "button";
        imgBtn.title = "SCENE 파노라마 이미지(PNG/JPG) 열기 — 세로 패딩해 360 사진으로 변환";
        imgBtn.textContent = "SCENE 이미지";
        imgBtn.addEventListener("click", () => this.openImagePicker());
        if (collapseBtn && collapseBtn.parentNode) collapseBtn.parentNode.insertBefore(imgBtn, collapseBtn);
        else actions.appendChild(imgBtn);
      }
    },

    /* ── 미리보기 패널(동적 DOM — index.html 미사용) ── */
    _closePanel() { if (this._panel) { this._panel.remove(); this._panel = null; } },

    _openPanel() {
      const doc = this._doc();
      if (!doc) return;
      this._closePanel();
      const stage = doc.getElementById("fls-stage");
      if (!stage) return;
      const p = doc.createElement("div");
      p.id = "flspano-panel";
      p.style.cssText = "position:absolute;right:10px;top:10px;max-width:320px;padding:10px 12px;"
        + "background:rgba(8,18,32,.92);border:1px solid rgba(91,170,255,.35);border-radius:8px;"
        + "color:#cfe0f5;font-size:12px;z-index:30;display:flex;flex-direction:column;gap:8px;";
      p.innerHTML =
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">'
        + '<strong style="color:#8ec5ff;">360 사진 추출</strong>'
        + '<button type="button" id="flspano-close" class="fls-ctrl" style="padding:2px 7px;">닫기</button></div>'
        + '<div id="flspano-status" style="color:#aed4ff;">격자를 전해상도로 디코딩 중…</div>'
        + '<canvas id="flspano-preview" style="width:100%;border-radius:6px;display:none;background:#0a1422;"></canvas>'
        + '<div id="flspano-actions" style="display:none;gap:6px;">'
        + '<button type="button" id="flspano-save" class="fls-ctrl">JPG 저장</button>'
        + '<button type="button" id="flspano-register" class="fls-ctrl">선택한 핀에 등록</button></div>';
      stage.appendChild(p);
      this._panel = p;
      doc.getElementById("flspano-close").addEventListener("click", () => this._closePanel());
      this._runExtract();
    },

    _setStatus(msg) { if (this._panel) { const s = this._panel.querySelector("#flspano-status"); if (s) s.textContent = msg; } },

    async _runExtract() {
      if (!this._e57) return this._setStatus("불러온 E57 이 없습니다.");
      try {
        const parsed = FLS._parseE57(this._e57.buf, { grid: true });
        if (!parsed.grid) { this._setStatus("이 E57 에는 스캔 격자(행/열) 정보가 없어 360 사진을 만들 수 없습니다."); return; }
        const canvas = this.fromGrid(parsed.grid);
        const padded = this.padToEquirect(canvas, this.TOP_DEG, this.BOTTOM_DEG);
        this._lastCanvas = padded;
        this._setStatus(padded.width + "×" + padded.height + " · 격자점 " + parsed.grid.n.toLocaleString() + "개");
        const prev = this._panel && this._panel.querySelector("#flspano-preview");
        if (prev) {
          prev.width = padded.width; prev.height = padded.height;
          prev.style.display = "block";
          const ctx = prev.getContext && prev.getContext("2d");
          if (ctx && padded.getContext) ctx.drawImage(padded, 0, 0);
        }
        const actions = this._panel && this._panel.querySelector("#flspano-actions");
        if (actions) {
          actions.style.display = "flex";
          const saveBtn = actions.querySelector("#flspano-save");
          const regBtn = actions.querySelector("#flspano-register");
          if (saveBtn) saveBtn.onclick = () => this._saveJpg();
          if (regBtn) regBtn.onclick = () => this._registerToPin();
        }
      } catch (e) {
        this._setStatus("추출 실패: " + ((e && e.message) || e));
      }
    },

    async _saveJpg() {
      if (!this._lastCanvas) return;
      try {
        const blob = await this.toJpegBlob(this._lastCanvas, 0.92);
        const doc = this._doc();
        const name = (this._e57 && this._e57.name ? this._e57.name.replace(/\.[^.]+$/, "") : "e57pano") + "_360.jpg";
        const url = URL.createObjectURL(blob);
        const a = doc.createElement("a");
        a.href = url; a.download = name; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
      } catch (e) { this._setStatus("JPG 저장 실패: " + ((e && e.message) || e)); }
    },

    async _registerToPin() {
      if (!this._lastCanvas) return;
      try {
        const blob = await this.toJpegBlob(this._lastCanvas, 0.92);
        const name = (this._e57 && this._e57.name ? this._e57.name.replace(/\.[^.]+$/, "") : "e57pano") + "_360.jpg";
        const file = new File([blob], name, { type: "image/jpeg" });
        if (typeof PinActionPop !== "undefined" && PinActionPop._registerPhotoFile) {
          await PinActionPop._registerPhotoFile(file);
          this._setStatus("핀에 등록 요청됨(360 탭에서 확인하세요).");
        } else {
          this._setStatus("핀 등록 기능을 찾지 못했습니다(PinActionPop 미로드).");
        }
      } catch (e) { this._setStatus("등록 실패: " + ((e && e.message) || e)); }
    },

    /* ══════════════════ 순수 변환 로직(테스트 대상 — DOM 의존은 document 주입) ══════════════════ */

    /** 단위 쿼터니언 q=(w,x,y,z)로 벡터 v={x,y,z}를 회전한다(Rodrigues 최적화형). */
    _rotByQuat(v, q) {
      if (!q || q.w == null || !isFinite(q.w)) return v;
      const qx = q.x || 0, qy = q.y || 0, qz = q.z || 0, qw = q.w;
      const tx = 2 * (qy * v.z - qz * v.y);
      const ty = 2 * (qz * v.x - qx * v.z);
      const tz = 2 * (qx * v.y - qy * v.x);
      return {
        x: v.x + qw * tx + (qy * tz - qz * ty),
        y: v.y + qw * ty + (qz * tx - qx * tz),
        z: v.z + qw * tz + (qx * ty - qy * tx)
      };
    },
    /** 단위 쿼터니언 역회전(켤레) */
    _rotByQuatInverse(v, q) {
      if (!q) return v;
      return this._rotByQuat(v, { w: q.w, x: -(q.x || 0), y: -(q.y || 0), z: -(q.z || 0) });
    },

    /** 같은 열(column)로 매핑된 픽셀 사이 빈칸을 세로로 선형보간(스캔 미도달 영역은 그대로 둔다) */
    _fillVerticalGaps(buf, W, H, count) {
      for (let x = 0; x < W; x++) {
        let last = -1;
        for (let y = 0; y < H; y++) {
          const idx = y * W + x;
          if (count[idx]) {
            if (last >= 0 && y - last > 1) {
              const o0 = (last * W + x) * 4, o1 = idx * 4;
              for (let yy = last + 1; yy < y; yy++) {
                const t = (yy - last) / (y - last), oo = (yy * W + x) * 4;
                buf[oo] = Math.round(buf[o0] + (buf[o1] - buf[o0]) * t);
                buf[oo + 1] = Math.round(buf[o0 + 1] + (buf[o1 + 1] - buf[o0 + 1]) * t);
                buf[oo + 2] = Math.round(buf[o0 + 2] + (buf[o1 + 2] - buf[o0 + 2]) * t);
                buf[oo + 3] = 255;
              }
            }
            last = y;
          }
        }
      }
    },

    /** E57 격자(grid: {rows,cols,n,row,col,localXYZ,rgb,intensity,pose}) → 등장방형(2:1) canvas.
     *  각 점의 로컬 방향(= pose 역회전 적용 후 x,y,z)에서 방위각(열)·고도각(행 대표값)을 구해
     *  캔버스에 직접 배치한다 — 스캔이 도달하지 못한 영역(예: FARO 하단 -60° 아래)은 중립 회색으로 둔다. */
    fromGrid(grid, opts) {
      if (!grid || !grid.rows || !grid.cols || !grid.n || !grid.localXYZ) throw new Error("격자 정보가 없습니다(localXYZ 없음).");
      const doc = (opts && opts.doc) || this._doc();
      if (!doc) throw new Error("canvas 생성 불가(document 없음).");
      const n = grid.n;
      let W = Math.max(this.MIN_W, Math.min(this.MAX_W, grid.cols));
      W -= (W % 2);
      const H = W / 2;
      const qInv = grid.pose && grid.pose.rotation
        ? { w: grid.pose.rotation.w, x: grid.pose.rotation.x, y: grid.pose.rotation.y, z: grid.pose.rotation.z }
        : null;

      const canvas = doc.createElement("canvas");
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext("2d");
      const imgData = ctx.createImageData(W, H);
      const buf = imgData.data;
      for (let i = 3; i < buf.length; i += 4) buf[i] = 255; // 알파
      for (let i = 0; i < buf.length; i += 4) { buf[i] = 128; buf[i + 1] = 128; buf[i + 2] = 128; } // 중립 회색

      const count = new Uint32Array(W * H);
      const sumR = new Float32Array(W * H), sumG = new Float32Array(W * H), sumB = new Float32Array(W * H);
      const useColor = !!grid.rgb, useIntensity = !grid.rgb && !!grid.intensity;

      for (let i = 0; i < n; i++) {
        let x = grid.localXYZ[i * 3], y = grid.localXYZ[i * 3 + 1], z = grid.localXYZ[i * 3 + 2];
        if (qInv) { const r = this._rotByQuatInverse({ x, y, z }, qInv); x = r.x; y = r.y; z = r.z; }
        const az = Math.atan2(y, x);                 // -π..π
        const el = Math.atan2(z, Math.hypot(x, y));  // -π/2..π/2
        let px = Math.floor(((az + Math.PI) / (2 * Math.PI)) * W) % W; if (px < 0) px += W;
        let py = Math.floor(((Math.PI / 2 - el) / Math.PI) * H);
        if (py < 0) py = 0; else if (py >= H) py = H - 1;
        const idx = py * W + px;
        let r, g, b;
        if (useColor) { r = grid.rgb[i * 3]; g = grid.rgb[i * 3 + 1]; b = grid.rgb[i * 3 + 2]; }
        else if (useIntensity) { const gv = Math.max(0, Math.min(255, grid.intensity[i] * 255)); r = g = b = gv; }
        else { r = g = b = 160; }
        sumR[idx] += r; sumG[idx] += g; sumB[idx] += b; count[idx]++;
      }
      for (let idx = 0; idx < W * H; idx++) {
        if (!count[idx]) continue;
        const o = idx * 4, c = count[idx];
        buf[o] = Math.round(sumR[idx] / c); buf[o + 1] = Math.round(sumG[idx] / c); buf[o + 2] = Math.round(sumB[idx] / c);
      }
      this._fillVerticalGaps(buf, W, H, count);
      ctx.putImageData(imgData, 0, 0);
      return canvas;
    },

    /** 이미 2:1 이면 그대로, 아니면(SCENE 내보내기처럼 수직 FOV가 topDeg~bottomDeg 로 잘린 이미지)
     *  세로로 중립 회색 패딩해 2:1 등장방형으로 맞춘다. */
    padToEquirect(img, topDeg, bottomDeg, opts) {
      if (!img || !img.width || !img.height) throw new Error("이미지 정보가 없습니다.");
      const doc = (opts && opts.doc) || this._doc();
      if (!doc) throw new Error("canvas 생성 불가(document 없음).");
      const ratio = img.width / img.height;
      if (ratio >= 1.95 && ratio <= 2.05) return img; // 이미 2:1
      const top = topDeg == null ? this.TOP_DEG : topDeg;
      const bottom = bottomDeg == null ? this.BOTTOM_DEG : bottomDeg;
      const W = img.width;
      const H = Math.round(W / 2);
      const topFrac = (90 - top) / 180;
      const botFrac = (90 - bottom) / 180;
      const yTop = Math.round(topFrac * H);
      const yBot = Math.round(botFrac * H);
      const destH = Math.max(1, yBot - yTop);

      const canvas = doc.createElement("canvas");
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "rgb(128,128,128)";
      ctx.fillRect(0, 0, W, H);
      ctx.drawImage(img, 0, yTop, W, destH);
      return canvas;
    },

    /** canvas → JPEG Blob */
    toJpegBlob(canvas, q) {
      return new Promise((resolve, reject) => {
        if (!canvas || typeof canvas.toBlob !== "function") { reject(new Error("이 브라우저는 canvas.toBlob 을 지원하지 않습니다.")); return; }
        canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("JPEG 인코딩 실패")), "image/jpeg", q == null ? 0.92 : q);
      });
    },

    /* ── SCENE 파노라마 PNG/JPG 입력(별도 파일 선택 — index.html 수정 없이 자체 input 생성) ── */
    openImagePicker() {
      const doc = this._doc();
      if (!doc) return;
      let input = doc.getElementById("flspano-image-input");
      if (!input) {
        input = doc.createElement("input");
        input.type = "file"; input.accept = "image/png,image/jpeg"; input.id = "flspano-image-input";
        input.style.display = "none";
        input.addEventListener("change", (e) => {
          const f = e.target.files && e.target.files[0];
          if (f) this._loadImageFile(f);
        });
        doc.body.appendChild(input);
      }
      input.click();
    },

    async _loadImageFile(file) {
      const doc = this._doc();
      const url = URL.createObjectURL(file);
      try {
        const im = new Image();
        await new Promise((resolve, reject) => { im.onload = resolve; im.onerror = reject; im.src = url; });
        this._openPanel();
        this._e57 = { name: file.name };
        const padded = this.padToEquirect(im, this.TOP_DEG, this.BOTTOM_DEG);
        this._lastCanvas = padded;
        this._setStatus(padded.width + "×" + padded.height);
        const prev = this._panel && this._panel.querySelector("#flspano-preview");
        if (prev) {
          prev.width = padded.width; prev.height = padded.height; prev.style.display = "block";
          const ctx = prev.getContext && prev.getContext("2d");
          if (ctx) ctx.drawImage(padded, 0, 0);
        }
        const actions = this._panel && this._panel.querySelector("#flspano-actions");
        if (actions) {
          actions.style.display = "flex";
          const saveBtn = actions.querySelector("#flspano-save"), regBtn = actions.querySelector("#flspano-register");
          if (saveBtn) saveBtn.onclick = () => this._saveJpg();
          if (regBtn) regBtn.onclick = () => this._registerToPin();
        }
      } catch (e) {
        this._setStatus("이미지 로드 실패: " + ((e && e.message) || e));
      } finally { URL.revokeObjectURL(url); }
    }
  };
