  const AllPins = {
    open: false,
    sort: "page",     // 'page' | 'name'
    query: "",
    _thumbCache: {},  // imageId → dataURL (썸네일 1회 fetch 캐시)

    init() {
      const $ = (id) => document.getElementById(id);
      $("btn-all-pins") && $("btn-all-pins").addEventListener("click", () => this.toggle());
      $("btn-allpins-close") && $("btn-allpins-close").addEventListener("click", () => this.hide());
      $("allpins-backdrop") && $("allpins-backdrop").addEventListener("click", () => this.hide());
      const search = $("allpins-search-input");
      if (search) search.addEventListener("input", () => { this.query = search.value.trim().toLowerCase(); this.render(); });
      document.querySelectorAll(".allpins-sort-btn").forEach((b) => {
        b.addEventListener("click", () => {
          this.sort = b.dataset.sort;
          document.querySelectorAll(".allpins-sort-btn").forEach((x) => x.classList.toggle("active", x === b));
          this.render();
        });
      });
      // 단축키 P 로 토글 (입력 중/파노라마 열림 제외)
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && this.open) { this.hide(); return; }
        const tag = (e.target && e.target.tagName) || "";
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        if (PanoViewer.open) return;
        if ((e.key === "p" || e.key === "P") && State.pins.length) { e.preventDefault(); this.toggle(); }
      });
    },

    /** 핀이 있을 때만 topbar 버튼 노출 */
    syncButton() {
      const btn = document.getElementById("btn-all-pins");
      if (!btn) return;
      btn.classList.toggle("hidden", !State.pins.length);
    },

    toggle() { this.open ? this.hide() : this.show(); },

    show() {
      if (!State.pins.length) return;
      this.open = true;
      document.getElementById("allpins-drawer").classList.remove("hidden");
      requestAnimationFrame(() => document.getElementById("allpins-drawer").classList.add("on"));
      this.render();
    },

    hide() {
      this.open = false;
      const d = document.getElementById("allpins-drawer");
      d.classList.remove("on");
      setTimeout(() => { if (!this.open) d.classList.add("hidden"); }, 220);
    },

    _kindBadge(pin) {
      if (pin.isVideo || (pin.imageUrl && /\.(mp4|webm|mov)(\?|$)/i.test(pin.imageUrl)))
        return { ico: "🎬", cls: "video", txt: "360° 영상" };
      if (pin.imageId || pin.imageUrl) return { ico: "🌐", cls: "pano", txt: "360° 파노라마" };
      if (pin.attachments && pin.attachments.length) return { ico: "📎", cls: "doc", txt: pin.attachments.length + "개 첨부" };
      if (pin.note) return { ico: "📝", cls: "note", txt: "노트" };
      return { ico: "📍", cls: "empty", txt: "콘텐츠 없음" };
    },

    _sorted() {
      const arr = State.pins.map((p, i) => ({ pin: p, idx: i }));
      if (this.query) {
        arr.splice(0, arr.length, ...arr.filter((o) =>
          (o.pin.label || "").toLowerCase().includes(this.query)));
      }
      if (this.sort === "name") {
        arr.sort((a, b) => (a.pin.label || "").localeCompare(b.pin.label || "", "ko"));
      } else {
        arr.sort((a, b) => ((a.pin.page || 1) - (b.pin.page || 1)) || (a.idx - b.idx));
      }
      return arr;
    },

    render() {
      if (!this.open) return;
      const listEl = document.getElementById("allpins-list");
      const emptyEl = document.getElementById("allpins-empty");
      const countEl = document.getElementById("allpins-count");
      if (countEl) countEl.textContent = State.pins.length;
      const rows = this._sorted();
      listEl.innerHTML = "";
      if (!rows.length) { emptyEl.classList.remove("hidden"); return; }
      emptyEl.classList.add("hidden");

      const totalPages = State.mode === "viewer"
        ? (State.viewerPages ? State.viewerPages.length : 1) : State.pdfPages;

      rows.forEach(({ pin, idx }) => {
        const badge = this._kindBadge(pin);
        const hasMedia = App.pinHasContent(pin);
        const pageTag = totalPages > 1 ? `P${pin.page || 1}` : "";
        const row = document.createElement("button");
        row.className = "allpins-item" + (State.activePin === pin.id ? " active" : "");
        row.dataset.id = pin.id;
        row.innerHTML = `
          <span class="allpins-thumb ${badge.cls}" data-imgid="${pin.imageId || ""}">
            <span class="allpins-thumb-ico">${badge.ico}</span>
            <span class="allpins-thumb-no">${idx + 1}</span>
          </span>
          <span class="allpins-meta">
            <span class="allpins-name">${UI.escapeHtml(pin.label || "(이름 없음)")}</span>
            <span class="allpins-sub">
              <span class="allpins-kind ${badge.cls}">${badge.txt}</span>
              ${pageTag ? `<span class="allpins-page">${pageTag}</span>` : ""}
            </span>
          </span>
          <span class="allpins-go" title="이동 + 보기">
            ${hasMedia
              ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/></svg>'
              : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>'}
          </span>`;
        row.addEventListener("click", () => this._goto(pin));
        listEl.appendChild(row);

        // 360° 그림 썸네일 비동기 로드 (캐시)
        if (pin.imageId) this._loadThumb(row.querySelector(".allpins-thumb"), pin.imageId);
      });
    },

    async _loadThumb(thumbEl, imageId) {
      try {
        let url = this._thumbCache[imageId] || (Cloud._cache && Cloud._cache[imageId]);
        if (!url) { url = await Cloud.fetchImage(imageId); this._thumbCache[imageId] = url; }
        if (!url || !thumbEl) return;
        thumbEl.style.backgroundImage = `url("${url}")`;
        thumbEl.classList.add("has-img");
      } catch (e) { /* 썸네일 실패 무시 */ }
    },

    /** 페이지 구분 없이 해당 포인트로 이동(줌인) + 콘텐츠 있으면 360°/정보 함께 오픈 */
    async _goto(pin) {
      const hasContent = App.pinHasContent(pin);
      // 1) 먼저 도면을 해당 포인트로 이동(페이지 전환 포함)시켜 결과를 확정한 뒤
      await App.focusPin(pin, hasContent);
      // 2) 드로어를 닫는다 (이동 결과가 보이도록). 콘텐츠 없으면 닫고 도면만 보여줌.
      this.hide();
    }
  };

  /* ══════════════════════════════════════════
     AUTH — Google Identity 로그인 + 권한(슈퍼관리자/디자이너/뷰어)
     · 일반인(미로그인/권한없음) = 뷰어만
     · 디자이너로 지정된 구글 계정 = 설계자 기능
     · 슈퍼관리자(designssir@gmail.com) = 디자이너 지정 + 모든 권한
  ══════════════════════════════════════════ */