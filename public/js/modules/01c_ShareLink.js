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

    /** 현재(또는 주어진) 주소가 공유 링크면 토큰, 아니면 null.
     *  slug 에 하이픈이 몇 개 있든 **마지막 '-' 뒤**가 토큰이다(토큰 알파벳에 '-' 없음 → 분리 유일). */
    token(loc) {
      const L = loc || (typeof location !== "undefined" ? location : null);
      if (!L) return null;
      const m = String(L.pathname || "").match(/^\/srview\/([^/]+)\/?$/);
      if (!m) return null;
      let seg = m[1];
      try { seg = decodeURIComponent(seg); } catch (e) {}
      const i = seg.lastIndexOf("-");
      const t = i >= 0 ? seg.slice(i + 1) : seg;
      return this.isToken(t) ? t : null;
    },

    /** 토큰 → { project, deployment_id }. 실패하면 null(조용한 성공 위장 금지). */
    async resolve() {
      const t = this.token();
      if (!t) return null;
      try {
        const r = await fetch("/api/share/" + encodeURIComponent(t));
        if (!r.ok) return null;                       // 404 = 토큰 불일치/미배포 — 힌트 없음
        const j = await r.json();
        if (!j || !j.matched || !j.project) return null;
        this.project = { id: j.project.id, name: j.project.name };
        this.deploymentId = j.deployment_id || null;
        this._resolved = j;
        return j;
      } catch (e) { return null; }                    // 오프라인 → 정직하게 실패
    }
  };
