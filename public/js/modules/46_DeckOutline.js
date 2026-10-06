  /* ══════════════════════════════════════════
     DECK OUTLINE — [WO 20261002-allmenu §6] 마스터: "메인에서 지정한 부분을 캡처해
     만든 구역이면, 메인에서도 그 구역을 윤곽으로 보이게 해. 지금의 영역처럼" +
     (추가지시) "그 구역을 클릭하면 이동하게 해 — 라벨만이 아니라 윤곽 안쪽 어디를
     눌러도 그 구역으로 이동해야 한다."

     [재현] 지휘자 R3: git grep -i "src_crop" HEAD -- public/js/modules src/index.tsx
       → 31_Projects.js(저장)·41_RegionMerge.js(합치기)·src/index.tsx(검증)뿐, 렌더 코드 0건.
       → 구역 원본 상자(src_crop/crop)는 저장되지만 메인 도면 위에 그려지지 않았다(FAIL).

     데이터 SoT(새 컬럼 금지, Projects.decks 재사용):
       ① 벡터 복사 구역: deck.src_dep_id + deck.src_page + deck.src_crop(페이지 % 상자)
       ② 창 방식 구역  : deck.deployment_id + deck.crop(%) + deck.page
     "메인 배포본"이라는 특수 판정을 두지 않는다 — "지금 보는 배포본+페이지"를 기준으로 그 위에
     얹힌 구역을 찾는 규칙 하나면 메인이든 아니든 항상 맞다(§SoT, 31_Projects._srcBoxFields 주석과 동일 전제).

     좌표계: Zones(16_Zones.js)와 동일한 "페이지 기준 %" — #map-transform 안에 넣어 줌/팬을
     CSS transform에 그대로 얹혀가게 한다(새 좌표변환 금지 — 기존 zones-svg viewBox 0 0 100 100 재사용).

     클릭 판정(마스터 2차 지시): 윤곽은 pointer-events:none(핀 생성 등 편집 클릭을 막지 않음) —
     "보기 상태"에서만 vp 클릭 좌표를 Zones 와 동일한 MapCtrl.viewportToPercent 로 얻어 사각형
     hit-test 한다(DOM pointer-events 토글에 기대지 않음). 공유 파일(20_App.js/11_UI.js) 미수정 —
     이 모듈이 자기 스코프에서 UI.renderPinsOnMap/Zones.render/Projects.loadDecks 를 감싸 "기존 지도
     렌더·클릭 경로"에 끼워 넣는다(새 메커니즘 추가가 아니라 기존 재렌더 시점에 얹기만 함).
  ══════════════════════════════════════════ */
  const DeckOutline = {
    _hitRects: [],      // 현재 페이지에 그려진 사각형들(hit-test용) [{id,name,x,y,w,h,area}]
    _downPt: null,       // mousedown/touchstart 시작점 — 드래그/팬 뒤 클릭 무시(기존 탭 판정 재사용)
    _tipEl: null,

    /** 편집 도구가 켜져 있는가 — 켜져 있으면 윤곽 클릭(이동)을 양보하고 기존 클릭 처리(핀 생성 등)로 보낸다. */
    _editActive() {
      if (typeof State === "undefined") return false;
      if (State.placing || State.drawingZone) return true;
      if (State.annoTool && State.annoTool !== "cursor") return true;
      if (typeof UI !== "undefined" && UI._alignCapture) return true;
      return false;
    },

    /** 현재 보는 배포본(State.currentDeploymentId) + 페이지(State.pdfPage) 위에 "캡처되어 올라앉은"
     *  구역들의 원본 상자(% 좌표) 목록. 자기 자신(Projects.currentDeck)은 제외.  순수 조회 함수. */
    _boxesForCurrentPage() {
      if (typeof Projects === "undefined" || !Array.isArray(Projects.decks)) return [];
      const depId = (typeof State !== "undefined") ? State.currentDeploymentId : null;
      if (!depId) return [];
      const page = (typeof State !== "undefined" && State.pdfPage) || 1;
      const curId = Projects.currentDeck && Projects.currentDeck.id;
      const out = [];
      (Projects.decks || []).forEach((d) => {
        if (!d || (curId != null && String(d.id) === String(curId))) return;
        let box = null;
        if (d.src_dep_id && String(d.src_dep_id) === String(depId)
            && (Number(d.src_page) || 1) === page
            && d.src_crop && d.src_crop.w > 0 && d.src_crop.h > 0) {
          box = d.src_crop;
        } else if (d.deployment_id && String(d.deployment_id) === String(depId)
            && d.crop && d.crop.w > 0 && d.crop.h > 0
            && (Number(d.page) || 1) === page) {
          box = d.crop;
        }
        if (!box) return;
        out.push({ id: d.id, name: d.name || "(이름 없음)", x: box.x, y: box.y, w: box.w, h: box.h, area: Math.max(0.0001, box.w * box.h) });
      });
      return out;
    },

    /** 레이어 DOM 생성(한 번) — index.html 미수정, zones-layer 바로 앞(= 더 뒤 z순서)에 끼운다. */
    _ensureLayers() {
      const transform = document.getElementById("map-transform");
      if (!transform) return null;
      let svg = document.getElementById("deck-outline-svg");
      let layer = document.getElementById("deck-outline-layer");
      if (!svg) {
        svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("id", "deck-outline-svg");
        svg.setAttribute("class", "deck-outline-svg");
        svg.setAttribute("viewBox", "0 0 100 100");
        svg.setAttribute("preserveAspectRatio", "none");
        svg.setAttribute("aria-hidden", "true");
      }
      if (!layer) {
        layer = document.createElement("div");
        layer.id = "deck-outline-layer";
        layer.className = "deck-outline-layer";
      }
      const zonesLayer = document.getElementById("zones-layer");
      if (!svg.parentNode || !layer.parentNode) {
        if (zonesLayer && zonesLayer.parentNode === transform) {
          transform.insertBefore(svg, zonesLayer);
          transform.insertBefore(layer, zonesLayer);
        } else {
          transform.appendChild(svg);
          transform.appendChild(layer);
        }
      }
      return { svg, layer };
    },

    /** 끄고 켤 수 있는 토글(기본 켬) — 기존 설정 패널의 360 리더선 토글 옆에 끼운다(새 모달 금지). */
    _ensureToggle() {
      if (typeof State !== "undefined" && typeof State.deckOutline !== "boolean") {
        let saved = null;
        try { saved = localStorage.getItem("seastar_deck_outline"); } catch (e) {}
        State.deckOutline = saved === null ? true : saved === "1";
      }
      if (document.getElementById("chk-deck-outline")) return;
      const anchorLabel = document.querySelector('label[for="chk-leader360"]');
      if (!anchorLabel || !anchorLabel.parentNode) return;
      // DOM API로 직접 조립(innerHTML 금지) — 생성 즉시 체크박스를 참조해야 하므로 파싱 타이밍에 기대지 않는다.
      const row = document.createElement("label");
      row.className = "settings-leader-toggle-row";
      row.setAttribute("for", "chk-deck-outline");
      row.style.display = "flex"; row.style.alignItems = "center"; row.style.gap = "8px"; row.style.marginTop = "8px"; row.style.cursor = "pointer";
      const chk = document.createElement("input");
      chk.setAttribute("type", "checkbox");
      chk.id = "chk-deck-outline";
      const span = document.createElement("span");
      span.textContent = "메인 도면에 구역 윤곽 표시";
      row.appendChild(chk);
      row.appendChild(span);
      anchorLabel.parentNode.insertBefore(row, anchorLabel.nextSibling);
      chk.checked = !!State.deckOutline;
      chk.addEventListener("change", () => {
        State.deckOutline = chk.checked;
        try { localStorage.setItem("seastar_deck_outline", chk.checked ? "1" : "0"); } catch (e) {}
        this.render();
      });
    },

    init() {
      this._ensureToggle();
      this._ensureLayers();
      const vp = document.getElementById("map-viewport");
      if (vp && !this._bound) {
        this._bound = true;
        vp.addEventListener("mousedown", (e) => { this._downPt = { x: e.clientX, y: e.clientY }; });
        vp.addEventListener("touchstart", (e) => { const t = e.touches && e.touches[0]; if (t) this._downPt = { x: t.clientX, y: t.clientY }; }, { passive: true });
        vp.addEventListener("click", (e) => this._onViewClick(e));
        vp.addEventListener("mousemove", (e) => this._onHoverMove(e));
        vp.addEventListener("mouseleave", () => this._hideTip());
      }
      this.render();
    },

    /** 렌더 — Zones.render() 와 같은 호출 지점(기존 지도 재렌더 경로)에 얹혀 자동 호출된다(아래 _wrapHosts). */
    render() {
      const layers = this._ensureLayers();
      if (!layers) return;
      const { svg, layer } = layers;
      const on = (typeof State === "undefined") || State.deckOutline !== false;
      this._hitRects = on ? this._boxesForCurrentPage() : [];
      if (!on || !this._hitRects.length) { svg.innerHTML = ""; layer.innerHTML = ""; return; }
      const esc = (typeof UI !== "undefined" && UI.escapeHtml) ? UI.escapeHtml : (s) => String(s);
      svg.innerHTML = this._hitRects.map((b) =>
        `<rect data-deck-outline="${esc(String(b.id))}" class="deck-outline-shape" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="0.4"/>`
      ).join("");
      // [재현 R1/R2 수정] 라벨 anchor = 사각형의 "위쪽" 꼭짓점(top:${b.y}%) — updateLabelScale()이
      // translateY(-100%)를 더해 라벨을 그 점 바로 위(사각형 바깥)에 앉힌다. top 변 전체가 라벨에
      // 가려지던 종전 문제(라벨이 top:-1px;left:-1px 상자 안쪽에 얹혀 상단 변·핀 4/5를 덮었다 —
      // 실측 .tmp/fixoutline2/03-main-with-outline.png)의 근본수정. 공간이 없으면 _placeLabels()가
      // 사각형 "안쪽 하단"(bottom 변 안쪽)으로 전환한다.
      layer.innerHTML = this._hitRects.map((b) =>
        `<button type="button" class="deck-outline-label" data-deck-outline-label="${esc(String(b.id))}"
            style="left:${b.x}%;top:${b.y}%" title="클릭하면 '${esc(b.name)}'(으)로 이동">${esc(b.name)}</button>`
      ).join("");
      layer.querySelectorAll("[data-deck-outline-label]").forEach((btn) => {
        btn.addEventListener("click", (e) => { e.stopPropagation(); this._goto(btn.getAttribute("data-deck-outline-label")); });
      });
      this.updateLabelScale();
      this._placeLabels();
      // [견고화] 핀(.pin-marker)이 이 render() 호출과 "같은 리스너 체인"이 아니라 조금 늦게(다른
      // 비동기 경로로) 자리잡는 경우가 있어(실측: 간헐 FAIL, 겹침값이 항상 같은 크기로 재현 — 최초
      // 배치 판정 시점에 핀이 아직 없었다는 뜻) 한 틱 늦게 한 번 더 겹침을 재확인한다. render() 가
      // 그 사이 다시 불려도(최신 _hitRects 기준으로) 무해 — 멱등 재계산일 뿐이다. */
      clearTimeout(this._placeLabelsRetryT);
      this._placeLabelsRetryT = setTimeout(() => { try { this._placeLabels(); } catch (e) {} }, 350);
    },

    /** 확대해도 라벨이 흐려지지 않게 역스케일(Zones.updateLabelScale 과 동일 원리) + 라벨을 자기
     *  앵커점(위 render() 의 top:${b.y}%) 바로 "위"로 띄우는 고정 화면-px 오프셋(translateY(-100%)).
     *  scale 을 translateY 보다 **앞에** 둬야 한다 — translateY(-100%)는 라벨 자신의 레이아웃
     *  높이(줌과 무관)를 기준으로 하므로, scale(inv)·상위 #map-transform 의 zoom 이 상쇄되어
     *  화면상 오프셋이 줌과 무관하게 일정해진다(라벨 자체가 역스케일로 항상 같은 화면 크기인 것과
     *  동일한 원리). 순서를 바꾸면(translateY 먼저) 줌에 비례해 간격이 늘고 줄어든다. */
    updateLabelScale() {
      const layer = document.getElementById("deck-outline-layer");
      if (!layer) return;
      const zoom = (typeof State !== "undefined" && State.zoom) || 1;
      const inv = (1 / zoom).toFixed(3);
      layer.querySelectorAll(".deck-outline-label").forEach((el) => { el.style.transform = `scale(${inv}) translateY(-100%)`; });
    },

    /** [재현 R2 수정] 라벨 기본 위치 = 사각형 바깥 위쪽(anchor=top, translateY(-100%)로 사각형
     *  위에 뜸). ① 도면 영역(svg) 바깥으로 넘어가거나(공간 없음) ② 실제 핀 마커(.pin-marker)와
     *  겹치면 사각형 "안쪽 하단"(anchor=bottom)을 시도해 겹침이 더 작은 쪽을 쓴다 — 숨기지 않고
     *  항상 보이게 한다(마스터 지시 "숨기지 마"). 레이아웃 실측(getBoundingClientRect)이라 줌/팬과
     *  무관하다. 핀은 같은 페이지의 "다른" 구역 핀(리더선이 상자 주변을 지나는 경우)도 포함해 겹침을
     *  0 에 가깝게 만든다 — 이 구역 소속 여부를 가리지 않는다(화면에 보이는 모든 핀 기준, 지휘자
     *  R2 "핀 마커와 겹침 면적 0" 원문 그대로). */
    _placeLabels() {
      const svg = document.getElementById("deck-outline-svg");
      const layer = document.getElementById("deck-outline-layer");
      if (!svg || !layer) return;
      const bound = svg.getBoundingClientRect();
      const pinRects = Array.from(document.querySelectorAll(".pin-marker")).map((el) => el.getBoundingClientRect());
      const overlapArea = (a, b) => {
        const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        return (w > 0 && h > 0) ? w * h : 0;
      };
      const pinOverlap = (r) => pinRects.reduce((sum, pr) => sum + overlapArea(r, pr), 0);
      layer.querySelectorAll(".deck-outline-label").forEach((btn) => {
        const id = btn.getAttribute("data-deck-outline-label");
        const box = this._hitRects.find((b) => String(b.id) === String(id));
        if (!box) return;
        btn.style.top = box.y + "%"; // 위치 ① 바깥 위쪽(기본)
        const rAbove = btn.getBoundingClientRect();
        const aboveOk = rAbove.top >= bound.top - 0.5;
        const aboveOverlap = aboveOk ? pinOverlap(rAbove) : Infinity;
        if (aboveOverlap > 0) {
          btn.style.top = (box.y + box.h) + "%"; // 위치 ② 안쪽 아래쪽
          const belowOverlap = pinOverlap(btn.getBoundingClientRect());
          const useBelow = belowOverlap < aboveOverlap;
          if (!useBelow) btn.style.top = box.y + "%";
          btn.classList.toggle("deck-outline-label-inside", useBelow);
        } else {
          btn.classList.remove("deck-outline-label-inside");
        }
      });
    },

    /** 그 구역으로 이동 — 기존 트리 진입 경로(Projects.selectDeck)를 그대로 재사용(§G-2-5). */
    _goto(id) {
      if (typeof Projects === "undefined" || !Array.isArray(Projects.decks)) return;
      const d = Projects.decks.find((x) => String(x.id) === String(id));
      if (d && Projects.selectDeck) Projects.selectDeck(d);
    },

    /** 드래그/팬/핀치 뒤의 클릭 무시 — 11_UI.js 핀 드래그와 동일한 5px 임계값 재사용(새 수치 無). */
    _wasDrag(e) {
      if (!this._downPt) return false;
      const dx = e.clientX - this._downPt.x, dy = e.clientY - this._downPt.y;
      return Math.hypot(dx, dy) >= 5;
    },

    /** 클릭 좌표(페이지 %)가 들어있는 윤곽을 찾는다. 겹치면 가장 작은 것. */
    _hitAt(clientX, clientY) {
      if (!this._hitRects.length) return null;
      if (typeof MapCtrl === "undefined" || !MapCtrl.viewportToPercent) return null;
      const pct = MapCtrl.viewportToPercent(clientX, clientY);
      if (!pct) return null;
      const hits = this._hitRects.filter((b) => pct.x >= b.x && pct.x <= b.x + b.w && pct.y >= b.y && pct.y <= b.y + b.h);
      if (!hits.length) return null;
      hits.sort((a, b) => a.area - b.area);
      return hits[0];
    },

    /** 보기 상태(편집 도구 無)에서 윤곽 안쪽 클릭 → 이동. 핀/구역(Zones)·라벨 클릭이 먼저다. */
    _onViewClick(e) {
      if (!e || !e.target || !e.target.closest) return;
      if (e.target.closest(".pin-marker") || e.target.closest(".zone-shape") || e.target.closest(".zone-box") || e.target.closest(".deck-outline-label")) return;
      if (this._editActive()) return;
      if (this._wasDrag(e)) return;
      const hit = this._hitAt(e.clientX, e.clientY);
      if (hit) this._goto(hit.id);
    },

    /** hover — 보기 상태에서 윤곽 위에 마우스가 있으면 강조 + 커서 + 툴팁. */
    _onHoverMove(e) {
      if (!this._hitRects.length || this._editActive()) { this._hideTip(); return; }
      if (e.target && e.target.closest && (e.target.closest(".pin-marker") || e.target.closest(".zone-shape") || e.target.closest(".zone-box") || e.target.closest(".deck-outline-label"))) { this._hideTip(); return; }
      const hit = this._hitAt(e.clientX, e.clientY);
      const svg = document.getElementById("deck-outline-svg");
      if (svg) svg.querySelectorAll(".deck-outline-shape").forEach((el) => {
        el.classList.toggle("hot", !!hit && el.getAttribute("data-deck-outline") === String(hit.id));
      });
      if (!hit) { this._hideTip(); return; }
      this._showTip(e.clientX, e.clientY, "클릭하면 '" + hit.name + "'(으)로 이동");
      const vp = document.getElementById("map-viewport");
      if (vp) vp.style.cursor = "pointer";
    },
    _showTip(x, y, text) {
      if (!this._tipEl) {
        this._tipEl = document.createElement("div");
        this._tipEl.className = "deck-outline-tip";
        document.body.appendChild(this._tipEl);
      }
      this._tipEl.textContent = text;
      this._tipEl.style.left = x + "px";
      this._tipEl.style.top = y + "px";
      this._tipEl.style.display = "block";
    },
    _hideTip() {
      if (this._tipEl) this._tipEl.style.display = "none";
      const svg = document.getElementById("deck-outline-svg");
      if (svg) svg.querySelectorAll(".deck-outline-shape.hot").forEach((el) => el.classList.remove("hot"));
      const vp = document.getElementById("map-viewport");
      if (vp && vp.style.cursor === "pointer") vp.style.cursor = (typeof State !== "undefined" && State.drawingZone) ? "crosshair" : "grab";
    },

    /** 🔴 공유 파일(20_App.js/11_UI.js) 미수정 — 기존 재렌더 호출부를 감싸(monkey-patch) "지도 그림이
     *  다시 그려질 때마다" 이 모듈도 같이 그린다. 모듈 로드 시 1회만 감싼다(중복 래핑 방지).
     *  UI.renderPinsOnMap 은 페이지 전환·도면 로드·구역뷰 진입/복귀 전부를 통과하는 가장 포괄적인
     *  지점이다(20_App.js _renderPdfPage/_showMapViewport/enterZoneView/exitZoneView 전수 호출 확인). */
    _wrapHosts() {
      if (this._wrapped) return;
      this._wrapped = true;
      if (typeof UI !== "undefined" && typeof UI.renderPinsOnMap === "function") {
        const orig = UI.renderPinsOnMap.bind(UI);
        UI.renderPinsOnMap = (...args) => { const r = orig(...args); try { DeckOutline.render(); } catch (e) {} return r; };
      }
      if (typeof Zones !== "undefined" && typeof Zones.render === "function") {
        const orig = Zones.render.bind(Zones);
        Zones.render = (...args) => { const r = orig(...args); try { DeckOutline.render(); } catch (e) {} return r; };
      }
      // 10_MapCtrl.applyTransform() 이 Zones.updateLabelScale() 을 매 줌/팬마다 호출한다(§144) —
      // 같은 호출 지점에 얹어 라벨 역스케일을 동기화(10_MapCtrl.js 미수정, 공유 지점 재사용).
      if (typeof Zones !== "undefined" && typeof Zones.updateLabelScale === "function") {
        const orig = Zones.updateLabelScale.bind(Zones);
        Zones.updateLabelScale = (...args) => { const r = orig(...args); try { DeckOutline.updateLabelScale(); } catch (e) {} return r; };
      }
      if (typeof Projects !== "undefined" && typeof Projects.loadDecks === "function") {
        const orig = Projects.loadDecks.bind(Projects);
        Projects.loadDecks = async (...args) => { const r = await orig(...args); try { DeckOutline.render(); } catch (e) {} return r; };
      }
    },
  };
  DeckOutline._wrapHosts();
  // 🔴 20_App.js(점유 중) 수정 없이 독립 기동 — map-viewport/settings-modal 은 index.html 정적 마크업이라
  // DOMContentLoaded 시점에 이미 존재한다(App.init() 완료를 기다릴 필요 없음).
  if (typeof document !== "undefined" && document.addEventListener) {
    document.addEventListener("DOMContentLoaded", () => { try { DeckOutline.init(); } catch (e) {} });
  }
