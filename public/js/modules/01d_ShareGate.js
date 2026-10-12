  /* ══════════════════════════════════════════════════════════════════
     [P63] ShareGate — 공유 링크 진입 시 "누구인지 남기고" 들어오게 하는 게이트

     마스터 확정(2026-09-21): "1단계 = 접속 기록 / 차단은 초대 계정" → "좋아 그렇게 해. 초대코드"
       [회사명][이름][초대코드] → 코드 유효면 열람 + 기록 / 무효면 거부 + 재요청처 안내

     🔴 열쇠는 **초대코드 하나**다. 회사명·이름은 자기 신고라 신뢰하지 않고 기록만 한다
        (대조할 명단이 DB 에 없다 — 없는 대조를 흉내내면 거짓 보안이 된다).
     🔴 차단의 최종 방어선은 이 모달이 아니라 **서버 미들웨어**다(src/index.tsx 의 게이트 가드).
        여기는 "UI 를 가린다"가 아니라 "통행증을 받아온다"가 역할이다.
     🔴 마스터 "그 링크가 유출된다면?" → 링크만 유출되면 여기서 막힌다.
        코드까지 유출되면 폐기(revoke)·만료·접속기록으로 대응한다(서버 3종 모두 구현).
  ══════════════════════════════════════════════════════════════════ */
  const ShareGate = {
    /** 🔴 사용자에게 보여줄 문의 주소. 서버 SUPPORT_CONTACT_EMAIL 과 같은 값이어야 한다.
     *  개발 관리자 gmail 주소는 어떤 화면에도 쓰지 않는다(마스터 확정). */
    CONTACT: "designsir@seastargo.com",
    /** 통행증 보관 키 — 프로젝트별로 따로 둔다(한 브라우저가 여러 현장을 볼 수 있다). */
    _passKey(pid) { return "wm_share_pass_" + pid; },

    ctx: null,        // { t } 또는 { d } — 어느 링크로 들어왔는지
    project: null,
    deploymentId: null,

    /** 저장해 둔 통행증 꺼내기(만료 지난 건 버린다). */
    storedPass(pid) {
      try {
        const raw = localStorage.getItem(this._passKey(pid));
        if (!raw) return null;
        const j = JSON.parse(raw);
        if (!j || !j.token || (j.exp && j.exp < Date.now())) { localStorage.removeItem(this._passKey(pid)); return null; }
        return j.token;
      } catch (e) { return null; }
    },
    savePass(pid, token, exp) {
      try { localStorage.setItem(this._passKey(pid), JSON.stringify({ token, exp })); } catch (e) {}
    },

    /** 통행증을 현재 세션 토큰으로 승격. 🔴 서버가 kind='viewer' 로 강제 서명하므로 쓰기 권한은 생기지 않는다. */
    _useToken(token) {
      if (!token || typeof Auth === "undefined") return;
      Auth.idToken = token;
      try { sessionStorage.setItem("wm_id_token", token); } catch (e) {}
      // [WO 20261009-readacl] 통행증도 이 링크 전용 — 토큰-링크 짝 기록(22_Auth 와 같은 키)
      if (typeof Auth !== "undefined" && Auth._bindViewToken) Auth._bindViewToken();
    },

    /** 게이트 상태 조회. 반환 null = 링크 자체가 유효하지 않음. */
    async check(ctx) {
      this.ctx = ctx;
      const q = ctx.t ? ("t=" + encodeURIComponent(ctx.t)) : ("d=" + encodeURIComponent(ctx.d || ""));
      try {
        const r = await fetch("/api/share-gate?" + q, { headers: (typeof Auth !== "undefined" && Auth.headers) ? Auth.headers() : {} });
        if (!r.ok) return null;
        const j = await r.json();
        if (!j || !j.matched) return null;
        this.project = j.project || null;
        this.deploymentId = j.deployment_id || null;
        return j;
      } catch (e) { return null; }   // 오프라인 → 정직하게 실패(통과시키지 않는다)
    },

    /** 🔴 진입 지점: 필요하면 통행증을 확보한다. true = 열람 가능. */
    async ensure(ctx) {
      // ① 저장된 통행증이 있으면 먼저 제시한다(요구 11: 재입력 없이 계속 열람)
      let info = await this.check(ctx);
      // 🔴 프로젝트를 특정할 수 없으면(구 배포본에 decks 행이 없는 등) 게이트를 걸 수 없다.
      //   서버 가드도 같은 조건에서 통과시킨다 — 클라가 더 엄격하면 **레거시 `?d=` 링크만 죽는다**.
      //   차단의 정본은 어차피 서버이므로 여기서 더 막아도 보안은 늘지 않고 회귀만 생긴다.
      if (!info) return true;
      if (!info.gated) return true;                    // 코드 미발급 프로젝트 = 게이트 꺼짐
      if (info.passed) return true;
      const saved = this.storedPass(info.project.id);
      if (saved) {
        this._useToken(saved);
        if (typeof Auth !== "undefined" && Auth.refresh) { try { await Auth.refresh(); } catch (e) {} }
        info = await this.check(ctx);
        if (info && info.passed) return true;
        try { localStorage.removeItem(this._passKey(ctx._pid || (this.project && this.project.id))); } catch (e) {}
      }
      // ② 입력 화면
      return await this.prompt();
    },

    /** 코드 입력 모달. 통과할 때까지(또는 포기할 때까지) 떠 있는다 — 열람 전에 반드시 지난다. */
    prompt() {
      const $ = (id) => document.getElementById(id);
      const modal = $("share-gate-modal");
      if (!modal) return Promise.resolve(false);
      const nameEl = $("sg-proj-name");
      if (nameEl) nameEl.textContent = "";   // [WO 20261012-viewlink] 공개 응답엔 프로젝트 이름이 없다(비식별)
      const note = $("sg-contact-note");
      if (note) note.textContent = "코드를 못 받으셨나요? " + this.CONTACT + " 으로 링크를 다시 요청하세요.";
      const err = $("sg-error");
      const show = (msg) => { if (err) { err.textContent = msg; err.classList.remove("hidden"); } };
      const hideErr = () => { if (err) err.classList.add("hidden"); };
      // 🔴 .admin-gate 는 `hidden` 을 빼는 것만으로는 보이지 않는다 — style.css:558 에서
      //   opacity:0 · pointer-events:none 이고 `.on` 이 붙어야 보이고 클릭된다.
      //   (라이브에서 실제로 모달이 뜼긴 했는데 버튼이 안 눌렸다 — 기존 모달들과 동일 패턴을 따른다)
      modal.classList.remove("hidden");
      requestAnimationFrame(() => modal.classList.add("on"));
      const company = $("sg-company"), person = $("sg-name"), code = $("sg-code"), btn = $("sg-submit");
      try { if (company) company.value = localStorage.getItem("wm_share_company") || ""; } catch (e) {}
      try { if (person) person.value = localStorage.getItem("wm_share_person") || ""; } catch (e) {}
      if (company) company.focus();

      return new Promise((resolve) => {
        const submit = async () => {
          hideErr();
          const body = {
            company: (company && company.value || "").trim(),
            name: (person && person.value || "").trim(),
            code: (code && code.value || "").trim(),
          };
          if (this.ctx && this.ctx.t) body.t = this.ctx.t; else if (this.ctx) body.d = this.ctx.d;
          if (!body.company || !body.name) { show("회사명과 이름을 입력하세요."); return; }
          if (!body.code) { show("초대코드를 입력하세요."); return; }
          if (btn) { btn.disabled = true; btn.textContent = "확인 중…"; }
          let j = null;
          try {
            const r = await fetch("/api/share/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
            j = await r.json().catch(() => null);
            if (!r.ok || !j || !j.ok) {
              // 🔴 거부 사유와 **재요청처**를 반드시 보여준다(조용한 실패 금지).
              show((j && j.message) || ("초대코드가 올바르지 않습니다. " + this.CONTACT + " 으로 링크를 다시 요청하세요."));
              return;
            }
          } catch (e) {
            show("네트워크 오류입니다. 잠시 후 다시 시도하세요."); return;
          } finally {
            if (btn) { btn.disabled = false; btn.textContent = "열람하기"; }
          }
          try { localStorage.setItem("wm_share_company", body.company); localStorage.setItem("wm_share_person", body.name); } catch (e) {}
          this.savePass(j.project.id, j.token, j.exp);
          this._useToken(j.token);
          if (typeof Auth !== "undefined" && Auth.refresh) { try { await Auth.refresh(); } catch (e) {} }
          modal.classList.remove("on");
          modal.classList.add("hidden");
          resolve(true);
        };
        if (btn) btn.addEventListener("click", submit);
        [company, person, code].forEach((el) => {
          if (el) el.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } });
        });
      });
    },

    /** [WO 20261012-viewlink] 🔴 배포가 중단된 링크(디자이너가 배포 취소 · 링크 폐기) — 화면 전체를 덮고 데이터·프로젝트 정보를 지운다.
     *  이미 열려 있던 열람 화면이 다음 요청에서 410 을 받으면 여기로 온다(새로 여는 링크는 서버가 410 화면을 바로 준다). */
    showWithdrawn() {
      try {
        if (typeof State !== "undefined") { State.pins = []; State.zones = []; State.annotations = []; State.viewerPages = []; }
        if (typeof PanoViewer !== "undefined" && PanoViewer.open && PanoViewer.close) PanoViewer.close();
        if (typeof Projects !== "undefined") { Projects.decks = []; Projects.currentProject = null; Projects.currentDeck = null; }
        ["screen-app", "screen-home", "screen-projects"].forEach((id) => { const e = document.getElementById(id); if (e) e.classList.remove("active"); });
        const img = document.getElementById("map-image"); if (img) img.removeAttribute("src");
      } catch (e) {}
      let ov = document.getElementById("view-withdrawn");
      if (!ov) {
        ov = document.createElement("div");
        ov.id = "view-withdrawn";
        ov.setAttribute("role", "alert");
        ov.setAttribute("data-view-withdrawn", "1");
        // 대비: #e6edf7 on #0b1220 = 16.0:1 · #9fb0c9 on #0b1220 = 8.6:1 (서버 410 화면과 같은 팔레트)
        ov.style.cssText = "position:fixed;inset:0;z-index:2147483000;background:#0b1220;color:#e6edf7;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;font-family:Pretendard,system-ui,sans-serif";
        ov.innerHTML = '<div style="max-width:520px"><h1 style="font-size:20px;margin:0 0 12px;color:#e6edf7">배포가 중단된 링크입니다</h1>' +
          '<p style="font-size:14px;line-height:1.7;margin:0;color:#9fb0c9">이 링크의 열람이 중단되었습니다. 링크를 보내 준 담당자에게 문의하세요.</p></div>';
        document.body.appendChild(ov);
      }
    },

    /** 링크 자체가 무효할 때(삭제/미배포) — 조용히 빈 화면을 주지 않는다. */
    showDeadLink() {
      const modal = document.getElementById("share-gate-modal");
      if (!modal) return;
      const $ = (id) => document.getElementById(id);
      const t = $("sg-title"); if (t) t.textContent = "링크를 찾을 수 없습니다";
      const sub = modal.querySelector(".admin-gate-sub");
      if (sub) sub.textContent = "주소가 정확하지 않거나, 공유가 해제된 링크입니다.";
      ["sg-company", "sg-name", "sg-code", "sg-submit"].forEach((id) => { const e = $(id); if (e) e.classList.add("hidden"); });
      const note = $("sg-contact-note");
      if (note) note.textContent = this.CONTACT + " 으로 링크를 다시 요청하세요.";
      modal.classList.remove("hidden");
      requestAnimationFrame(() => modal.classList.add("on"));
    }
  };
