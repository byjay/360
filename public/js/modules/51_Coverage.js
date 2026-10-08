  /* ══════════════════════════════════════════════════════════════
     COVERAGE — 촬영 현황 뷰 (WO 20261007-qrcov 요구 B, 경쟁조사 후보 5 · OpenSpace Sheet View)
     ────────────────────────────────────────────────────────────────
     핀별 최신 촬영 시각 = 사진 이력의 shotAt(SoT: TimeLapse._normalize — 0571bbe, capturedAt 은 레거시 폴백).
     상태: none(미촬영) / stale(오래됨: 기준 N일 **초과**) / fresh(최신) / unknown(사진은 있으나 촬영 시각 기록 없음 —
       지어내지 않고 "시각 미상"으로 정직하게). 기준 N = 프로젝트 정보 info_json.staleDays(기본 14, 1~365).
     대상 = 360 모드 핀만(PinSeries.seriesOf === "content"). CHECKER 는 사진을 등록하지 않는다(마스터) → 토글 비활성 + 사유.
     표시: 토글(기본 끔)을 켜면 도면 핀에 색 링 + 모양·글리프 배지(숨김 0, 색만으로 구분 금지) + 범례 칩.
       요약 = 트리 구역 배지(로드된 구역만 — 미로드 구역은 핀을 모르니 0 날조 금지) · 전체 포인트 패널 한 줄.
       구역 집계 = Projects.pinsForDeck(0f78d34 SoT) 재사용.
     🔴 색은 인라인 리터럴(테마 변수 재해석 함정 회피 — 42_Requests/43_ProjectInfo 와 같은 규칙).
       배지 = 흰 글리프 on 진한 색: none #b91c1c 6.5:1 · stale #b45309 5.0:1 · fresh #15803d 5.0:1 · unknown #475569 7.6:1(흰 도면 대비도 같은 값).
  ══════════════════════════════════════════════════════════════ */
  const Coverage = {
    DAY_MS: 86400000,
    DEFAULT_DAYS: 14,
    on: false,
    STATES: ["none", "stale", "fresh", "unknown"],
    STYLE: {
      none:    { color: "#b91c1c", glyph: "✕", radius: "2px", label: "미촬영" },
      stale:   { color: "#b45309", glyph: "!", radius: "2px 9px", label: "오래됨" },
      fresh:   { color: "#15803d", glyph: "✓", radius: "50%", label: "최신" },
      unknown: { color: "#475569", glyph: "?", radius: "4px", label: "시각 미상" }
    },

    /** 프로젝트 기준 일수 — info_json.staleDays(1~365 정수)가 정본, 없거나 무효면 기본 14. */
    staleDays(project) {
      const p = project !== undefined ? project : ((typeof Projects !== "undefined" && Projects.currentProject) || null);
      const v = p && p.info_json ? Number(p.info_json.staleDays) : NaN;
      return Number.isInteger(v) && v >= 1 && v <= 365 ? v : this.DEFAULT_DAYS;
    },

    /** 사진 이력(현재 사진 포함) — TimeLapse._normalize 정본. */
    _shots(pin) {
      if (typeof TimeLapse !== "undefined" && TimeLapse._normalize) return TimeLapse._normalize(pin) || [];
      const src = pin && (pin.imageId || pin.imageUrl || pin.videoUrl);
      return src ? [{ capturedAt: (Number.isFinite(pin.shotAt) ? pin.shotAt : null) || pin.capturedAt || null }] : [];
    },
    /** 최신 촬영 시각(ms) — 없으면 null */
    latestShotAt(pin) {
      let best = null;
      this._shots(pin).forEach((s) => { const t = Number(s && s.capturedAt); if (Number.isFinite(t) && t > 0 && (best == null || t > best)) best = t; });
      return best;
    },

    /** 순수 분류 — 기준 N일 "초과"면 오래됨(정확히 N일 = 최신). */
    classify(pin, now, days) {
      const shots = this._shots(pin);
      if (!shots.length) return "none";
      const t = this.latestShotAt(pin);
      if (t == null) return "unknown";
      const n = Number.isFinite(days) ? days : this.DEFAULT_DAYS;
      return (now - t) > n * this.DAY_MS ? "stale" : "fresh";
    },

    isTarget(pin) { return !!pin && !pin._deleted && (typeof PinSeries === "undefined" || PinSeries.seriesOf(pin) === "content"); },

    /** 순수 집계 — 360 핀만. */
    summarize(pins, now, days) {
      const c = { none: 0, stale: 0, fresh: 0, unknown: 0, total: 0 };
      (pins || []).forEach((p) => { if (!this.isTarget(p)) return; c[this.classify(p, now, days)]++; c.total++; });
      return c;
    },

    /** 구역 집계 — 그 구역 도면이 지금 로드돼 있을 때만(아니면 null = 모름). SoT: Projects.pinsForDeck. */
    deckSummary(deck, now) {
      if (!deck || !deck.deployment_id || String(deck.deployment_id) !== String(State.currentDeploymentId || "")) return null;
      const pins = Projects.pinsForDeck(State.pins || [], deck);
      return this.summarize(pins, now != null ? now : Date.now(), this.staleDays());
    },

    /** 토글 비활성 사유("" = 사용 가능). CHECKER 모드 = 사진 미등록 정책. */
    reason() {
      if (typeof State === "undefined" || !State.fileType) return "도면을 먼저 여세요";
      if (State.mode === "designer" && State.regMode === "checkboard") return "CHECKER 는 사진을 등록하지 않습니다 — 360 모드에서 사용";
      return "";
    },

    toggle(force) {
      const why = this.reason();
      if (why) { try { Prompt.toast && Prompt.toast(why, 3600); } catch (e) {} return false; }
      this.on = force !== undefined ? !!force : !this.on;
      this.refresh();
      return this.on;
    },
    /** 다시 그리기 — 핀 레이어(데코 포함)·트리·전체 포인트 패널 */
    refresh() {
      if (typeof UI !== "undefined") { try { UI.renderPinsOnMap(); } catch (e) {} try { UI.renderTree(); } catch (e) {} }
      if (typeof AllPins !== "undefined" && AllPins.open) { try { AllPins.render(); } catch (e) {} }
    },
    /** 켜져 있어도 CHECKER 로 바뀌면 효력 없음(표시 안 함) — 상태 판정 한 곳 */
    active() { return this.on && !this.reason(); },

    _badge(state) {
      const st = this.STYLE[state];
      const b = document.createElement("span");
      b.className = "cov-badge cov-" + state;
      b.setAttribute("aria-label", "촬영 현황: " + st.label);
      b.title = "촬영 현황: " + st.label;
      b.textContent = st.glyph;
      b.style.cssText = "position:absolute;top:-7px;right:-9px;width:15px;height:15px;display:flex;align-items:center;justify-content:center;" +
        "font:800 10px/1 sans-serif;color:#ffffff;background:" + st.color + ";border:1.5px solid #ffffff;border-radius:" + st.radius + ";" +
        "box-shadow:0 0 0 1px rgba(0,0,0,.35);pointer-events:none;z-index:3";
      return b;
    },

    /** UI.renderPinsOnMap 끝에서 호출 — 핀 데코(링+배지)와 필터 바 토글·범례. 숨김 0(표시만 덧입힘). */
    decorate() {
      if (typeof document === "undefined") return;
      this._renderBar();
      if (!this.active()) return;
      const now = Date.now(), days = this.staleDays();
      const byId = new Map((State.pins || []).map((p) => [String(p.id), p]));
      document.querySelectorAll("#pins-layer .pin-marker").forEach((m) => {
        const pin = byId.get(String(m.dataset.id));
        if (!this.isTarget(pin)) return;
        const state = this.classify(pin, now, days);
        m.dataset.cov = state;
        const col = this.STYLE[state].color;
        m.style.filter = "drop-shadow(0 0 2px " + col + ") drop-shadow(0 0 2px " + col + ")";
        m.appendChild(this._badge(state));
      });
    },

    /** 필터 칩 바와 같은 모바일 판정(style.css .pinfilter-bar 모바일 규칙과 같은 미디어쿼리) */
    MOBILE_MQ: "(max-width:640px), (pointer:coarse)",
    _isMobile() { try { return !!(window.matchMedia && window.matchMedia(this.MOBILE_MQ).matches); } catch (e) { return false; } },

    /** 필터 바(#pin-filter-bar — PinSeries.renderChips 가 매번 다시 그린다) 뒤에 토글 칩 1개를 덧붙이고, 범례는
     *  데스크톱 = 같은 바 안 / 모바일 = 지도 상단 별도 줄(#cov-legend). 🔴 모바일 칩 바는 하단 FAB(?·✉) 바로 아래
     *  한 줄 높이로 설계돼 있어 줄이 늘면 FAB 와 겹친다(실측 375) — 그래서 모바일에서는 바에 토글만 둔다. */
    _renderBar() {
      const host = document.getElementById("pin-filter-bar");
      const oldLegend = document.getElementById("cov-legend");
      if (oldLegend) oldLegend.remove();
      if (!host || host.classList.contains("hidden")) return;
      const old = host.querySelector(".cov-group"); if (old) old.remove();
      const why = this.reason();
      const g = document.createElement("span");
      g.className = "cov-group";
      g.style.cssText = "display:inline-flex;gap:5px;align-items:center;flex-wrap:wrap";
      const t = document.createElement("button");
      t.type = "button";
      t.id = "cov-toggle";
      t.setAttribute("data-help", "coverage");
      t.setAttribute("aria-pressed", this.active() ? "true" : "false");
      t.style.cssText = "padding:4px 9px;border-radius:999px;font:700 11.5px/1.2 sans-serif;cursor:pointer;white-space:nowrap;" +
        (why ? "background:#1e293b;color:#cbd5e1;border:1px dashed #94a3b8"
             : this.active() ? "background:#ffffff;color:#0f172a;border:1px solid #ffffff" : "background:#1e293b;color:#ffffff;border:1px solid #94a3b8");
      t.textContent = why ? "◔ 현황 · 360 전용" : (this.active() ? "◔ 현황 끄기" : "◔ 촬영 현황");
      t.title = why || ("촬영 현황 — 핀별 최신 촬영 시각, 기준 " + this.staleDays() + "일 초과 = 오래됨");
      t.setAttribute("aria-label", why ? "촬영 현황(사용 불가): " + why : "촬영 현황 " + (this.active() ? "끄기" : "켜기"));
      if (why) t.setAttribute("aria-disabled", "true");
      t.addEventListener("click", (e) => { if (e && e.stopPropagation) e.stopPropagation(); this.toggle(); });
      g.appendChild(t);
      host.appendChild(g);
      if (!this.active()) return;
      let legendHost = g;
      if (this._isMobile()) {
        const area = document.getElementById("map-area");
        if (area) {
          const pager = document.getElementById("zone-pager");
          const top = (pager && !pager.classList.contains("hidden") && pager.offsetHeight) ? pager.offsetHeight + 12 : 8;
          legendHost = document.createElement("div");
          legendHost.id = "cov-legend";
          legendHost.setAttribute("role", "note");
          legendHost.setAttribute("aria-label", "촬영 현황 범례");
          legendHost.style.cssText = "position:absolute;top:" + top + "px;left:8px;right:8px;z-index:41;display:flex;gap:5px;flex-wrap:wrap;pointer-events:none";
          area.appendChild(legendHost);
        }
      }
      const now = Date.now(), days = this.staleDays();
      const scope = Projects.pinsForDeck(State.pins || [], Projects.currentDeck || null);
      const c = this.summarize(scope, now, days);
      this.STATES.forEach((s) => {
        const st = this.STYLE[s];
        const chip = document.createElement("span");
        chip.className = "cov-legend cov-legend-" + s;
        chip.style.cssText = "display:inline-flex;gap:4px;align-items:center;padding:3px 7px;border-radius:999px;background:#0f172a;color:#ffffff;font:600 11px/1.2 sans-serif;border:1px solid #475569;white-space:nowrap";
        chip.innerHTML = '<span aria-hidden="true" style="display:inline-flex;width:13px;height:13px;align-items:center;justify-content:center;font:800 9px/1 sans-serif;color:#ffffff;background:' + st.color + ';border:1px solid #ffffff;border-radius:' + st.radius + '">' + st.glyph + "</span>" +
          st.label + " " + c[s] + (s === "stale" ? " (" + days + "일↑)" : "");
        legendHost.appendChild(chip);
      });
      if (legendHost !== g) this._avoidOverlap(legendHost);
    },

    /** 모바일 범례가 지도 위에 떠 있는 다른 컨트롤(예: 번호 대역 선택)에 가리면 그 아래로 내린다(최대 3회·160px).
     *  측정 동안만 pointer-events 를 켠다(elementFromPoint 는 none 인 요소를 건너뛴다) — 평소엔 지도 조작을 막지 않는다. */
    _avoidOverlap(el) {
      try {
        el.style.pointerEvents = "auto";
        let moved = 0;
        for (let i = 0; i < 3; i++) {
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height) break;
          let push = 0;
          [r.left + 6, r.left + r.width / 2, r.right - 6].forEach((x) => {
            [r.top + 3, r.bottom - 3].forEach((y) => {
              const hit = document.elementFromPoint(x, y);
              if (hit && !el.contains(hit)) push = Math.max(push, hit.getBoundingClientRect().bottom - r.top + 4);
            });
          });
          if (push <= 0 || moved + push > 160) break;
          moved += push;
          el.style.top = (parseFloat(el.style.top) || 0) + push + "px";
        }
      } catch (e) {}
      el.style.pointerEvents = "none";
    },

    /** 트리 구역 배지 HTML — 켜져 있고 로드된 구역이며 미촬영/오래됨이 있을 때만. */
    treeBadgeHtml(deck) {
      if (!this.active()) return "";
      const c = this.deckSummary(deck);
      if (!c || (!c.none && !c.stale)) return "";
      const part = (s, n) => n ? '<span style="display:inline-flex;align-items:center;gap:2px">' + this.STYLE[s].glyph + n + "</span>" : "";
      return '<span class="tree-cov-badge" title="촬영 현황 — 미촬영 ' + c.none + " · 오래됨 " + c.stale + '" style="margin-left:4px;display:inline-flex;gap:5px;padding:0 6px;border-radius:8px;background:#7c2d12;color:#ffffff;font-size:10.5px;font-weight:700;line-height:16px">' +
        part("none", c.none) + part("stale", c.stale) + "</span>";
    },

    /** 전체 포인트 패널 요약 한 줄(#allpins-list 앞) — AllPins.render 가 부른다. 꺼져 있으면 지운다. */
    renderAllPinsSummary(scopePins) {
      const list = document.getElementById("allpins-list");
      if (!list || !list.parentNode) return;
      let el = document.getElementById("allpins-cov");
      if (!this.active()) { if (el) el.remove(); return; }
      if (!el) {
        el = document.createElement("div");
        el.id = "allpins-cov";
        el.style.cssText = "margin:6px 10px;padding:7px 10px;border-radius:8px;background:#0f172a;color:#ffffff;font:600 12px/1.4 sans-serif;border:1px solid #475569";
        list.parentNode.insertBefore(el, list);
      }
      const days = this.staleDays();
      const c = this.summarize(scopePins, Date.now(), days);
      el.textContent = "촬영 현황(360 · 이 구역) — ✕미촬영 " + c.none + " · !오래됨 " + c.stale + " · ✓최신 " + c.fresh + " · ?시각 미상 " + c.unknown + " (기준 " + days + "일)";
    },

    /** 화면 폭이 모바일 ↔ 데스크톱으로 바뀌면(회전·창 크기) 범례 위치를 다시 정한다. */
    init() {
      try {
        const mq = window.matchMedia && window.matchMedia(this.MOBILE_MQ);
        if (mq && mq.addEventListener) mq.addEventListener("change", () => { if (this.on) this.refresh(); });
      } catch (e) {}
    }
  };
