  /* ══════════════════════════════════════════════════════════════════
     [P61] ShareLink — 공유 주소 `/srview/<프로젝트명>-<토큰>`
     마스터 2026-09-21: "scan.seastar.work/프로젝트이름 — 이런 식으로 배포해줘"
     마스터 2026-09-18: "다른 프로젝트를 유추할 수 없도록" + "보이는 건 seastar 과 srview"

     · 이름(slug)은 **장식**이다 — 고객이 주소만 보고 무슨 프로젝트인지 알게 하는 용도.
     · 실제 열쇠는 **토큰**(서버 80비트 암호난수). 토큰이 틀리면 서버가 404 를 준다.
     · 이름이 바뀌어도 토큰이 같으면 옛 링크가 그대로 열린다(slug 는 무시하고 파싱).

     🔴 이 객체는 "현재 주소가 공유 링크인가"의 **단일 판정원(SoT)** 이다.
        22_Auth(열람전용 토큰 요청) · 20_App(배포본 선택) · 99_footer(진입)가 전부 여기만 본다.
        판정이 세 군데로 갈라지면 한 곳만 고쳐져 쓰기가 뚫린다(p48 사고와 동일 구조).
  ══════════════════════════════════════════════════════════════════ */
  const ShareLink = {
    /** resolve() 로 채워지는 캐시 — 20_App.loadLatestDeployment 가 읽는다. */
    deploymentId: null,
    project: null,
    _resolved: null,

    /** 서버 src/lib/util.ts 의 isShareToken 과 동일 규격: base32 소문자 16자(=80비트). */
    isToken(t) { return /^[a-z2-7]{16}$/.test(String(t || "")); },

    /** [WO 20261012-viewlink] `/v/<토큰>` 의 토큰 형식 — 서버 src/lib/util.ts isViewToken 과 동일 규격
     *  (공유 토큰·새 뷰어 링크 id = base32 16자 · 구 뷰어 링크 id = lk_<시각>_<난수>). */
    isViewToken(t) { return this.isToken(t) || /^lk_[a-z0-9]{4,16}_[a-z0-9]{4,16}$/.test(String(t || "")); },

    /** 현재(또는 주어진) 주소가 열람 링크 주소면 토큰, 아니면 null.
     *  · 새 주소 `/v/<토큰>`(이름 없음 — 마스터 2026-10-12 "회사이름이나 프로젝트는 전체 보안화")
     *  · 구 주소 `/srview/<이름>-<토큰>` — 마지막 '-' 뒤가 토큰(토큰 알파벳에 '-' 없음 → 분리 유일). 하위호환으로 계속 연다. */
    token(loc) {
      const L = loc || (typeof location !== "undefined" ? location : null);
      if (!L) return null;
      const p = String(L.pathname || "");
      const mv = p.match(/^\/v\/([^/]+)\/?$/);
      if (mv) {
        let v = mv[1];
        try { v = decodeURIComponent(v); } catch (e) {}
        return this.isViewToken(v) ? v : null;
      }
      const m = p.match(/^\/srview\/([^/]+)\/?$/);
      if (!m) return null;
      let seg = m[1];
      try { seg = decodeURIComponent(seg); } catch (e) {}
      const i = seg.lastIndexOf("-");
      const t = i >= 0 ? seg.slice(i + 1) : seg;
      return this.isToken(t) ? t : null;
    },

    /** [WO 20261012-viewlink] 🔴 "이 화면은 열람 링크 세션인가"의 단일 판정(SoT) — 22_Auth._isViewLink · 12_ProjectHub._isShareEntry ·
     *  18_Brand(제목) · 진입 즉시 html.wm-view-link 클래스가 전부 여기만 본다. `/v/` · `/srview/` · `?d=` · `?lk=`. */
    isViewEntry(loc) {
      const L = loc || (typeof location !== "undefined" ? location : null);
      if (!L) return false;
      if (this.token(L)) return true;
      try { const q = new URLSearchParams(L.search || ""); return !!(q.get("d") || q.get("lk")); } catch (e) { return false; }
    },

    /** [WO 20261012-viewlink] 구 주소 `/srview/<이름>-<토큰>` → 즉시 `/v/<토큰>` 으로 바꾼다(history.replaceState — 새로고침·뒤로가기 없음).
     *  주소창·방문 기록·공유 시트에 프로젝트(=고객사) 이름이 남지 않게 한다. 바꿨으면 true. */
    canonicalize() {
      try {
        if (typeof location === "undefined" || typeof history === "undefined" || !history.replaceState) return false;
        if (!/^\/srview\//.test(location.pathname)) return false;
        const t = this.token();
        if (!t) return false;
        history.replaceState(history.state, "", "/v/" + encodeURIComponent(t) + location.search + location.hash);
        return true;
      } catch (e) { return false; }
    },

    /** [WO 20261012-viewlink] 진입 즉시(스크립트 실행 시점) — 주소 정규화 + 열람 링크 표식 클래스.
     *  서버가 셸에 이미 심어 주지만(asViewLinkShell), 서비스워커 캐시 셸(오프라인)에서도 같게 만든다. */
    boot() {
      this.canonicalize();
      try { if (this.isViewEntry() && document && document.documentElement) document.documentElement.classList.add("wm-view-link"); } catch (e) {}
    },

    /** 토큰 → { project, deployment_id }. 실패하면 null(조용한 성공 위장 금지). */
    async resolve() {
      const t = this.token();
      if (!t) return null;
      try {
        const r = await fetch("/api/share/" + encodeURIComponent(t));
        this.withdrawn = r.status === 410;            // [WO 20261012-viewlink] 410 = 배포가 중단된 링크(취소·폐기)
        if (!r.ok) return null;                       // 404 = 토큰 불일치/미배포 — 힌트 없음
        const j = await r.json();
        if (!j || !j.matched || !j.project) return null;
        // [WO 20261012-viewlink] 공개 응답엔 이름이 없다(비식별) — id 만 쓴다.
        this.project = { id: j.project.id, name: "", original_deployment_id: j.project.original_deployment_id || null };
        this.deploymentId = j.deployment_id || null;
        this._resolved = j;
        return j;
      } catch (e) { return null; }                    // 오프라인 → 정직하게 실패
    }
  };
  ShareLink.boot();
