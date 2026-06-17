  const PanoNav = {
    _list: [], _idx: -1,

    init() {
      const $ = (id) => document.getElementById(id);
      $("btn-pano-prev") && $("btn-pano-prev").addEventListener("click", () => this.go(-1));
      $("btn-pano-next") && $("btn-pano-next").addEventListener("click", () => this.go(1));
    },

    /** 현재 핀 기준으로 같은 페이지의 "콘텐츠 있는" 핀 목록 + 위치 갱신 */
    update(pin) {
      const page = pin.page || 1;
      this._list = (State.pins || [])
        .filter(p => (p.page || 1) === page && App.pinHasContent(p));
      this._idx = this._list.findIndex(p => p.id === pin.id);
      const box = document.getElementById("pano-nav");
      if (!box) return;
      if (this._list.length <= 1) { box.classList.add("hidden"); return; }
      box.classList.remove("hidden");
      const label = document.getElementById("pano-nav-label");
      if (label) label.textContent = (this._idx + 1) + " / " + this._list.length;
      const prev = document.getElementById("btn-pano-prev");
      const next = document.getElementById("btn-pano-next");
      if (prev) prev.disabled = this._idx <= 0;
      if (next) next.disabled = this._idx >= this._list.length - 1;
    },

    go(delta) {
      const ni = this._idx + delta;
      if (ni < 0 || ni >= this._list.length) return;
      const target = this._list[ni];
      if (target) App.openPano(target);
    },

    hide() { const b = document.getElementById("pano-nav"); if (b) b.classList.add("hidden"); }
  };

  /* ══════════════════════════════════════════
     FLS — FARO 포인트 클라우드(LiDAR) 직접 로드/표출 (Three.js)
       · 표준 포맷(.ply/.pcd/.xyz/.pts/.las/.laz) → 브라우저에서 100% 직접 파싱·렌더
       · .fls(FARO 독점) → 헤더 best-effort + 변환 안내 (FARO SCENE → e57/las)
       · 360 파노라마와 나란히(split) 표시. 안정성 최우선: 점 개수 상한·다운샘플.
  ══════════════════════════════════════════ */