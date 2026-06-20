  const ProjectHub = {
    list: [],
    _loaded: false,

    init() {
      const $ = (id) => document.getElementById(id);
      $("hub-btn-new") && $("hub-btn-new").addEventListener("click", () => this.createProject());
      // hub 인증바 버튼들 (홈 인증바와 동일 동작)
      $("hub-btn-signout") && $("hub-btn-signout").addEventListener("click", () => Auth.signOut());
      $("hub-btn-manage-designers") && $("hub-btn-manage-designers").addEventListener("click", () => Designers.open());
    },

    /** 화면 진입 시 호출 — 목록 로드 + 렌더 */
    async open() {
      UI.showScreen("screen-projects");
      Auth._applyUi();          // 인증바 상태 동기화 (hub 슬롯 포함)
      Auth._renderHubSignin();  // 미로그인 시 hub 로그인 버튼 렌더
      await this.load();
    },

    async load() {
      try {
        const r = await fetch("/api/projects");
        const { data } = await r.json();
        this.list = data || [];
      } catch (e) { this.list = []; }
      this._loaded = true;
      this.render();
    },

    /** Auth 상태 변경 시 (로그인/로그아웃) 다시 그려 +새프로젝트·편집 버튼 토글 */
    refreshIfVisible() {
      const sc = document.getElementById("screen-projects");
      if (sc && sc.classList.contains("active")) {
        this.render();
        Auth._renderHubSignin();
      }
    },

    render() {
      const grid  = document.getElementById("hub-grid");
      const empty = document.getElementById("hub-empty");
      const btnNew = document.getElementById("hub-btn-new");
      const emptyHint = document.getElementById("hub-empty-hint");
      if (!grid) return;

      const isDesigner = Auth.isDesigner;
      // +새 프로젝트 버튼: 디자이너만
      if (btnNew) btnNew.classList.toggle("hidden", !isDesigner);

      grid.innerHTML = "";

      if (!this.list.length) {
        empty && empty.classList.remove("hidden");
        if (emptyHint) emptyHint.textContent = isDesigner
          ? "우측 상단 '+ 새 프로젝트'로 첫 프로젝트를 만들어 보세요."
          : "설계자로 로그인하면 새 프로젝트를 만들 수 있습니다.";
        return;
      }
      empty && empty.classList.add("hidden");

      this.list.forEach((p) => {
        const card = document.createElement("div");
        card.className = "hub-card";
        card.setAttribute("role", "listitem");
        card.tabIndex = 0;
        const deckTxt = (p.deck_count != null) ? (p.deck_count + " DECKS") : "";
        const dateTxt = this._fmtDate(p.created_at);
        const code = "SS-" + String(Math.abs(this._hash(p.id || p.name)) % 9000 + 1000);
        card.innerHTML =
          '<div class="hub-card-thumb">' +
            '<div class="hub-thumb-grid"></div>' +
            '<div class="hub-thumb-scan"></div>' +
            '<svg class="hub-thumb-ship" viewBox="0 0 132 72" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
              '<defs>' +
                '<linearGradient id="shipHull" x1="0" y1="0" x2="0" y2="1">' +
                  '<stop offset="0" stop-color="#7fe3ff"/><stop offset="1" stop-color="#1f7fd6"/>' +
                '</linearGradient>' +
                '<linearGradient id="shipDeck" x1="0" y1="0" x2="1" y2="0">' +
                  '<stop offset="0" stop-color="#aef0ff"/><stop offset="1" stop-color="#3da3e6"/>' +
                '</linearGradient>' +
              '</defs>' +
              /* 흘수선(waterline) 치수 보조선 */
              '<g class="ship-dim" stroke="#3da3e6" stroke-width=".7" opacity=".45">' +
                '<line x1="8" y1="60" x2="8" y2="66"/><line x1="120" y1="60" x2="120" y2="66"/>' +
                '<line x1="8" y1="63" x2="120" y2="63" stroke-dasharray="3 3"/>' +
              '</g>' +
              /* 선체(hull) — 입체 그라데이션 */
              '<path d="M10 42 L116 42 L106 56 L22 56 Z" fill="url(#shipHull)" stroke="#0d5ba8" stroke-width="1.4"/>' +
              '<line x1="14" y1="49" x2="112" y2="49" stroke="#0d5ba8" stroke-width=".8" opacity=".5"/>' +
              /* 메인 갑판 구조물(데크하우스) */
              '<path d="M24 42 L24 26 L84 26 L84 42 Z" fill="url(#shipDeck)" stroke="#0d5ba8" stroke-width="1.3"/>' +
              /* 선교(bridge) */
              '<path d="M32 26 L32 16 L62 16 L62 26 Z" fill="#dff6ff" stroke="#0d5ba8" stroke-width="1.2"/>' +
              /* 선교 창문 */
              '<g stroke="#0d5ba8" stroke-width="1.1">' +
                '<line x1="38" y1="21" x2="42" y2="21"/><line x1="47" y1="21" x2="51" y2="21"/><line x1="56" y1="21" x2="58" y2="21"/>' +
              '</g>' +
              /* 크레인/마스트 */
              '<g stroke="#0d5ba8" stroke-width="1.3">' +
                '<line x1="94" y1="42" x2="94" y2="28"/><line x1="94" y1="28" x2="108" y2="32"/><line x1="94" y1="31" x2="100" y2="42"/>' +
              '</g>' +
              /* 연돌(funnel) */
              '<rect x="70" y="20" width="9" height="6" rx="1.5" fill="#7fe3ff" stroke="#0d5ba8" stroke-width="1.1"/>' +
              /* 파도(waterline ripple) */
              '<path d="M4 60 q7 4 14 0 q7 -4 14 0 q7 4 14 0 q7 -4 14 0 q7 4 14 0 q7 -4 14 0 q7 4 14 0 q7 -4 14 0" stroke="url(#shipDeck)" stroke-width="1.3" opacity=".55"/>' +
            '</svg>' +
            '<span class="hub-thumb-code">' + code + '</span>' +
          '</div>' +
          '<div class="hub-card-body">' +
            '<div class="hub-card-name">' + UI.escapeHtml(p.name) + '</div>' +
            '<div class="hub-card-meta">' +
              (deckTxt ? '<span class="hub-card-decks">' + deckTxt + '</span>' : '') +
              (dateTxt ? '<span class="hub-card-date">' + dateTxt + '</span>' : '') +
            '</div>' +
          '</div>' +
          (isDesigner
            ? '<div class="hub-card-actions">' +
                '<button class="hub-card-act hub-card-dl" title="오프라인 다운로드" data-act="dl" aria-label="오프라인 다운로드">' +
                  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>' +
                '</button>' +
                '<button class="hub-card-act hub-card-del" title="삭제" data-act="del" aria-label="삭제">' +
                  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>' +
                '</button>' +
              '</div>'
            : '');

        // 카드 클릭 → 진입
        card.addEventListener("click", (e) => {
          if (e.target.closest("[data-act]")) return; // 액션 버튼은 제외
          this.openProject(p);
        });
        card.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this.openProject(p); }
        });
        // 삭제 버튼
        const del = card.querySelector('[data-act="del"]');
        if (del) del.addEventListener("click", (e) => { e.stopPropagation(); this.deleteProject(p); });

        // [오프라인 작업지시서 ❷] 오프라인 다운로드 버튼
        const dl = card.querySelector('[data-act="dl"]');
        if (dl) dl.addEventListener("click", async (e) => {
          e.stopPropagation();
          if (typeof OfflineBundle === "undefined") { Prompt.toast("오프라인 모듈 미로드"); return; }
          const orig = dl.innerHTML;
          dl.disabled = true; dl.classList.add("busy");
          try {
            const m = await OfflineBundle.download(p.id, (done, total, label) => {
              dl.setAttribute("title", "다운로드 " + done + "/" + total + " · " + label);
            });
            const v = await OfflineBundle.verify(p.id);
            if (v.ok) Prompt.toast("✅ 오프라인 준비 완료 — 도면 " + m.deployments + "개 · 3D " + m.panos + "개");
            else Prompt.toast("⚠️ 일부 누락: " + (v.missing || []).length + "건 — 다시 시도하세요");
          } catch (err) { Prompt.toast("❌ " + (err && err.message ? err.message : "다운로드 실패")); }
          finally { dl.disabled = false; dl.classList.remove("busy"); dl.innerHTML = orig; dl.setAttribute("title", "오프라인 다운로드"); }
        });

        grid.appendChild(card);
      });

      // 디자이너면 "+새 프로젝트" 카드도 그리드 맨 앞에 추가
      if (isDesigner) {
        const add = document.createElement("div");
        add.className = "hub-card hub-card-add";
        add.tabIndex = 0;
        add.setAttribute("role", "listitem");
        add.innerHTML = '<div class="hub-card-add-plus">+</div><div class="hub-card-add-label">새 프로젝트</div>';
        const go = () => this.createProject();
        add.addEventListener("click", go);
        add.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
        grid.insertBefore(add, grid.firstChild);
      }
    },

    /** 프로젝트 진입: 디자이너면 편집, 아니면 뷰어 */
    async openProject(p) {
      // 선택 프로젝트를 Projects 모듈과 공유 (작업화면 사이드바 동기화용)
      Projects.list = this.list;
      Projects.currentProject = p;
      State.currentProjectId = p.id;
      State.currentProjectName = p.name;
      // ★ 회귀 방지: 설계자 토큰이 있는데 권한 확인(refresh)이 아직 끝나지 않아
      //   isDesigner가 false인 채로 카드를 누르면 뷰어로 진입 → "PDF 업로드가 안 된다"는
      //   회귀 느낌을 준다. 토큰이 있으면 권한 재확인을 한 번 await 한 뒤 모드를 결정한다.
      if (!Auth.isDesigner && Auth.idToken) {
        try { await Auth.refresh(); } catch (e) {}
      }
      if (Auth.isDesigner) {
        App.openApp("designer", { project: p });
      } else {
        App.openApp("viewer", { project: p });
      }
    },

    async createProject() {
      if (!Auth.isDesigner) { Auth.requireDesigner(() => this.createProject()); return; }
      const res = await Prompt.ask({ title: "프로젝트 생성", sub: "새 프로젝트 이름을 입력하세요 (예: ○○호 검사)", placeholder: "프로젝트 이름" });
      if (!res || !res.value) return;
      try {
        const r = await fetch("/api/projects", { method: "POST", headers: Auth.headers(), body: JSON.stringify({ name: res.value }) });
        const p = await r.json();
        if (!r.ok) { alert(p.error || "생성 실패(권한 필요)"); return; }
        await this.load();
      } catch (e) { alert("네트워크 오류"); }
    },

    async deleteProject(p) {
      if (!Auth.isDesigner) return;
      if (!confirm("'" + p.name + "' 프로젝트와 모든 데크를 삭제할까요?")) return;
      try {
        await fetch("/api/projects/" + p.id, { method: "DELETE", headers: Auth.headers() });
        await this.load();
      } catch (e) {}
    },

    _fmtDate(v) {
      if (v == null) return "";
      const n = (typeof v === "number") ? v : Date.parse(v);
      if (!Number.isFinite(n)) return "";
      const d = new Date(n);
      const p = (x) => String(x).padStart(2, "0");
      return d.getFullYear() + "." + p(d.getMonth() + 1) + "." + p(d.getDate());
    },

    /** 프로젝트 식별 코드(SS-####) 생성용 간이 해시 */
    _hash(str) {
      str = String(str || "");
      let h = 0;
      for (let i = 0; i < str.length; i++) { h = ((h << 5) - h + str.charCodeAt(i)) | 0; }
      return h;
    }
  };

  /* ══════════════════════════════════════════
     NOTES ── 이슈/필드노트 협업 (핀 단위 코멘트 스레드)
       · 파노라마 우측 패널에서 핀별 이슈를 작성/상태관리
       · 상태: open(미해결) / progress(진행) / done(완료)
       · 도면 핀 + 핀 리스트에 미해결 카운트 뱃지 표시
  ══════════════════════════════════════════ */