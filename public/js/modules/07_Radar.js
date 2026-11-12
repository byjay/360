  // [마스터 결정 2026-11-12] 미니맵 번호 가독 임계(SoT) — 실화면 글자 크기(font-size × 창
  // scale × 도면 줌)가 이 아래면 번호 텍스트만 숨기고 점은 항상 유지한다(핀 수==점 수 불변).
  const RADAR_PIN_NO_MIN_PX = 8;
  // 히스테리시스 15% — 핀치 줌(연속 입력)이 경계값 근처에서 호출마다 흔들리면 번호가 깜빡일 수
  // 있어 ON/OFF 턴오버를 다르게 둔다. 창 크기(+/−)·내용 줌(+/−) 버튼은 이산 단계라 원래 영향이
  // 없고, 연속 입력(핀치)에서만 의미 있는 안전장치.
  const RADAR_PIN_NO_HYST = 0.15;

  const Radar = {
    _pin: null,

    /** 패널 크롬(접기/더보기/크게보기/방향조절 토글) — 핀 모드(update)·동선 모드(showRoute)
     *  공용, 1회만 배선(각 바인딩이 자체 *_Bound 플래그로 멱등). [360 동선 R1] 동선 재생은
     *  핀을 거치지 않고 바로 열릴 수 있어(Routes.play → PanoViewer 직접) update() 호출 없이도
     *  이 크롬이 배선돼야 한다 — 그래서 update() 에서 추출해 공유한다. */
    _bindChromeOnce(box) {
      // [마스터 요청 N9] 미니맵 접기/펼치기 토글 (1회 바인딩)
      if (!this._toggleBound) {
        const tb = document.getElementById("pano-radar-toggle");
        if (tb) { tb.addEventListener("click", (e) => { e.stopPropagation(); box.classList.toggle("collapsed"); }); this._toggleBound = true; }
      }
      // [WO 20260929-mobile R3] 모바일 — 방향/확대(패널)/줌±(4버튼) 더보기 토글 (1회 바인딩).
      // 데스크톱은 CSS(display:contents)가 그룹을 항상 펼친 상태로 유지하므로 토글 자체가 숨겨져 무해.
      if (!this._moreBound) {
        const mb = document.getElementById("pano-radar-more");
        const grp = document.getElementById("pano-radar-more-group");
        if (mb && grp) {
          mb.addEventListener("click", (e) => {
            e.stopPropagation();
            const open = grp.classList.toggle("open");
            mb.classList.toggle("active", open);
            mb.setAttribute("aria-expanded", open ? "true" : "false");
          });
          // [p2-radar-minimap 회귀수정] 테스트 목(document)은 getElementById만 제공하고
          // document.addEventListener는 없다 — 실브라우저에서만 바깥탭 닫기를 배선한다.
          if (typeof document.addEventListener === "function") {
            document.addEventListener("click", (e) => {
              if (!grp.classList.contains("open")) return;
              if (grp.contains(e.target) || mb.contains(e.target)) return;
              grp.classList.remove("open");
              mb.classList.remove("active");
              mb.setAttribute("aria-expanded", "false");
            });
          }
          this._moreBound = true;
        }
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
      // [R5 뷰어감사 followup] 위 기본값(storedLarge=true)은 "크게보기"일 때 width:60vw까지
      // 넓어지고, 아래 조작판(controls)을 피해 위로 올라간 bottom 위치(seastar-family-tokens.css
      // §mobile .pano-radar-large)가 좁은 세로 화면(375×812 등)에서는 화면 수직 중앙(= 360 캔버스를
      // 손가락으로 끌어 회전하는 지점)까지 덮는다(.tmp/viewer-audit/scn10-2.log mobile.radar.rect
      // y325~542, 중앙 y406 포함). 데스크톱 기본값(확대)은 그대로 두고, 좁은 화면에서만 "접힘"을
      // 기본으로 — 이 세션 한정(저장 안 함, wm-radar-large 와 섞이지 않게), 토글로 언제든 펼 수 있다.
      if (!this._mobileCollapseInited) {
        this._mobileCollapseInited = true;
        try {
          if (typeof window !== "undefined" && window.matchMedia && window.matchMedia("(max-width: 720px)").matches) {
            box.classList.add("collapsed");
          }
        } catch (e) {}
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
      // [마스터 요청 2026-11-06] 미니맵 "창"(패널 전체) 크기 단계 조절 — #pano-radar-size-in/out.
      // 콘텐츠 확대(_bindZoomControls, 도면만 확대)와는 완전히 분리된 축: 여기서는 박스(#pano-radar)
      // 자체를 transform:scale() 로 키우거나 줄인다. width 를 직접 바꾸지 않으므로 기존
      // pano-radar-large(⤢ 확대/축소 2단, 위 코드) 폭 전환과 겹쳐도 서로 충돌하지 않는다
      // (scale 은 그 결과 폭 위에 곱으로 얹힌다 — 두 축이 독립이라 SoT 충돌 없음).
      if (!this._sizeBound) {
        this._sizeBound = true;
        // index 1 = 기본값(배율 1, 기존 사용자 화면 변화 0 — 회귀 방지).
        const SIZE_STEPS = [0.8, 1, 1.25, 1.55];
        const SMIN = 0, SMAX = SIZE_STEPS.length - 1;
        let step = 1;
        try {
          const v = localStorage.getItem("wm-radar-size-step");
          if (v !== null) { const n = parseInt(v, 10); if (n >= SMIN && n <= SMAX) step = n; }
        } catch (e) { /* 사생활 모드 등 localStorage 접근 불가 → 기본값(1) 유지 */ }
        const sin = document.getElementById("pano-radar-size-in");
        const sout = document.getElementById("pano-radar-size-out");
        const applySize = () => {
          const nominal = SIZE_STEPS[step];
          const safe = this._clampSizeScale(nominal, box);
          box.style.transformOrigin = "left bottom";
          box.style.transform = (Math.abs(safe - 1) < 0.001) ? "" : ("scale(" + safe.toFixed(3) + ")");
          if (sin) sin.disabled = step >= SMAX;
          if (sout) sout.disabled = step <= SMIN;
          this._updateNumberVisibility();  // 창 크기도 "실화면" 번호 크기에 곱해지는 축이라 재판정
        };
        const setStep = (n) => {
          step = Math.max(SMIN, Math.min(SMAX, n));
          try { localStorage.setItem("wm-radar-size-step", String(step)); } catch (e) {}
          applySize();
        };
        if (sin) sin.addEventListener("click", (e) => { e.stopPropagation(); setStep(step + 1); });
        if (sout) sout.addEventListener("click", (e) => { e.stopPropagation(); setStep(step - 1); });
        applySize();
        // 창 크기(뷰포트 회전·리사이즈) 변화 시 같은 step 이라도 안전 범위를 다시 계산.
        if (typeof window !== "undefined" && window.addEventListener) {
          window.addEventListener("resize", () => applySize());
        }
        // [재현 R1] 도면 이미지가 아직 디코드되기 전에 위 applySize()가 먼저 돌면(특히 새로고침
        // 직후) 스테이지 높이가 아직 확정 안 돼 maxByH 가 실제보다 크게 계산되고, 이미지가
        // 뒤늦게 로드돼도 버튼을 누르기 전까진 그 틀린 값이 그대로 남는다(뷰포트 밖으로 삐져나감
        // — p193-minimap-size-cdp.mjs B2 가 실제로 잡았다). 이미지 로드 완료 시 다시 계산해 고정.
        this._sizeApply = applySize;
      }
      // [마스터 요청] 미니맵에서 드래그로 직접 시야 방향(부채꼴) 조절 (1회 바인딩)
      if (!this._dirBound) {
        const db = document.getElementById("pano-radar-dir");
        const stage = document.getElementById("pano-radar-stage");
        if (db && stage) {
          db.addEventListener("click", (e) => {
            e.stopPropagation();
            if (this._dirAdjust) this.exitDirAdjustMode();
            else this.enterDirAdjustMode();
          });
          this._bindDirClick(stage, db, box);
          this._dirBound = true;
        }
      }
    },

    /** 현재 핀 기준으로 미니맵(도면 썸네일+핀들) 렌더 */
    update(pin) {
      this._pin = pin;
      const box = document.getElementById("pano-radar");
      if (!box) return;
      this._bindChromeOnce(box);
      // 현재 페이지의 도면 이미지 소스 확보 (뷰어/디자이너 공통)
      const mapSrc = (typeof Auth !== "undefined" && Auth.r2) ? Auth.r2(this._currentMapSrc()) : this._currentMapSrc();
      if (!mapSrc) { this.hide(); return; }

      const page = pin.page || 1;
      const imgEl = document.getElementById("pano-radar-map");
      if (imgEl && imgEl.src !== mapSrc) imgEl.src = mapSrc;
      // [재현 R1] 도면 이미지 디코드가 끝나야 스테이지 실제 높이(이미지 비율로 결정)가 확정된다 —
      // 창 크기 클램프(_clampSizeScale)가 그 전에 계산되면 틀린(너무 느슨한) 값이 굳어버린다
      // (새로고침 직후처럼 버튼 재클릭 없이 끝나는 경로에서 실측됨). 로드 완료 시 1회 재계산.
      if (imgEl && this._sizeApply) {
        // complete===true 여도 "디코드 완료" ≠ "레이아웃 반영 완료"(1x1처럼 극소 이미지에서
        // 실측 확인됨 — 같은 틱에 재계산하면 여전히 레이아웃 반영 전 수치를 읽는다).
        // 다음 페인트 이후(rAF 2회)로 미뤄 커밋된 레이아웃을 읽는다.
        const resync = () => {
          if (typeof requestAnimationFrame === "function") {
            requestAnimationFrame(() => requestAnimationFrame(() => this._sizeApply()));
          } else this._sizeApply();
        };
        if (imgEl.complete) resync();
        else imgEl.addEventListener("load", resync, { once: true });
      }
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
          const meta = numMap.get(p.id) || { no: 0, kind: PinSeries.kindOf(p), series: PinSeries.seriesOf(p) };
          // 🔴 색·형태 정본 = PinSeries.markerStyle — 도면 마커(11_UI)와 동일 함수.
          //    체크보드 핀의 사진 등록 여부를 미니맵에도 똑같이 반영한다.
          //    (한쪽만 반영하면 사용자에게 거짓말이 된다)
          const _st = PinSeries.markerStyle(p);
          // 🔴 [WO 20261019-unifymode] 구 모드별 형태(pano-radar-pin-mode-checker 둥근사각) 폐기 — 도면 마커와 같이 핀은 하나.
          //   상태 = kind(content/empty = 사진 유무) + 테두리 패턴(_st.border).
          const dot = document.createElement("div");
          dot.className = "pano-radar-pin pano-radar-pin-" + meta.kind
            + (p.id === pin.id ? " current" : "");
          dot.style.left = p.x + "%";
          dot.style.top  = p.y + "%";
          dot.title = p.label || "";
          dot.dataset.id = p.id;      // 도면 마커(.pin-marker[data-id])와 동일 식별자 — 번호 일치 검증 가능
          dot.dataset.kind = meta.kind;
          dot.dataset.filled = _st.filled ? "1" : "0"; // 사진 등록 여부(도면 마커와 동일 판정)
          // 색상도 도면 마커와 같은 정본에서 파생(현재 핀은 gold 강조 유지 → 인라인 지정 안 함).
          // 점 위에 흰 숫자가 얹히므로 가장 어두운 톤(needle)을 쓴다 — 팔레트 6종 전부 8.96~13.0:1
          // (head2 를 쓰면 gold 가 4.46:1 로 본문 기준 4.5:1 미달).
          // 체크보드: 등록 #172554(14.69:1) / 미등록 #4f46e5(6.29:1) — 둘 다 흰 숫자 4.5:1 초과.
          if (p.id !== pin.id) dot.style.background = _st.colors.needle;
          // 형태 단서(색각 이상 대비): 도면 링 패턴과 같은 이름에서 파생한 테두리.
          // CSS 클래스(.pano-radar-pin-checkboard=dashed)만으로는 등록/미등록이 같아진다 → 인라인으로 덮어쓴다.
          dot.style.borderStyle = _st.border;
          dot.style.borderWidth = (_st.border === "solid") ? "1px" : "1.4px";
          const dispNo = (PinSeries.textOf ? PinSeries.textOf(meta) : meta.no);   // [WO 20261016-multisheet P6] 접두 포함(A12) — 도면 마커와 같은 표기
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
      // + [마스터 요청 "포인트 클릭 → 하단 네비게이터에서 확대"] 사용자 콘텐츠 확대(1~6x)를
      //   기존 자동 프레이밍 위에 합성 — _applyTransform() 참조.
      if (!this._zoomBound) this._bindZoomControls();
      this._applyTransform();

      box.classList.remove("hidden");
    },

    /** 자동 프레이밍 배율/오프셋(s0,vx0,vy0) 계산 — 기존 로직 그대로(회귀 방지를 위해
     *  분리만 하고 산식은 변경하지 않았다). 구역 안이면 구역 bbox 기준, 아니면 핀 반경 기준. */
    _computeBaseView(pin, page) {
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
        return { s, vx: view.x, vy: view.y };
      }
      // [마스터] 구역이 없어도 현재 핀 주변을 확대 — 전체 도면을 작게 보여주지 말고 항상 "크게"
      const r = 18;                                      // 핀 중심 ±18% (≈36% 영역)
      const vx = Math.max(0, Math.min(100 - r * 2, pin.x - r));
      const vy = Math.max(0, Math.min(100 - r * 2, pin.y - r));
      const s = 100 / (r * 2);
      return { s, vx, vy };
    },

    /** stage 에 최종 transform(scale+translate) 적용.
     *  zoom(this._zoom, 1~6)이 1이면 기존 자동 프레이밍(base)을 그대로 쓴다(회귀 없음).
     *  zoom>1이면 배율만 base*zoom으로 올리고, 오프셋은 "현재 핀이 항상 박스 정중앙"
     *  이 되도록 재계산한다 — CSS `scale(s) translate(tx%,ty%)`(우→좌 합성, translate가
     *  먼저 적용되고 이후 scale)에서 화면상 위치 = s*(pin - v) 이므로, 중앙(50%) 고정 조건
     *  s*(pin - v) = 50 을 풀면 v = pin - 50/s. 박스 크기(.pano-radar)는 절대 건드리지
     *  않는다 — 오직 stage(안쪽 콘텐츠) transform만 바뀐다. 패널은 overflow:hidden(CSS
     *  기존 규칙, style.css:1429/1449)이라 넘친 부분은 자동으로 잘린다. */
    _applyTransform() {
      const stage = document.getElementById("pano-radar-stage");
      const pin = this._pin;
      if (!stage || !pin) return;
      const page = pin.page || 1;
      const base = this._computeBaseView(pin, page);
      const zoom = this._zoom || 1;
      let s = base.s, vx = base.vx, vy = base.vy;
      if (zoom > 1.001) {
        s = base.s * zoom;
        vx = pin.x - 50 / s;
        vy = pin.y - 50 / s;
      }
      stage.style.transformOrigin = "0 0";
      stage.style.transform = "scale(" + s.toFixed(3) + ") translate(" + (-vx).toFixed(2) + "%, " + (-vy).toFixed(2) + "%)";
      this._updateNumberVisibility();
    },

    /** style.transform 문자열에서 scale(N) 배율만 뽑는다(translate 등 나머지는 무시 — 크기 판정에
     *  필요한 건 배율뿐). 없으면 1(미적용). */
    _readScale(el) {
      const m = /scale\(([-0-9.]+)\)/.exec((el && el.style.transform) || "");
      return m ? parseFloat(m[1]) : 1;
    },

    /** [마스터 결정 2026-11-12] 번호의 "실화면" 글자 크기(px) = 저작 font-size × 창(box) scale ×
     *  도면(stage) scale. 실제 렌더된 번호 엘리먼트의 computed font-size를 읽어 CSS 값과
     *  분리되지 않게(SoT) 한다 — 샘플이 없으면(핀 0개·동선모드) null. */
    _numberVisualPx() {
      // 🔴 p2/p4/p9/p54/p101 등 vm 기반 회귀테스트는 최소 DOM 목(querySelector/getComputedStyle
      // 없음)을 쓴다 — 실브라우저가 아니면 조용히 생략(그 테스트들은 번호 가시성과 무관한 다른
      // 불변식을 검증 중이므로 여기서 숨김판정을 건너뛰어도 그 목적엔 영향 없음).
      if (typeof document.querySelector !== "function" || typeof getComputedStyle !== "function") return null;
      const box = document.getElementById("pano-radar");
      const stage = document.getElementById("pano-radar-stage");
      const sample = document.querySelector("#pano-radar-pins .pano-radar-pin-no");
      if (!box || !stage || !sample) return null;
      const fontPx = parseFloat(getComputedStyle(sample).fontSize) || 0;
      return fontPx * this._readScale(box) * this._readScale(stage);
    },

    /** 가독 임계(RADAR_PIN_NO_MIN_PX) 아래로 작아지면 번호 텍스트만 숨긴다(점은 절대 생략 안 함
     *  — CSS만 토글, DOM 개수 불변). 히스테리시스로 경계 깜빡임 방지(§RADAR_PIN_NO_HYST 주석). */
    _updateNumberVisibility() {
      const box = document.getElementById("pano-radar");
      if (!box) return;
      const px = this._numberVisualPx();
      if (px == null) return;
      // 🔴 안전쪽(표시→숨김)은 임계에서 바로 — "번호 표시 ⇒ 실화면 ≥ 임계"가 예외 없이 항상
      // 성립해야 한다(마스터 결정). 여유(복귀쪽, 숨김→표시)에만 히스테리시스를 둬 핀치 연속입력이
      // 임계 바로 위에서 흔들려도 "숨김 상태가 안정적으로 유지"되게 한다(=깜빡임 방지).
      // 표시 상태에서 임계 아래로 머무는 구간은 전혀 없다 — 즉시 숨김.
      const hiddenNow = box.classList.contains("pano-radar-no-hidden");
      const showAbove = RADAR_PIN_NO_MIN_PX * (1 + RADAR_PIN_NO_HYST);
      if (hiddenNow && px >= showAbove) box.classList.remove("pano-radar-no-hidden");
      else if (!hiddenNow && px < RADAR_PIN_NO_MIN_PX) box.classList.add("pano-radar-no-hidden");
    },

    /** [마스터 요청 2026-11-06] 창 크기 단계(scale)가 실제 뷰포트를 넘지 않도록 동적으로 재클램프.
     *  getBoundingClientRect는 "현재 적용된 transform 기준" 값이라, 비교를 위해 일단 scale을 1로
     *  풀어 측정한 기준 크기(scale=1) 위에 nominal을 곱했을 때 뷰포트에 맞는지 검증한다.
     *  패널은 left/bottom 고정(앵커 불변) → 좌하단 고정, 우측·위쪽으로만 커진다. 모바일 좁은
     *  화면(375px)에서도 이 함수가 매 적용마다 재계산하므로 화면 밖으로 나가지 않는다. */
    _clampSizeScale(nominal, box) {
      try {
        if (typeof window === "undefined" || !box || !box.getBoundingClientRect) return nominal;
        const prevTransform = box.style.transform;
        box.style.transform = "";                 // scale=1 기준 크기로 측정
        const rect = box.getBoundingClientRect();
        box.style.transform = prevTransform;
        if (!rect || !rect.width || !rect.height) return nominal;
        const margin = 8;
        const maxByW = (window.innerWidth - rect.left - margin) / rect.width;
        const maxByH = (rect.bottom - margin) / rect.height;  // 위로 자라므로 bottom 좌표만큼 여유
        const safeMax = Math.max(1, Math.min(maxByW, maxByH));
        // 🔴 여기서 floor(1)를 다시 걸면 축소 단계(nominal<1)까지 1로 끌어올려지는 버그였다
        // (p193-minimap-size-cdp.mjs A10이 실측으로 잡았다) — safeMax는 이미 >=1 이므로
        // nominal이 0.8(축소)이면 min(0.8, safeMax)=0.8 그대로 통과해야 한다.
        return Math.min(nominal, safeMax);
      } catch (e) { return nominal; }
    },

    /** [마스터 요청] 미니맵 콘텐츠(도면) 확대 1~6x — +/− 버튼, 핀치 줌, 더블탭/더블클릭 리셋.
     *  세션 중(this._zoom)에만 유지 — localStorage 영속화 안 함(요구사항 YAGNI). */
    _bindZoomControls() {
      this._zoomBound = true;
      this._zoom = this._zoom || 1;
      const ZMIN = 1, ZMAX = 6, ZSTEP = 0.6;
      const clamp = (v) => Math.max(ZMIN, Math.min(ZMAX, v));
      const zin = document.getElementById("pano-radar-zoom-in");
      const zout = document.getElementById("pano-radar-zoom-out");
      const setZoom = (v) => {
        this._zoom = clamp(v);
        this._applyTransform();
        if (zin) zin.disabled = this._zoom >= ZMAX - 0.001;
        if (zout) zout.disabled = this._zoom <= ZMIN + 0.001;
      };
      if (zin) zin.addEventListener("click", (e) => { e.stopPropagation(); setZoom(this._zoom + ZSTEP); });
      if (zout) zout.addEventListener("click", (e) => { e.stopPropagation(); setZoom(this._zoom - ZSTEP); });

      const stage = document.getElementById("pano-radar-stage");
      if (!stage) return;
      // 더블클릭(데스크톱) → 1x 리셋
      stage.addEventListener("dblclick", (e) => { e.stopPropagation(); setZoom(1); });
      // 핀치 줌(터치) — 두 손가락 거리 변화만으로 배율 산정. 자유 패닝은 두지 않는다
      // (요구: "확대 시 현재 위치를 항상 중앙 유지" → _applyTransform이 매번 재계산하므로
      // 패닝 로직 자체가 불필요, YAGNI). 더블탭(300ms 이내 재탭)은 1x 리셋.
      // 🔴 stopPropagation으로 파노라마 본체의 회전/줌 제스처로 전파되지 않게 막는다.
      let pinchStartDist = null, pinchStartZoom = 1, lastTapT = 0;
      stage.addEventListener("touchstart", (e) => {
        if (e.touches.length === 2) {
          e.preventDefault(); e.stopPropagation();
          const [a, b] = e.touches;
          pinchStartDist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
          pinchStartZoom = this._zoom;
        } else if (e.touches.length === 1) {
          e.stopPropagation();
          const now = Date.now();
          if (now - lastTapT < 300) { e.preventDefault(); setZoom(1); }
          lastTapT = now;
        }
      }, { passive: false });
      stage.addEventListener("touchmove", (e) => {
        if (e.touches.length === 2 && pinchStartDist) {
          e.preventDefault(); e.stopPropagation();
          const [a, b] = e.touches;
          const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
          setZoom(pinchStartZoom * (d / pinchStartDist));
        }
      }, { passive: false });
      stage.addEventListener("touchend", (e) => {
        e.stopPropagation();
        if (e.touches.length < 2) pinchStartDist = null;
      }, { passive: true });
    },

    /** [마스터] 방향 지정 모드 진입 — #btn-pano-setdir(파노 컨트롤바) / #pano-radar-dir(미니맵) 공용 진입점.
     *  🔴 여기서는 "진입"만 한다 — 완료 토스트는 _commitAngle()에서 실제 클릭 확정 후에만 띄운다(조기 완료 선언 금지).
     *  미니맵이 없거나 아직 표시되지 않은 상태(핀을 안 열었음)면 클릭할 대상이 없으므로 조용히 실패하지 않고 사유를 알린다. */
    enterDirAdjustMode() {
      const box = document.getElementById("pano-radar");
      const stage = document.getElementById("pano-radar-stage");
      if (!box || !stage) {
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("미니맵을 표시할 수 없습니다");
        return false;
      }
      if (box.classList.contains("hidden")) {
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("먼저 핀을 열어 미니맵을 표시하세요");
        return false;
      }
      box.classList.remove("collapsed"); // 접혀 있으면 펼쳐서 클릭 대상 확보
      this._dirAdjust = true;
      const db = document.getElementById("pano-radar-dir");
      if (db) { db.classList.add("active"); db.title = "방향 조절 끄기"; }
      box.classList.add("dir-adjust-mode");
      if (typeof Prompt !== "undefined" && Prompt.toast) {
        Prompt.toast("도면에서 선수(오른쪽) 방향을 클릭하세요");
      }
      return true;
    },

    /** 방향 지정 모드 종료(사용자가 토글로 끔 — 클릭 확정 없이 취소) */
    exitDirAdjustMode() {
      this._dirAdjust = false;
      const box = document.getElementById("pano-radar");
      const db = document.getElementById("pano-radar-dir");
      if (db) { db.classList.remove("active"); db.title = "미니맵에서 방향 조절"; }
      if (box) box.classList.remove("dir-adjust-mode");
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
        this.exitDirAdjustMode();
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
      if ((typeof App !== "undefined" && App._imagePaged ? App._imagePaged() : State.mode === "viewer") && State.viewerPages && State.viewerPages.length) {   // [WO 20261016-multisheet] 스냅샷 이미지 판정 SoT
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

    hide() {
      const b = document.getElementById("pano-radar"); if (b) b.classList.add("hidden");
      // [360 동선 R1] 핀 모드로 복귀할 다음 세션을 위해 동선 모드 흔적을 지운다.
      this._routeMode = false; this._route = null;
      const svg = document.getElementById("pano-radar-route"); if (svg) svg.classList.add("hidden");
      const cone = document.getElementById("pano-radar-cone"); if (cone) cone.classList.remove("hidden");
      const dirBtn = document.getElementById("pano-radar-dir"); if (dirBtn) dirBtn.classList.remove("hidden");
    },

    /* ══════════════════════════════════════════════════════════════
       [WO 20261016-routeminimap] 360 동영상 동선 재생 중 미니맵
       ──────────────────────────────────────────────────────────────
       [근본원인 — R1] #pano-overlay 가 fixed·inset:0·z-index:9999 전체화면이라, 재생 중에는
       도면(#map-viewport) 자체가 클릭 대상이 될 수 없다 — 63_RouteDraw.js 의 도면쪽
       click-to-seek 분기는 영원히 도달 불가능한 죽은 코드였다(p156-e2e 주석, CDP 실측).
       대체 진입점 = 이 미니맵(핀 모드와 같은 #pano-radar 패널 재사용, 접기/펼치기·크게보기
       그대로 상속) — 동선 전체를 표시하고 클릭/드래그하면 그 비율로 PanoViewer.seekRatio().
       Routes.play()(열람자도 호출 가능 — 재생은 열람자도 허용된 기능)가 호출한다. ══ */
    showRoute(route) {
      const box = document.getElementById("pano-radar");
      if (!box || !route || !(route.points || []).length) return;
      this._routeMode = true;
      this._route = route;
      this._pin = null;
      // 핀 모드 전용 크롬(접기/더보기/크게보기/방향/줌)은 그대로 재사용 — 1회만 배선.
      this._bindChromeOnce(box);
      this._bindRouteSeekOnce();
      const mapSrc = (typeof Auth !== "undefined" && Auth.r2) ? Auth.r2(this._currentMapSrc()) : this._currentMapSrc();
      const imgEl = document.getElementById("pano-radar-map");
      if (mapSrc && imgEl && imgEl.src !== mapSrc) imgEl.src = mapSrc;
      const pageEl = document.getElementById("pano-radar-page");
      if (pageEl) pageEl.textContent = "p." + (route.page || 1);
      const pinsLayer = document.getElementById("pano-radar-pins");
      if (pinsLayer) pinsLayer.innerHTML = "";
      // 방향 조절(핀 전용 개념)은 동선 모드에서 의미가 없다 — 숨긴다.
      const cone = document.getElementById("pano-radar-cone");
      if (cone) cone.classList.add("hidden");
      const dirBtn = document.getElementById("pano-radar-dir");
      if (dirBtn) dirBtn.classList.add("hidden");
      this._renderRouteSvg();
      this.updateRoutePlayhead((typeof Routes !== "undefined" && Routes._playRatio) || 0);
      this._fitRouteView(route);
      box.classList.remove("hidden");
    },

    /** 동선 전체(halo+점선+화살표) 를 미니맵 svg 에 그린다 — 재생 중 1회(진행률은 updateRoutePlayhead 가 담당). */
    _renderRouteSvg() {
      const svg = document.getElementById("pano-radar-route");
      if (!svg || !this._routeMode || !this._route) return;
      const pts = (this._route.points || []).map(p => `${p.x},${p.y}`).join(" ");
      // 투명 히트 사각형 — SVG 는 pointer-events:visiblePainted 가 기본이라 fill 이 지정된(알파 0 포함)
      // 영역만 클릭을 받는다. 동선 두께가 가늘어 조준이 어려우므로 미니맵 전체를 클릭 대상으로 넓힌다.
      svg.innerHTML = `<rect x="0" y="0" width="100" height="100" fill="rgba(0,0,0,0)" class="pano-radar-route-hit"/>`
        + `<polyline points="${pts}" class="route-line-halo"/>`
        + `<polyline points="${pts}" class="route-line"/>`;
      svg.classList.remove("hidden");
    },

    /** 재생진행률(0~1) → 미니맵 위 재생위치점 이동(Routes.play().onProgress 가 매 tick 호출). */
    updateRoutePlayhead(t) {
      if (!this._routeMode || !this._route || typeof Routes === "undefined" || !Routes.pointAtRatio) return;
      const svg = document.getElementById("pano-radar-route");
      if (!svg) return;
      const p = Routes.pointAtRatio(this._route.points, t);
      if (!p) return;
      let head = svg.querySelector(".route-playhead");
      if (!head) {
        head = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        head.setAttribute("class", "route-playhead");
        head.setAttribute("r", "2.6");
        svg.appendChild(head);
      }
      head.setAttribute("cx", p.x);
      head.setAttribute("cy", p.y);
    },

    /** 동선 전체 bbox 가 패널 안에 꼭 맞도록 stage 확대/이동(핀 모드의 _applyTransform 과 같은
     *  CSS scale+translate 기법, 동선은 "현재 핀" 개념이 없어 별도 계산). */
    _fitRouteView(route) {
      const stage = document.getElementById("pano-radar-stage");
      const pts = route && route.points;
      if (!stage || !pts || !pts.length) return;
      let minX = 100, minY = 100, maxX = 0, maxY = 0;
      pts.forEach(p => { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); });
      const pad = 10;
      const x = Math.max(0, minX - pad), y = Math.max(0, minY - pad);
      const w = Math.min(100, (maxX - minX) + pad * 2) || 20;
      const h = Math.min(100, (maxY - minY) + pad * 2) || 20;
      const s = Math.max(1, Math.min(100 / w, 100 / h));
      stage.style.transformOrigin = "0 0";
      stage.style.transform = "scale(" + s.toFixed(3) + ") translate(" + (-x).toFixed(2) + "%, " + (-y).toFixed(2) + "%)";
    },

    /** 미니맵 전체 영역 클릭/드래그 → 가장 가까운 동선 지점의 비율로 PanoViewer.seekRatio().
     *  svg 엘리먼트 자체(정적 DOM, innerHTML 재생성 대상이 아님)에 1회만 배선 — 재바인딩 불필요. */
    _bindRouteSeekOnce() {
      if (this._routeSeekBound) return;
      this._routeSeekBound = true;
      const svg = document.getElementById("pano-radar-route");
      if (!svg) return;
      let dragging = false;
      const seekAt = (clientX, clientY) => {
        if (!this._routeMode || !this._route || typeof Routes === "undefined") return;
        const rect = svg.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const px = Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100));
        const py = Math.max(0, Math.min(100, ((clientY - rect.top) / rect.height) * 100));
        const t = Routes.ratioAtPoint(this._route.points, px, py);
        if (typeof PanoViewer !== "undefined" && PanoViewer.seekRatio) PanoViewer.seekRatio(t);
      };
      svg.addEventListener("mousedown", (e) => { dragging = true; seekAt(e.clientX, e.clientY); });
      document.addEventListener("mousemove", (e) => { if (dragging) seekAt(e.clientX, e.clientY); });
      document.addEventListener("mouseup", () => { dragging = false; });
      svg.addEventListener("touchstart", (e) => { dragging = true; const t = e.touches[0]; if (t) seekAt(t.clientX, t.clientY); e.preventDefault(); }, { passive: false });
      svg.addEventListener("touchmove", (e) => { if (dragging) { const t = e.touches[0]; if (t) seekAt(t.clientX, t.clientY); e.preventDefault(); } }, { passive: false });
      svg.addEventListener("touchend", () => { dragging = false; });
    }
  };

  /* ══════════════════════════════════════════
     PANO NAV — 파노라마 내 이전/다음 포인트 이동 (탐색 핫스팟)
  ══════════════════════════════════════════ */