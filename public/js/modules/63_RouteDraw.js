  /* ══════════════════════════════════════════════════════════════
     ROUTES — 360° 동영상 동선 (핀이 아니라 "선")
     ────────────────────────────────────────────────────────────────
     · 마스터 요청: PDF에서 선을 긋듯 도면 위에 동선(점선+진행방향 화살표)을
       그리고, 그 동선에 360° 동영상(THETA 뷰처럼 재생)을 연결한다.
     · 패턴은 16_Zones.js(poly 드로잉) 를 그대로 따른다: 클릭으로 점 추가,
       더블클릭/Enter/모바일 "완료" 버튼으로 종료. 최소 2점.
     · 완료 즉시 mp4 파일 선택(30MB 이하) → /api/r2/upload 로 업로드 →
       videoId(R2 key) 를 동선에 연결해 저장. 오프라인이면 큐잉.
     · 재생: 동선 클릭 → PanoViewer.loadMedia(..., true) 로 360 영상 재생,
       재생진행률(0~1)에 맞춰 도면 위 위치점(movingDot)을 동선 길이비례로 보간.
       동선 위 임의 지점 클릭 → 그 비율로 PanoViewer.seekRatio() 탐색.
     · 열람자: 그리기/삭제 금지, 재생만 허용(isDesigner() 게이트).
     · 재이식(참조 커밋 4e1b93b, worktree-agent-a41ea3de095f35cf0) — main(c0cfa9f 이후)
       구조 반영: App._MERGE_KINDS.route(병합)·routesReady(서버 503 가드)·carryRoutes(개정 이월).
  ══════════════════════════════════════════════════════════════ */
  const Routes = {
    _poly: null,          // 그리는 중인 점 배열 [{x,y}%...]
    _polyCursor: null,
    _activeId: null,      // 현재 재생(또는 포커스) 중인 동선 id
    _pendingPoints: null, // 완료된 점들(파일 선택 대기 중)

    _newId() { return "route_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); },

    init() {
      const $ = (id) => document.getElementById(id);
      const btn = $("btn-route-draw");
      if (btn) btn.addEventListener("click", () => this.toggleDraw());
      const vp = $("map-viewport");
      if (vp) vp.addEventListener("dblclick", (e) => {
        if (State.drawingRoute && this._poly && this._poly.length >= 2) { e.preventDefault(); this._finish(); }
      });
      document.addEventListener("keydown", (e) => {
        if (!State.drawingRoute) return;
        if (e.key === "Enter" && this._poly && this._poly.length >= 2) { e.preventDefault(); this._finish(); }
        if (e.key === "Escape") { this._cancelDraw(); }
      });
      const rf = $("btn-route-finish");
      if (rf) rf.addEventListener("click", () => { if (this._poly && this._poly.length >= 2) this._finish(); });
      const inp = $("input-route-video");
      if (inp) inp.addEventListener("change", (e) => {
        const f = (e.target.files || [])[0]; e.target.value = "";
        if (f) this._onVideoPicked(f);
        else this._abortPendingRoute();
      });
    },

    isDesigner() { return !!(typeof Auth !== "undefined" && Auth.isDesigner); },

    /* ── 그리기 모드 토글 ── */
    toggleDraw() {
      if (!this.isDesigner()) return;
      if (State.drawingRoute) { this._cancelDraw(); return; }
      // ISO 3D 에서는 좌표 왜곡 — 평면으로 강제 전환(Zones 와 동일 정책)
      if (State.isoView && typeof MapCtrl !== "undefined" && MapCtrl.exitIso) {
        MapCtrl.exitIso();
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("평면 뷰로 전환 — 동선을 그린 뒤 ISO 로 돌아가세요");
      }
      State.drawingRoute = true;
      this._poly = []; this._polyCursor = null;
      // 핀 배치/영역 그리기와 상호 배타
      if (State.placing) {
        State.placing = false;
        UI.$("btn-place") && UI.$("btn-place").classList.remove("active");
        UI.$("place-hint") && UI.$("place-hint").classList.add("hidden");
      }
      if (State.drawingZone && typeof Zones !== "undefined" && Zones._cancelDraw) Zones._cancelDraw();
      this._syncToolUi();
    },

    _cancelDraw() {
      State.drawingRoute = false;
      this._poly = null; this._polyCursor = null;
      this._clearDraft();
      this._syncToolUi();
    },

    _syncToolUi() {
      const btn = UI.$("btn-route-draw");
      if (btn) btn.classList.toggle("active", State.drawingRoute);
      const hint = UI.$("route-hint");
      if (hint) hint.classList.toggle("hidden", !State.drawingRoute);
      const vp = UI.$("map-viewport");
      if (vp && State.drawingRoute) vp.style.cursor = "crosshair";
      else if (vp && !State.drawingZone && !State.placing) vp.style.cursor = "grab";
    },

    /* ── 클릭으로 점 추가(다각형과 동일 누적 방식) ── */
    onDrawStart(clientX, clientY) {
      if (!State.drawingRoute) return false;
      const pct = MapCtrl.viewportToPercent(clientX, clientY);
      if (!pct) return false;
      this._poly = this._poly || [];
      this._poly.push({ x: +pct.x.toFixed(3), y: +pct.y.toFixed(3) });
      this._renderDraft();
      return true;
    },
    onDrawMove(clientX, clientY) {
      const pct = MapCtrl.viewportToPercent(clientX, clientY);
      if (!pct) return;
      this._polyCursor = { x: pct.x, y: pct.y };
      this._renderDraft();
    },

    /** 동선 완료 → 영상 파일 선택창을 연다 */
    _finish() {
      const pts = (this._poly || []).map(p => ({ x: +p.x.toFixed(3), y: +p.y.toFixed(3) }));
      this._poly = null; this._polyCursor = null;
      this._clearDraft();
      State.drawingRoute = false;
      this._syncToolUi();
      if (pts.length < 2) return;
      this._pendingPoints = pts;
      if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("이 동선에 360 동영상을 연결하세요 (mp4, 30MB 이하)");
      const inp = document.getElementById("input-route-video");
      if (inp) inp.click();
      else this._abortPendingRoute();
    },
    _abortPendingRoute() { this._pendingPoints = null; },

    /** 파일 선택 후 — 크기/형식 검증 → 업로드(온라인) 또는 큐잉(오프라인) */
    async _onVideoPicked(file) {
      const pts = this._pendingPoints; this._pendingPoints = null;
      if (!pts || pts.length < 2) return;
      const MAX = 30 * 1024 * 1024;   // [360 동선] 마스터 확정 — 30MB 기준(src/index.tsx MAX_VIDEO_BYTES 와 동일)
      if (!/^video\//.test(file.type) && !/\.(mp4|webm|mov)$/i.test(file.name || "")) {
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("동영상 파일(mp4)만 연결할 수 있습니다");
        return;
      }
      if (file.size > MAX) {
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("영상이 너무 큽니다 — 30MB 이하만 업로드할 수 있습니다");
        return;
      }
      let label = "";
      const defLabel = "동선 " + ((State.routes || []).filter(r => (r.page || 1) === (State.pdfPage || 1)).length + 1);
      if (typeof Prompt !== "undefined" && Prompt.ask) {
        try {
          const r = await Prompt.ask({ title: "동선 이름", placeholder: "예: 1번 화물창 순찰로" });
          if (r && r.value != null && r.value !== "") label = r.value;
          else if (r && r.value === "") label = defLabel;
          else return; // 취소
        } catch (e) { return; }
      } else {
        label = prompt("동선 이름", defLabel) || defLabel;
      }

      const route = {
        id: this._newId(), page: State.pdfPage || 1,
        points: pts, name: label || defLabel,
        videoId: null, ts: Date.now()
      };
      State.routes = State.routes || [];
      State.routes.push(route);
      this.render(); this.renderList();

      if (navigator.onLine) {
        try {
          const r = await fetch("/api/r2/upload", {
            method: "PUT",
            headers: (typeof Auth !== "undefined" && Auth.headers) ? Auth.headers({ "Content-Type": file.type || "video/mp4" }) : { "Content-Type": file.type || "video/mp4" },
            body: file
          });
          if (!r.ok) {
            const j = await r.json().catch(() => ({}));
            if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast(j.error || "영상 업로드 실패 — 오프라인 큐에 보관합니다");
            await this._queueVideoOffline(route, file);
          } else {
            const j = await r.json();
            route.videoId = j.key;
            this.render(); this.renderList();
          }
        } catch (e) {
          await this._queueVideoOffline(route, file);
        }
      } else {
        await this._queueVideoOffline(route, file);
      }

      // 동선 메타(포인트/이름) 저장 — 영상 업로드 성패와 무관하게 즉시 보존
      if (!navigator.onLine && typeof OpLog !== "undefined") {
        OpLog.recordCurrent("route", "upsert", route.id, route).then(() => {
          if (typeof persistLocalDeployment === "function") persistLocalDeployment();
        }).catch(() => {});
      }
      if (typeof App !== "undefined" && App._autoSave) App._autoSave();
    },

    /** 오프라인(또는 업로드 실패) — 영상 블롭을 IndexedDB 에 큐잉, 온라인 복귀 시 자동 업로드 */
    async _queueVideoOffline(route, file) {
      route._videoPending = true;
      if (typeof SyncQueue !== "undefined" && SyncQueue.saveDraft) {
        try { await SyncQueue.saveDraft("routevideo:" + route.id, { blob: file, mime: file.type || "video/mp4", routeId: route.id }); }
        catch (e) {}
      }
      if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("오프라인 — 온라인 연결 시 동영상이 자동 업로드됩니다");
      this.render(); this.renderList();
    },

    /** 온라인 복귀 시 호출(05_SyncQueue._onReconnect) — 큐잉된 동선 영상을 업로드하고 서버에 연결 */
    async flushPendingVideos() {
      if (!navigator.onLine || typeof SyncQueue === "undefined") return;
      let keys = [];
      try { keys = await SyncQueue.allDraftKeys(); } catch (e) { return; }
      const vKeys = keys.filter(k => String(k).startsWith("routevideo:"));
      for (const k of vKeys) {
        let rec;
        try { rec = await SyncQueue.loadDraft(k); } catch (e) { continue; }
        if (!rec || !rec.blob) { await SyncQueue.removeDraft(k); continue; }
        try {
          const r = await fetch("/api/r2/upload", {
            method: "PUT",
            headers: (typeof Auth !== "undefined" && Auth.headers) ? Auth.headers({ "Content-Type": rec.mime || "video/mp4" }) : { "Content-Type": rec.mime || "video/mp4" },
            body: rec.blob
          });
          if (!r.ok) continue; // 다음 재연동 때 재시도(큐 유지)
          const j = await r.json();
          const depId = State.autoSaveDepId || (typeof Projects !== "undefined" && Projects.currentDeck && Projects.currentDeck.deployment_id) || null;
          if (depId) {
            await fetch("/tables/deployments/" + encodeURIComponent(depId) + "/ops", {
              method: "POST",
              headers: Auth.headers(),
              body: JSON.stringify({ ops: [{ opId: "rv-" + rec.routeId, entity: "route", action: "upsert", id: rec.routeId, data: { videoId: j.key }, ts: Date.now() }] })
            }).catch(() => {});
          }
          const route = (State.routes || []).find(x => x.id === rec.routeId);
          if (route) { route.videoId = j.key; route._videoPending = false; this.render(); this.renderList(); }
          await SyncQueue.removeDraft(k);
        } catch (e) { /* 다음 재연동 때 재시도 */ }
      }
    },

    /* ── 그리기 미리보기 ── */
    _clearDraft() {
      const svg = document.getElementById("routes-svg");
      if (svg) { const d = svg.querySelector(".route-draft-svg"); if (d) d.remove(); }
      const rf = document.getElementById("btn-route-finish");
      if (rf) rf.classList.add("hidden");
    },
    _renderDraft() {
      const svg = document.getElementById("routes-svg");
      if (!svg) return;
      let d = svg.querySelector(".route-draft-svg");
      if (d) d.remove();
      if (!State.drawingRoute) return;
      d = document.createElementNS("http://www.w3.org/2000/svg", "g");
      d.setAttribute("class", "route-draft-svg");
      const live = (this._poly || []).concat(this._polyCursor ? [this._polyCursor] : []);
      const pts = live.map(p => `${p.x},${p.y}`).join(" ");
      let inner = live.length > 1 ? `<polyline points="${pts}" class="zd-line"/>` : "";
      inner += (this._poly || []).map((p, i) => `<circle cx="${p.x}" cy="${p.y}" r="${i === 0 ? 1.1 : 0.8}" class="zd-dot${i === 0 ? " first" : ""}"/>`).join("");
      d.innerHTML = inner;
      svg.appendChild(d);
      const rf = document.getElementById("btn-route-finish");
      if (rf) rf.classList.toggle("hidden", !(this._poly && this._poly.length >= 2));
    },

    /* ── 동선 길이비례 보간 유틸 ── */
    _segLengths(points) {
      const segs = []; let total = 0;
      for (let i = 1; i < points.length; i++) {
        const l = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
        segs.push(l); total += l;
      }
      return { segs, total };
    },
    /** 진행률 t(0~1) → 동선 위 좌표(%) */
    pointAtRatio(points, t) {
      if (!points || points.length < 2) return points && points[0];
      const { segs, total } = this._segLengths(points);
      if (total <= 0) return points[0];
      let target = Math.max(0, Math.min(1, t)) * total;
      for (let i = 0; i < segs.length; i++) {
        if (target <= segs[i] || i === segs.length - 1) {
          const r = segs[i] > 0 ? target / segs[i] : 0;
          const a = points[i], b = points[i + 1];
          return { x: a.x + (b.x - a.x) * Math.min(1, r), y: a.y + (b.y - a.y) * Math.min(1, r) };
        }
        target -= segs[i];
      }
      return points[points.length - 1];
    },
    /** 도면 클릭 좌표(%) → 동선 위 가장 가까운 지점의 진행률 t(0~1) */
    ratioAtPoint(points, px, py) {
      if (!points || points.length < 2) return 0;
      const { segs, total } = this._segLengths(points);
      if (total <= 0) return 0;
      let best = { d: Infinity, t: 0 };
      let acc = 0;
      for (let i = 0; i < segs.length; i++) {
        const a = points[i], b = points[i + 1];
        const dx = b.x - a.x, dy = b.y - a.y;
        const len2 = dx * dx + dy * dy;
        let r = len2 > 0 ? ((px - a.x) * dx + (py - a.y) * dy) / len2 : 0;
        r = Math.max(0, Math.min(1, r));
        const cx = a.x + dx * r, cy = a.y + dy * r;
        const d = Math.hypot(px - cx, py - cy);
        if (d < best.d) best = { d, t: (acc + segs[i] * r) / total };
        acc += segs[i];
      }
      return best.t;
    },

    /** [WO 20261016-pinscale §2] 선 두께·화살표(marker-end 는 SVG 기본 markerUnits=strokeWidth라
     *  stroke-width 에 자동 비례 — 별도 코드 불필요) — 핀과 같은 정책(도면과 비례 + 바닥).
     *  MapCtrl.applyTransform() 이 줌/팬마다 호출(Zones.updateLabelScale 과 같은 자리). */
    updateLineScale() {
      const svg = document.getElementById("routes-svg");
      if (!svg) return;
      const s = (typeof MapCtrl !== "undefined" && MapCtrl.lineScreenScale) ? MapCtrl.lineScreenScale(0.4) : 1;
      if (svg.style && typeof svg.style.setProperty === "function") svg.style.setProperty("--route-scale", s.toFixed(3));
    },

    /* ── 렌더: 도면 위 동선(점선+화살표) + 재생위치점 ── */
    render() {
      const page = State.pdfPage || 1;
      const routes = (State.routes || []).filter(r => (r.page || 1) === page && !r._deleted);
      const svg = document.getElementById("routes-svg");
      const layer = document.getElementById("routes-layer");
      if (!svg || !layer) return;
      const draft = svg.querySelector(".route-draft-svg");
      const defs = svg.querySelector("defs");
      svg.innerHTML = (defs ? defs.outerHTML : "") + routes.map(r => {
        const pts = (r.points || []).map(p => `${p.x},${p.y}`).join(" ");
        const first = r.points && r.points[0], last = r.points && r.points[r.points.length - 1];
        let s = `<polyline points="${pts}" class="route-line-halo"/>`;
        s += `<polyline data-route="${r.id}" points="${pts}" class="route-line"/>`;
        if (first) s += `<circle cx="${first.x}" cy="${first.y}" r="0.9" class="route-dot-start"/>`;
        if (last) s += `<circle cx="${last.x}" cy="${last.y}" r="0.9" class="route-dot-end"/>`;
        if (r.id === this._activeId && this._playRatio != null) {
          const p = this.pointAtRatio(r.points, this._playRatio);
          if (p) s += `<circle cx="${p.x}" cy="${p.y}" r="1.3" class="route-playhead"/>`;
        }
        return s;
      }).join("");
      if (draft) svg.appendChild(draft);

      layer.innerHTML = routes.map(r => {
        const first = r.points && r.points[0];
        if (!first) return "";
        const pending = r._videoPending ? ` <span class="zone-box-cnt" title="오프라인 — 온라인시 업로드">대기</span>` : (!r.videoId ? ` <span class="zone-box-cnt" title="영상 없음">영상없음</span>` : "");
        return `<div class="zone-box" data-route="${r.id}" style="left:${first.x}%;top:${first.y}%;width:0;height:0">
            <div class="zone-box-label" style="position:absolute;white-space:nowrap;transform:translate(2px,-50%)">${UI.escapeHtml(r.name || "")}${pending}</div>
            ${this.isDesigner() ? `<button class="zone-box-del" data-rdel="${r.id}" title="동선 삭제" aria-label="동선 삭제" style="position:absolute;left:0;top:14px"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg></button>` : ""}
          </div>`;
      }).join("");

      svg.querySelectorAll(".route-line").forEach(el => {
        el.addEventListener("click", (e) => {
          if (State.drawingRoute) return;
          const id = el.getAttribute("data-route");
          const route = (State.routes || []).find(x => x.id === id);
          if (!route) return;
          // [R1 결함수정 — WO 20261016-routeminimap] 이 도면 위 click-to-seek 분기는 죽은 코드였다:
          // 재생 중에는 #pano-overlay(fixed·inset:0·z-index:9999)가 도면 전체를 가려
          // elementFromPoint 가 이 .route-line 을 절대 집지 못한다(p156-e2e 실측, CDP). 재생 중
          // 탐색은 이제 07_Radar.js 의 레이더 미니맵(Radar.showRoute → 클릭/드래그 → seekRatio)이
          // 전담한다 — 이 핸들러는 재생 시작/재시작만 한다(도면이 보이는 시점 = 재생 중이 아닐 때뿐).
          this.play(id);
        });
      });
      layer.querySelectorAll("[data-rdel]").forEach(b => {
        b.addEventListener("click", (e) => { e.stopPropagation(); this.remove(b.dataset.rdel); });
      });
      if (typeof UI !== "undefined" && UI.renderTree) UI.renderTree();
    },

    /** 동선 재생 — 360 뷰어로 영상을 열고, 진행률에 맞춰 도면 위 위치점을 갱신 */
    play(id) {
      const route = (State.routes || []).find(x => x.id === id);
      if (!route) return;
      if (!route.videoId) {
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast(route._videoPending ? "오프라인 — 아직 업로드되지 않았습니다" : "이 동선에는 연결된 영상이 없습니다");
        return;
      }
      this._activeId = id; this._playRatio = 0;
      const src = "/api/r2/object/" + route.videoId;
      if (typeof PanoViewer !== "undefined") {
        PanoViewer.onProgress = (t) => {
          this._playRatio = t; this.render();
          // [360 동선 미니맵 — R1] 도면이 재생 오버레이에 가려 있는 동안의 실제 탐색 UI.
          if (typeof Radar !== "undefined" && Radar.updateRoutePlayhead) Radar.updateRoutePlayhead(t);
        };
        PanoViewer.loadMedia((typeof Auth !== "undefined" && Auth.r2) ? Auth.r2(src) : src, route.name || "동선", true);
      }
      // [360 동선 미니맵 — R1] 재생 중 도면이 전체화면 오버레이에 가려지므로, 동선 전체+재생위치점을
      // 레이더 미니맵(핀 모드와 같은 #pano-radar 패널)에 표시하고 클릭/드래그로 탐색 가능하게 한다.
      if (typeof Radar !== "undefined" && Radar.showRoute) Radar.showRoute(route);
    },

    /** 사이드바 목록 */
    renderList() {
      const sec = document.getElementById("section-routes");
      const list = document.getElementById("route-list");
      const cntEl = document.getElementById("route-count");
      if (!list) return;
      const routes = State.routes || [];
      if (cntEl) cntEl.textContent = routes.length;
      if (sec) sec.classList.toggle("hidden", routes.length === 0 && !this.isDesigner());
      if (routes.length === 0) {
        list.innerHTML = `<p class="zone-empty">${this.isDesigner() ? "위 '360 동영상 동선' 도구로 선을 그어보세요." : "등록된 동선이 없습니다."}</p>`;
        return;
      }
      list.innerHTML = routes.map(r => {
        const badge = r._videoPending ? "대기" : (!r.videoId ? "영상없음" : "p." + (r.page || 1));
        return `<div class="zone-item" data-route="${r.id}">
            <span class="zone-item-shape" title="동선"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17c4-8 10-8 18-10"/><polyline points="17 4 21 7 18 11"/></svg></span>
            <span class="zone-item-label">${UI.escapeHtml(r.name || "")}</span>
            <span class="zone-item-page">${badge}</span>
          </div>`;
      }).join("");
      list.querySelectorAll(".zone-item").forEach(el => {
        const id = el.dataset.route;
        el.addEventListener("click", () => this.play(id));
      });
    },

    /** 그리기/삭제 — 열람자는 isDesigner() 게이트로 전부 거부(재생만 허용). */
    async remove(id) {
      if (!this.isDesigner()) return;
      const r = (State.routes || []).find(x => x.id === id);
      if (!r) return;
      // [p76] 네이티브 confirm() 금지 — PWA 환경에서 무음 false 가 되어 삭제가 조용히 막힌다(Zones.remove 와 같은 지점).
      if (!await Prompt.confirm("동선 삭제", `동선 "${r.name}"을(를) 삭제할까요?`)) return;
      // [360 동선] tombstone(App._routeTombstones) — zones/annotations 와 같은 규칙(병합 SoT가 서버본의 복귀를 막는다).
      if (typeof App !== "undefined" && App._routeTombstones) App._routeTombstones()[String(id)] = Date.now();
      State.routes = (State.routes || []).filter(x => x.id !== id);
      if (this._activeId === id) this._activeId = null;
      this.render(); this.renderList();
      if (!navigator.onLine && typeof OpLog !== "undefined") {
        OpLog.recordCurrent("route", "delete", id).then(() => {
          if (typeof persistLocalDeployment === "function") persistLocalDeployment();
        }).catch(() => {});
      }
      if (typeof App !== "undefined" && App._autoSave) App._autoSave();
    },

    serialize() { return JSON.stringify(State.routes || []); },
    load(arr) {
      State.routes = Array.isArray(arr) ? arr : [];
      this.render();
      this.renderList();
    }
  };
