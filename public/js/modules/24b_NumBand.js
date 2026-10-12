  /* ══════════════════════════════════════════
     NUM BAND — 번호 대역 메뉴 [WO 20261001-startno]
     ------------------------------------------------------------------
     마스터: "체크나 360 모두 시작번호를 세팅하는 걸 메뉴를 직관적으로" ·
             "0~100, 101~200, 201~300 … 100 단위" · (확정) 멤버별 자동 배정 + 본인 변경, 서버 저장.
     🔴 SoT
       - 대역 배정: 서버 GET/PUT /api/projects/:id/bands · /members/me/band (project_members.num_band)
       - 대역·다음 번호 계산: PinSeries.bandRange / nextInBand / bandUsage (01b)
       - 내 대역·시작값: App._numBand / _checkboardStart / _setNumBand / _setCheckboardStart (20_App)
       이 모듈은 받아서 보여주고, 고른 값을 위 함수에 넘길 뿐이다(자체 계산·자체 저장 없음).
     상단 [번호 대역 ▾](#btn-numband) · 세팅 모달 [#btn-settings-numband] 둘 다 같은 시트(#numband-sheet)를 연다
     (구 상단 `시작 #` 입력·세팅 시작번호 입력 → 이 시트 하나로 일원화).
  ══════════════════════════════════════════ */
  const NumBand = {
    _data: null,        // 서버 대역표 { band_size, me:{email,band,owner}, bands:[{band,email,name,owner}] }
    _pid: null,         // _data 가 속한 프로젝트
    _loading: null,
    _opener: null,
    _status: "",

    init() {
      const bind = (id) => {
        const b = document.getElementById(id);
        if (b) b.addEventListener("click", () => this.open(b));
      };
      bind("btn-numband");
      bind("btn-settings-numband");
      this.render();
    },

    _series() { return (typeof State !== "undefined" && State.regMode === "photo") ? "content" : "checkboard"; },
    _author() { return (typeof App !== "undefined" && App._pinAuthor) ? App._pinAuthor() : null; },
    _page() { return (typeof State !== "undefined" && State.pdfPage) || 1; },
    _hasDrawing() { return (typeof State !== "undefined") && !!(State.pdfDoc || (State.viewerPages && State.viewerPages.length)); },
    _esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch])); },
    _who(e) {
      const em = String(e && e.email || "");
      return (e && e.name) || (em.indexOf("@") > 0 ? em.slice(0, em.indexOf("@")) : em) || "?";
    },

    /** 서버 대역표 갱신 — 서버가 준 내 대역이 캐시보다 우선(다른 기기에서 바꾼 값 반영). */
    async refresh() {
      const pid = (typeof State !== "undefined" && State.currentProjectId) || null;
      if (!pid || typeof fetch === "undefined" || typeof Auth === "undefined" || !Auth.user) return null;
      // [WO 20261012-viewlink] 번호 대역 = 핀을 만드는 사람(멤버)의 것 — 열람 링크 세션은 조회하지 않는다(종전: 매 진입 403 2회)
      if (Auth.readonly) return null;
      if (this._loading && this._pid === pid) return this._loading;
      this._pid = pid;
      this._loading = (async () => {
        try {
          const r = await fetch("/api/projects/" + encodeURIComponent(pid) + "/bands", { headers: Auth.headers() });
          if (!r.ok) { this._status = r.status === 403 ? "이 프로젝트 멤버가 아니라 서버 대역이 없습니다 — 이 기기에만 기억합니다" : ("대역 정보를 불러오지 못했습니다(" + r.status + ")"); return null; }
          const j = await r.json();
          if (this._pid !== pid) return null;
          this._data = j;
          this._status = "";
          if (j && j.me && j.me.band) PinSeries.setMyBand(this._author(), j.me.band);
          return j;
        } catch (e) { this._status = "오프라인 — 마지막으로 받은 대역을 씁니다"; return null; }
        finally { this._loading = null; this.render(); }
      })();
      return this._loading;
    },

    /** 대역 변경 서버 저장(App._setNumBand 가 호출). 실패를 숨기지 않는다. */
    async persistBand(k) {
      const pid = (typeof State !== "undefined" && State.currentProjectId) || null;
      if (!pid || typeof fetch === "undefined" || typeof Auth === "undefined" || !Auth.user) { this._status = "프로젝트 밖 — 이 기기에만 기억합니다"; return false; }
      try {
        const r = await fetch("/api/projects/" + encodeURIComponent(pid) + "/members/me/band", {
          method: "PUT", headers: Auth.headers(), body: JSON.stringify({ band: k })
        });
        if (!r.ok) { this._status = "서버 저장 실패(" + r.status + ") — 이 기기에만 적용됐습니다"; this.render(); return false; }
        this._data = await r.json();
        this._pid = pid;
        this._status = "저장됨 — 다른 기기에서도 같은 대역을 씁니다";
        this.render();
        return true;
      } catch (e) { this._status = "오프라인 — 이 기기에만 적용됐습니다(연결 후 다시 고르세요)"; this.render(); return false; }
    },

    /** 대역별 표시 행 — 서버 배정 + 실제 핀(현재 모드 계열·현재 페이지) 합집합 + 다음 빈 대역 1개. */
    rows() {
      const series = this._series();
      const me = String(this._author() || "").toLowerCase();
      const mine = (typeof App !== "undefined" && App._numBand) ? App._numBand() : 1;
      const usage = PinSeries.bandUsage((typeof State !== "undefined" && State.pins) || [], this._page(), series);
      const assigned = new Map();   // band → [{email,name,owner}]
      ((this._data && this._data.bands) || []).forEach((b) => {
        if (!assigned.has(b.band)) assigned.set(b.band, []);
        assigned.get(b.band).push(b);
      });
      const set = new Set([mine]);
      assigned.forEach((_, k) => set.add(k));
      usage.forEach((_, k) => set.add(k));
      let free = 1;
      while (set.has(free)) free++;
      set.add(free);
      return Array.from(set).sort((a, b) => a - b).map((k) => {
        const users = (assigned.get(k) || []).slice();
        const u = usage.get(k);
        const others = users.filter((x) => String(x.email || "").toLowerCase() !== me);
        // 배정이 없는 대역은 실제로 찍은 작성자로 표시(서버 배정 + 실제 핀 번호 함께)
        if (!users.length && u) u.authors.forEach((n, a) => { if (a) users.push({ email: a, name: "" }); });
        const pinOthers = u ? Array.from(u.authors.keys()).filter((a) => a && String(a).toLowerCase() !== me) : [];
        return {
          band: k, label: PinSeries.bandLabel(k), mine: k === mine, free: k === free && !u && !users.length,
          users: users, count: u ? u.count : 0, taken: others.length > 0 || pinOthers.length > 0,
          takenBy: others[0] || (pinOthers[0] ? { email: pinOthers[0] } : null)
        };
      });
    },

    /** after 보다 큰 대역 중 남이 안 쓰는 첫 대역(대역 가득 → 확인창 제안값). */
    nextFreeBand(after) {
      const taken = new Set(this.rows().filter((r) => r.taken || (r.count && !r.mine)).map((r) => r.band));
      let k = (after || 0) + 1;
      while (taken.has(k)) k++;
      return k;
    },

    /** 내 대역 요약 — 상단·세팅 버튼 문구와 시트 미리보기의 공용 값. */
    summary() {
      const series = this._series();
      const band = (typeof App !== "undefined" && App._numBand) ? App._numBand() : 1;
      const start = (typeof App !== "undefined" && App._checkboardStart) ? App._checkboardStart(this._page(), series) : PinSeries.bandRange(band).lo;
      const nx = PinSeries.nextInBand((typeof State !== "undefined" && State.pins) || [], this._page(), series, band, start);
      return { series: series, band: band, label: PinSeries.bandLabel(band), nx: nx, next: nx.full ? null : PinSeries.formatNo(nx.no, series) };
    },

    render() {
      if (typeof document === "undefined") return;
      const pid = (typeof State !== "undefined" && State.currentProjectId) || null;
      if (pid && pid !== this._pid && !this._loading) this.refresh();
      const s = this.summary();
      const txt = "대역 " + s.label + (this._hasDrawing() ? (" · " + (s.next ? "다음 " + s.next : "가득")) : "");
      const t = document.getElementById("numband-btn-text");
      if (t) t.textContent = txt;
      const sb = document.getElementById("btn-settings-numband");
      if (sb) sb.textContent = txt;
      if (this._isOpen()) this._renderSheet();
    },

    _isOpen() { const m = document.getElementById("numband-sheet"); return !!m && !m.classList.contains("hidden"); },

    _ensureSheet() {
      let m = document.getElementById("numband-sheet");
      if (m) return m;
      m = document.createElement("div");
      m.id = "numband-sheet";
      m.className = "numband-sheet hidden";
      m.innerHTML =
        '<div class="numband-backdrop" data-numband-close></div>' +
        '<div class="numband-panel" role="dialog" aria-modal="true" aria-labelledby="numband-title">' +
          '<div class="numband-head"><h3 id="numband-title" class="numband-title">번호 대역</h3>' +
          '<span id="numband-mode" class="numband-mode"></span>' +
          '<button type="button" class="numband-x" data-numband-close aria-label="닫기">&times;</button></div>' +
          '<p class="numband-sub">100번 단위로 사람마다 번호대를 나눠 씁니다. 대역은 CHECKER·360 공통, 번호는 모드별로 따로 늘어납니다.</p>' +
          '<div id="numband-chips" class="numband-chips" role="group" aria-label="번호 대역 선택"></div>' +
          '<div id="numband-next" class="numband-next" aria-live="polite"></div>' +
          '<details class="numband-adv"><summary>직접 입력(고급)</summary>' +
            '<div class="numband-adv-row"><label for="numband-start" class="numband-adv-label">시작 번호</label>' +
            '<input id="numband-start" class="numband-start" type="number" min="1" step="1" inputmode="numeric" />' +
            '<button id="btn-numband-start" type="button" class="numband-apply">적용</button></div>' +
            '<p class="numband-hint">입력한 번호가 속한 대역으로 자동으로 바뀝니다(예: 150 → 101–200 대역, 150부터).</p>' +
          '</details>' +
          '<p id="numband-status" class="numband-status" aria-live="polite"></p>' +
        '</div>';
      document.body.appendChild(m);
      m.addEventListener("click", (e) => {
        const t = e.target;
        if (t && t.closest && t.closest("[data-numband-close]")) { this.close(); return; }
        const chip = t && t.closest ? t.closest("[data-band]") : null;
        if (chip) this.choose(parseInt(chip.getAttribute("data-band"), 10));
      });
      m.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); this.close(); } });
      const apply = () => {
        const inp = document.getElementById("numband-start");
        if (!inp || inp.value === "") return;
        const series = this._series();
        const n = App._setCheckboardStart(this._page(), inp.value, series);
        this._status = PinSeries.LABELS[series] + " 다음 번호를 " + PinSeries.formatNo(n, series) + " 부터 — 대역 " + PinSeries.bandLabel(PinSeries.bandOf(n));
        this.render();
      };
      m.querySelector("#btn-numband-start").addEventListener("click", apply);
      m.querySelector("#numband-start").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); apply(); } });
      return m;
    },

    _renderSheet() {
      const s = this.summary();
      const mode = document.getElementById("numband-mode");
      if (mode) { mode.textContent = PinSeries.LABELS[s.series]; mode.className = "numband-mode nb-" + s.series; }
      const chips = document.getElementById("numband-chips");
      if (chips) {
        chips.innerHTML = this.rows().map((r) => {
          const who = r.users.length ? (this._who(r.users[0]) + (r.users.length > 1 ? " 외 " + (r.users.length - 1) + "명" : "")) : (r.free ? "비어 있음" : "");
          const meta = [who, r.count ? (r.count + "개") : (r.free ? "" : "0개")].filter(Boolean).join(" ");
          return '<button type="button" class="numband-chip' + (r.mine ? " is-mine" : "") + (r.taken && !r.mine ? " is-taken" : "") +
            '" data-band="' + r.band + '" aria-pressed="' + (r.mine ? "true" : "false") + '">' +
            '<span class="numband-chip-range">' + this._esc(r.label) + '</span>' +
            '<span class="numband-chip-meta">' + this._esc(meta) + '</span>' +
            (r.mine ? '<span class="numband-chip-mine">내 대역</span>' : "") + '</button>';
        }).join("");
      }
      const nx = document.getElementById("numband-next");
      if (nx) {
        nx.textContent = !this._hasDrawing() ? ("대역 " + s.label + " — 도면을 열면 다음 번호가 보입니다")
          : (s.next ? ("다음 핀 = " + s.next) : ("대역 " + s.label + " 이 가득 찼습니다 — 다른 대역을 고르세요"));
        nx.classList.toggle("is-full", !s.next && this._hasDrawing());
      }
      const inp = document.getElementById("numband-start");
      if (inp && document.activeElement !== inp) inp.value = String((typeof App !== "undefined" && App._checkboardStart) ? App._checkboardStart(this._page(), s.series) : 1);
      const st = document.getElementById("numband-status");
      if (st) st.textContent = this._status || "";
    },

    open(opener) {
      const m = this._ensureSheet();
      this._opener = opener || null;
      this._status = this._status || "";
      m.classList.remove("hidden");
      const nb = document.getElementById("btn-numband");
      if (nb) nb.setAttribute("aria-expanded", "true");
      this._renderSheet();
      this.refresh();
      const first = m.querySelector(".numband-chip.is-mine") || m.querySelector(".numband-chip");
      if (first && first.focus) first.focus();
    },

    close() {
      const m = document.getElementById("numband-sheet");
      if (m) m.classList.add("hidden");
      const nb = document.getElementById("btn-numband");
      if (nb) nb.setAttribute("aria-expanded", "false");
      if (this._opener && this._opener.focus) { try { this._opener.focus(); } catch (e) {} }
    },

    /** 칩 선택 — 남이 쓰는 대역은 확인창 후 허용(같은 대역 안에서 이어 씀). */
    async choose(k) {
      if (!Number.isFinite(k) || k < 1) return;
      const row = this.rows().find((r) => r.band === k);
      if (row && row.mine) return;
      if (row && row.taken && row.takenBy) {
        const ok = await Prompt.confirm("번호 대역", PinSeries.bandLabel(k) + " 대역은 " + this._who(row.takenBy) + " 님이 쓰고 있습니다. 같은 대역 안에서 이어서 번호를 매깁니다 — 이 대역을 쓸까요?");
        if (!ok) return;
      }
      App._setNumBand(k);
      this._status = "대역 " + PinSeries.bandLabel(k) + " 선택 — 저장 중…";
      this.render();
    }
  };
