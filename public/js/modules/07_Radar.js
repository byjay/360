  const Radar = {
    _pin: null,

    /** 현재 핀 기준으로 미니맵(도면 썸네일+핀들) 렌더 */
    update(pin) {
      this._pin = pin;
      const box = document.getElementById("pano-radar");
      if (!box) return;
      // [마스터 요청 N9] 미니맵 접기/펼치기 토글 (1회 바인딩)
      if (!this._toggleBound) {
        const tb = document.getElementById("pano-radar-toggle");
        if (tb) { tb.addEventListener("click", (e) => { e.stopPropagation(); box.classList.toggle("collapsed"); }); this._toggleBound = true; }
      }
      // [마스터 요청] 미니맵 크게 보기 토글 (1회 바인딩) — 크기만 전환, 기존 로직 그대로
      if (!this._expandBound) {
        const eb = document.getElementById("pano-radar-expand");
        if (eb) {
          eb.addEventListener("click", (e) => {
            e.stopPropagation();
            const large = box.classList.toggle("pano-radar-large");
            eb.classList.toggle("active", large);
            eb.title = large ? "미니맵 작게 보기" : "미니맵 크게 보기";
          });
          this._expandBound = true;
        }
      }
      // 현재 페이지의 도면 이미지 소스 확보 (뷰어/디자이너 공통)
      const mapSrc = (typeof Auth !== "undefined" && Auth.r2) ? Auth.r2(this._currentMapSrc()) : this._currentMapSrc();
      if (!mapSrc) { this.hide(); return; }

      const page = pin.page || 1;
      const imgEl = document.getElementById("pano-radar-map");
      if (imgEl && imgEl.src !== mapSrc) imgEl.src = mapSrc;
      const pageEl = document.getElementById("pano-radar-page");
      if (pageEl) pageEl.textContent = "p." + page;

      // 같은 페이지의 핀들을 점으로 표시
      const pinsLayer = document.getElementById("pano-radar-pins");
      if (pinsLayer) {
        pinsLayer.innerHTML = "";
        (State.pins || []).filter(p => (p.page || 1) === page).forEach(p => {
          const dot = document.createElement("div");
          dot.className = "pano-radar-pin" + (p.id === pin.id ? " current" : "");
          dot.style.left = p.x + "%";
          dot.style.top  = p.y + "%";
          dot.title = p.label || "";
          dot.addEventListener("click", (e) => { e.stopPropagation(); if (p.id !== pin.id && App.pinHasContent(p)) App.openPano(p); });
          pinsLayer.appendChild(dot);
        });
      }
      // 시야 부채꼴을 현재 핀 위치로 이동
      const cone = document.getElementById("pano-radar-cone");
      if (cone) { cone.style.left = pin.x + "%"; cone.style.top = pin.y + "%"; }

      // [마스터 요청 #3] 핀이 영역(구역) 내부면 그 구역만 확대해서 미니맵 표시
      const stage = document.getElementById("pano-radar-stage");
      if (stage) {
        let view = null;
        try {
          if (typeof Zones !== "undefined" && Zones._bbox) {
            // [N8] 핀↔구역 매칭: pinIds 명시적 링크 우선, 없으면 기하학적 포함 판정
            const z = (State.zones || []).find(zz => (zz.page || 1) === page && (
              (Array.isArray(zz.pinIds) && zz.pinIds.indexOf(pin.id) >= 0) ||
              (Zones._contains && Zones._contains(zz, pin.x, pin.y))
            ));
            if (z) {
              const bb = Zones._bbox(z), pad = 8;
              view = {
                x: Math.max(0, bb.x - pad), y: Math.max(0, bb.y - pad),
                w: Math.min(100, bb.w + pad * 2), h: Math.min(100, bb.h + pad * 2)
              };
            }
          }
        } catch (e) {}
        if (view && view.w > 3 && view.h > 3) {
          const s = Math.min(100 / view.w, 100 / view.h);   // 더 큰 축 기준 fit
          stage.style.transformOrigin = "0 0";
          stage.style.transform = "scale(" + s.toFixed(3) + ") translate(" + (-view.x).toFixed(2) + "%, " + (-view.y).toFixed(2) + "%)";
        } else {
          // [마스터] 구역이 없어도 현재 핀 주변을 확대 — 전체 도면을 작게 보여주지 말고 항상 "크게"
          const r = 18;                                      // 핀 중심 ±18% (≈36% 영역)
          const vx = Math.max(0, Math.min(100 - r * 2, pin.x - r));
          const vy = Math.max(0, Math.min(100 - r * 2, pin.y - r));
          const s = 100 / (r * 2);
          stage.style.transformOrigin = "0 0";
          stage.style.transform = "scale(" + s.toFixed(3) + ") translate(" + (-vx).toFixed(2) + "%, " + (-vy).toFixed(2) + "%)";
        }
      }

      box.classList.remove("hidden");
    },

    /** 시야 방향(yaw=lon) + FOV에 맞춰 부채꼴 회전/너비 */
    spin(lon, fov) {
      const fan = document.querySelector("#pano-radar-cone .pano-radar-fan");
      if (!fan) return;
      // lon(deg): 0 = +Z 방향. 도면 위 "위(12시)"를 기준으로 회전시킨다.
      // conic-gradient가 -35°~+35°(약 70°) 부채꼴이므로 회전만 적용.
      fan.style.transform = "rotate(" + (lon) + "deg)";
    },

    /** 현재 표시 중인 도면(페이지) 이미지 src */
    _currentMapSrc() {
      // 뷰어 모드: 배포본 페이지 이미지
      if (State.mode === "viewer" && State.viewerPages && State.viewerPages.length) {
        const idx = (State.pdfPage || 1) - 1;
        return State.viewerPages[idx] || State.viewerPages[0] || null;
      }
      // 디자이너 모드: 이미지 도면이면 그대로
      const mapImg = document.getElementById("map-image");
      if (mapImg && !mapImg.classList.contains("hidden") && mapImg.src) return mapImg.src;
      // PDF → 미니맵 전용 고해상도 스냅샷 캐시 (페이지당 1회만 생성)
      // [마스터 지적] 화면표시용 #pdf-canvas(줌 배율에 따라 저해상도일 수 있음)를 그대로
      // 스냅샷하면 미니맵 확대(최대 3~5배)에서 블록/모자이크로 깨짐 → 별도 고해상도 오프스크린
      // 렌더링(page.render, 화면 캔버스와 무관)으로 대체. 기존 _pdfCache 캐싱 구조는 그대로 재사용.
      const pdfCanvas = document.getElementById("pdf-canvas");
      if (pdfCanvas && !pdfCanvas.classList.contains("hidden")) {
        try {
          const pageNum = State.pdfPage || 1;
          const key = "p" + pageNum;
          this._pdfCache = this._pdfCache || {};
          if (this._pdfCache[key]) return this._pdfCache[key];
          this._buildHiResSnapshot(pageNum, key); // 비동기 생성 → 완료 시 미니맵에 자동 반영
          return pdfCanvas.toDataURL("image/jpeg", 0.85); // 생성 완료 전 임시 표시(빈 미니맵 방지)
        } catch (e) { return null; }
      }
      return null;
    },

    /** 미니맵 전용 고해상도 PDF 스냅샷을 오프스크린에서 새로 래스터화(화면용 #pdf-canvas 미변경).
     *  긴 변 ≈2400px(최대 3배)로 렌더 → 미니맵 5배 확대에도 선명. 완료되면 _pdfCache에 저장하고,
     *  아직 같은 페이지를 보고 있으면 <img>를 즉시 교체한다. */
    async _buildHiResSnapshot(pageNum, key) {
      if (this._pdfCache[key] || this._buildingKey === key) return;
      if (typeof State === "undefined" || !State.pdfDoc) return;
      this._buildingKey = key;
      try {
        const page = await State.pdfDoc.getPage(pageNum);
        const rot = ((page.rotate || 0) + (State.pdfRotation || 0)) % 360;
        const base = page.getViewport({ scale: 1, rotation: rot });
        const scale = Math.min(2400 / Math.max(base.width, base.height), 3);
        const vp = page.getViewport({ scale, rotation: rot });
        const cv = document.createElement("canvas");
        cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
        const ctx = cv.getContext("2d", { alpha: false });
        ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, cv.width, cv.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        this._pdfCache[key] = cv.toDataURL("image/jpeg", 0.85);
        if ((State.pdfPage || 1) === pageNum) {
          const imgEl = document.getElementById("pano-radar-map");
          if (imgEl) {
            const src = this._pdfCache[key];
            imgEl.src = (typeof Auth !== "undefined" && Auth.r2) ? Auth.r2(src) : src;
          }
        }
      } catch (e) { /* 실패 시 임시(저해상도) 스냅샷 유지 */ }
      this._buildingKey = null;
    },

    hide() { const b = document.getElementById("pano-radar"); if (b) b.classList.add("hidden"); }
  };

  /* ══════════════════════════════════════════
     PANO NAV — 파노라마 내 이전/다음 포인트 이동 (탐색 핫스팟)
  ══════════════════════════════════════════ */