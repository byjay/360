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
      // [마스터 요청 "기본적으로 확대한 크기로 반영해"] 저장된 선택이 없으면 기본값=확대(large).
      // localStorage("wm-radar-large")에 사용자 선택을 저장/복원 — 없으면 true(확대).
      if (!this._largeInited) {
        this._largeInited = true;
        let storedLarge = true;
        try {
          const v = localStorage.getItem("wm-radar-large");
          if (v !== null) storedLarge = v === "1";
        } catch (e) { /* 사생활 모드 등 localStorage 접근 불가 → 기본값(확대) 유지 */ }
        box.classList.toggle("pano-radar-large", storedLarge);
        const eb0 = document.getElementById("pano-radar-expand");
        if (eb0) {
          eb0.classList.toggle("active", storedLarge);
          eb0.title = storedLarge ? "미니맵 작게 보기" : "미니맵 크게 보기";
        }
      }
      if (!this._expandBound) {
        const eb = document.getElementById("pano-radar-expand");
        if (eb) {
          eb.addEventListener("click", (e) => {
            e.stopPropagation();
            const large = box.classList.toggle("pano-radar-large");
            eb.classList.toggle("active", large);
            eb.title = large ? "미니맵 작게 보기" : "미니맵 크게 보기";
            try { localStorage.setItem("wm-radar-large", large ? "1" : "0"); } catch (e) {}
          });
          this._expandBound = true;
        }
      }
      // [마스터 요청] 미니맵에서 드래그로 직접 시야 방향(부채꼴) 조절 (1회 바인딩)
      if (!this._dirBound) {
        const db = document.getElementById("pano-radar-dir");
        const stage = document.getElementById("pano-radar-stage");
        if (db && stage) {
          db.addEventListener("click", (e) => {
            e.stopPropagation();
            this._dirAdjust = !this._dirAdjust;
            db.classList.toggle("active", this._dirAdjust);
            db.title = this._dirAdjust ? "방향 조절 끄기" : "미니맵에서 방향 조절";
            box.classList.toggle("dir-adjust-mode", this._dirAdjust);
            if (this._dirAdjust && typeof Prompt !== "undefined" && Prompt.toast) {
              Prompt.toast("지금 보고 있는 방향을 도면에서 클릭하세요 (예: 선수 방향)");
            }
          });
          this._bindDirClick(stage, db, box);
          this._dirBound = true;
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
        // 🔴 번호/부류/필터 정본 = PinSeries (01b_PinSeries.js).
        //    도면 마커(11_UI.renderPinsOnMap)와 같은 함수를 호출하므로 두 화면의 번호가 항상 일치한다.
        //    여기서 따로 세면 갈라진다(전역 CLAUDE.md §10 SoT).
        const numMap = PinSeries.numbers(State.pins, page);
        (State.pins || []).filter(p => (p.page || 1) === page).forEach(p => {
          // 표시 필터는 도면·미니맵에 동일 적용. 단, 지금 열람 중인 핀은 기준점이라 항상 표시.
          if (p.id !== pin.id && !PinSeries.isVisible(p)) return;
          const meta = numMap.get(p.id) || { no: 0, kind: PinSeries.kindOf(p) };
          const dot = document.createElement("div");
          dot.className = "pano-radar-pin pano-radar-pin-" + meta.kind + (p.id === pin.id ? " current" : "");
          dot.style.left = p.x + "%";
          dot.style.top  = p.y + "%";
          dot.title = p.label || "";
          dot.dataset.id = p.id;      // 도면 마커(.pin-marker[data-id])와 동일 식별자 — 번호 일치 검증 가능
          dot.dataset.kind = meta.kind;
          // 색상도 도면 마커와 같은 정본에서 파생(현재 핀은 gold 강조 유지 → 인라인 지정 안 함).
          // 점 위에 흰 숫자가 얹히므로 가장 어두운 톤(needle)을 쓴다 — 팔레트 6종 전부 8.96~13.0:1
          // (head2 를 쓰면 gold 가 4.46:1 로 본문 기준 4.5:1 미달).
          if (p.id !== pin.id) dot.style.background = PinSeries.colorsOf(meta.kind).needle;
          const dispNo = meta.no;
          const no = document.createElement("span");
          no.className = "pano-radar-pin-no";
          no.textContent = dispNo;
          dot.appendChild(no);
          dot.addEventListener("click", (e) => {
            e.stopPropagation();
            if (this._dirAdjust) return; // 방향 조절 모드에서는 다른 핀 이동 금지
            if (p.id !== pin.id && App.pinHasContent(p)) App.openPano(p);
          });
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
      // lon(deg): 0 = +Z 방향. 360 사진마다 촬영 시작 방향(lon=0)이 제각각이라
      // 도면 위 "위(12시)"와 일치한다는 보장이 없음 — 핀별 보정값(dirOffset)으로 상쇄.
      // [마스터: 방향 설정] pin.dirOffset = 사용자가 도면 위쪽으로 지정한 순간의 lon 값.
      const offset = (this._pin && this._pin.dirOffset) || 0;
      const effectiveLon = lon - offset;
      // conic-gradient가 -35°~+35°(약 70°) 부채꼴이므로 회전만 적용.
      fan.style.transform = "rotate(" + (effectiveLon) + "deg)";
    },

    /** [마스터 요청] 미니맵 클릭 1회로 부채꼴(시야 방향) 즉시 보정 — "지금 보는 방향 = 여기" 클릭 */
    _bindDirClick(stage, db, box) {
      // 각도 규약: spin()과 동일 — 0deg=위(북,12시), 시계방향 +, 90deg=오른쪽(동).
      // 화면좌표 dx=오른쪽+, dy=아래쪽+ 이므로 atan2(dy,dx)는 "오른쪽=0,시계방향+" 기준각.
      // 그 기준각에 +90 하면 "위=0,시계방향+" 기준으로 정렬된다(우측 기준각 0→ +90=90, 상단 기준각 -90→ +90=0).
      const angleFromEvent = (e) => {
        const cone = document.getElementById("pano-radar-cone");
        const rect = cone.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const px = (e.touches && e.touches[0] ? e.touches[0].clientX : e.clientX);
        const py = (e.touches && e.touches[0] ? e.touches[0].clientY : e.clientY);
        const dx = px - cx, dy = py - cy;
        let a = Math.atan2(dy, dx) * 180 / Math.PI + 90;
        return ((a % 360) + 360) % 360;
      };
      stage.addEventListener("click", (e) => {
        if (!this._dirAdjust) return;
        e.preventDefault(); e.stopPropagation();
        this._commitAngle(angleFromEvent(e));
        // 클릭 1회로 완료 — 방향 조절 모드 자동 종료
        this._dirAdjust = false;
        if (db) { db.classList.remove("active"); db.title = "미니맵에서 방향 조절"; }
        if (box) box.classList.remove("dir-adjust-mode");
      });
    },

    /** 클릭 각도를 pin.dirOffset으로 환산해 즉시 저장 + 부채꼴 갱신(토스트 1회) */
    _commitAngle(angleDeg) {
      const pin = this._pin;
      if (!pin) return;
      const lon = (typeof PanoViewer !== "undefined" && PanoViewer.S) ? PanoViewer.S.lon : 0;
      // spin()의 effectiveLon = lon - dirOffset 이 angleDeg가 되도록 역산.
      pin.dirOffset = lon - angleDeg;
      const fan = document.querySelector("#pano-radar-cone .pano-radar-fan");
      if (fan) fan.style.transform = "rotate(" + angleDeg + "deg)";
      if (typeof App !== "undefined" && App._autoSave) App._autoSave();
      if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("시야 방향이 조정되었습니다");
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