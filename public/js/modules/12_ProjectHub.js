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
            '<svg class="hub-thumb-ship" viewBox="0 0 120 64" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
              '<path d="M10 40 L100 40 L92 52 L20 52 Z"/>' +
              '<path d="M22 40 L22 26 L74 26 L74 40"/>' +
              '<path d="M30 26 L30 18 L60 18 L60 26"/>' +
              '<line x1="36" y1="22" x2="40" y2="22"/><line x1="46" y1="22" x2="50" y2="22"/>' +
              '<line x1="80" y1="40" x2="80" y2="30"/><line x1="80" y1="30" x2="92" y2="32"/>' +
              '<path d="M6 46 q6 4 12 0 q6 -4 12 0 q6 4 12 0 q6 -4 12 0 q6 4 12 0 q6 -4 12 0 q6 4 12 0" opacity=".4"/>' +
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