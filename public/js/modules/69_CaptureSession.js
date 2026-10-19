  /* ══════════════════════════════════════════════════════════════
     CAPTURE SESSION — 현장 "촬영 세션" (WO 20261019-capsession)
     ────────────────────────────────────────────────────────────────
     마스터(음성, 2026-10-19): "핸드폰으로 리코 세타 어플과 연동해서 사진을 찍으면 세타 폴더에
     그 시간 기록으로 사진 파일이 들어가. 우리 360 앱과 연동하면 시작 코너부터 해서 찍은 사진이
     차례대로 해당 구역 + 순서대로 매겨지고, 해당 도면 PDF 를 클릭하면 이동 동선을 고려하고
     정지된 위치를 기준으로 넘버와 이름이 자동으로 등록되는 기능까지 구현." (①단계: 동선 + 시간
     자동 배치 — 촬영 시각 비율, 기준점으로 보정).

     🔴 재사용 — 새 로직을 다시 만들지 않는다(§10 SoT):
        - 번호 채번          : PinSeries.nextInBand (01b_PinSeries.js) — 접두·대역·중복검사 정본
        - EXIF/파일명 시각   : PhotoBatch.buildAutoRows → _sortRows (35_PhotoBatch.js) — row.sortKey
        - 사진 업로드 1건    : PhotoBatch._uploadOneRow (35_PhotoBatch.js) — 온라인/오프라인 공용
        - 동선 길이비례 보간 : Routes.pointAtRatio (63_RouteDraw.js)
        - 세션 상태 영속화   : SyncQueue.saveDraft/loadDraft/removeDraft (05_SyncQueue.js, DRAFT_STORE)
        - 시트 UI            : ThetaIntake._sheet (33_ThetaIntake.js)
     이 파일이 새로 추가하는 것: 탭↔사진 "단조 순서" 매칭, 시계 오프셋 자동추정, 정지점 묶음
     (연속촬영 군집화), 동선 시간비율 배치 + 기준점 재보간, 세션 생명주기(시작·복원·되돌리기).

     흐름 A(기본, 정지점 탭): startTap() → addTap() ×N(탭마다 번호핀 생성, 탭시각 기록) →
       finishTapPreview(files) → confirmTapRegister() → PhotoBatch._uploadOneRow 일괄.
     흐름 B(동선): startRoute() → finishRoutePreview(files) → createRoutePins() →
       confirmRouteRegister().
     공통: undo() = 세션이 만든 핀 전부 제거(사진 연결 포함, 되돌리기 단위 = 세션).
  ══════════════════════════════════════════════════════════════ */
  const CaptureSession = {
    DRAFT_KEY: "capture_session_v1",
    DEFAULT_GAP_MS: 3000,          // 연속촬영 묶음 판정 — 간격 < 3초면 같은 정지점(§3 근거)
    DEFAULT_TOLERANCE_MS: 5 * 60000,
    _s: null,  // 현재 세션(메모리 캐시) — persist() 가 SyncQueue draft 에 그대로 영속화

    _newId() { return "capsess_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); },

    /* ══ 생명주기 — 영속화는 SyncQueue.saveDraft/loadDraft 재사용(새 IndexedDB 스토어 0) ══ */
    async _persist() {
      if (!this._s) return;
      if (typeof SyncQueue !== "undefined" && SyncQueue.saveDraft) { try { await SyncQueue.saveDraft(this.DRAFT_KEY, this._s); } catch (e) {} }
    },
    /** 새로고침 후 복원 — 앱 재시작 시 init() 이 1회 호출. */
    async restore() {
      if (typeof SyncQueue === "undefined" || !SyncQueue.loadDraft) return null;
      let s = null;
      try { s = await SyncQueue.loadDraft(this.DRAFT_KEY); } catch (e) {}
      if (s) this._s = s;
      return this._s;
    },
    async clear() {
      this._s = null;
      if (typeof SyncQueue !== "undefined" && SyncQueue.removeDraft) { try { await SyncQueue.removeDraft(this.DRAFT_KEY); } catch (e) {} }
    },
    current() { return this._s; },

    async start(opts) {
      const o = opts || {};
      this._s = {
        id: this._newId(),
        mode: o.mode === "route" ? "route" : "tap",
        startedAt: Date.now(),
        page: o.page || 1,
        deckId: o.deckId || null,
        zoneName: o.zoneName || "",
        prefix: o.prefix,                                  // undefined → PinSeries 가 구역 설정에서 상속(§10 SoT)
        startNo: Number.isFinite(o.startNo) ? o.startNo : 1,
        band: o.band,
        nameTemplate: o.nameTemplate || "<구역명>-<번호>",
        taps: [],                                           // 흐름 A: [{no,label,name,x,y,t,pinId}]
        createdPinIds: [],                                  // 되돌리기 대상(세션이 만든 핀 전부)
        routePoints: o.routePoints || null,                 // 흐름 B: [{x,y}]
        manualOffsetMs: 0,
        gapMs: Number.isFinite(o.gapMs) ? o.gapMs : this.DEFAULT_GAP_MS,
        anchors: [],                                        // 흐름 B: [{t,r}] 기준점(사용자 보정)
        done: false
      };
      // 🔴 정지점 탭(흐름A) 활성화 — 기존 "+번호 핀 찍기"(State.placing) 토글이 켜져 있으면 같은
      // #map-viewport 클릭에서 _handlePlaceClick(20_App.js:1869) 가 먼저 돌아 평범한 핀을 하나 더
      // 만든다(중복 생성). 세션 시작 시 그 토글을 꺼서 탭이 이 세션 전용이 되게 한다(Routes.toggleDraw
      // 의 같은 상호배타 패턴, 63_RouteDraw.js:63 재사용).
      if (this._s.mode === "tap" && typeof State !== "undefined" && State.placing) {
        State.placing = false;
        if (typeof UI !== "undefined") {
          UI.$ && UI.$("btn-place") && UI.$("btn-place").classList.remove("active");
          UI.$ && UI.$("place-hint") && UI.$("place-hint").classList.add("hidden");
        }
      }
      await this._persist();
      return this._s;
    },

    /* ══ 번호/이름 — PinSeries.nextInBand 가 유일한 채번 정본(접두·대역·중복검사) ══ */
    _nextNo(pins, page, band, startNo, prefix) {
      if (typeof PinSeries === "undefined" || !PinSeries.nextInBand) {
        const no = Number.isFinite(startNo) ? startNo : 1;
        return { no, full: false, label: String(no), prefix: prefix || "" };
      }
      return PinSeries.nextInBand(pins, page, "content", band, startNo, undefined, prefix);
    },
    _nameOf(template, zoneName, no, label) {
      const t = template || "<구역명>-<번호>";
      return t.replace("<구역명>", zoneName || "").replace("<번호>", label != null ? String(label) : String(no));
    },

    /* ══ 흐름 A — 정지점 탭 ══════════════════════════════════════════════ */
    /** 도면 탭 1회 = 번호핀 생성 + 탭시각 기록. pins 배열에 직접 push(State.pins 를 호출부가 넘긴다). */
    addTap(pins, pct) {
      if (!this._s || this._s.mode !== "tap") return null;
      const nx = this._nextNo(pins, this._s.page, this._s.band, this._s.startNo, this._s.prefix);
      if (!nx || nx.full) return null;
      const now = Date.now();
      const label = nx.label != null ? nx.label : String(nx.no);
      const pin = { id: now, createdAt: now, x: pct.x, y: pct.y, page: this._s.page, label: label, checkboard: false };
      pin.name = this._nameOf(this._s.nameTemplate, this._s.zoneName, nx.no, label);
      if (pins) pins.push(pin);
      const tap = { no: nx.no, label: label, name: pin.name, x: pct.x, y: pct.y, t: now, pinId: pin.id };
      this._s.taps.push(tap);
      this._s.createdPinIds.push(pin.id);
      this._persist();
      return { pin, tap };
    },

    /** 시계 오프셋 자동추정 — 첫 탭·첫 사진 시각으로 1점 보정(§2 근거: "첫 사진과 첫 탭으로
     *  오프셋을 잡는다"). 보정값 = correctedPhotoT = photoT + offsetMs ≈ tapT. */
    _estimateOffsetMs(firstTapMs, firstPhotoMs) {
      if (!Number.isFinite(firstTapMs) || !Number.isFinite(firstPhotoMs)) return 0;
      return firstTapMs - firstPhotoMs;
    },

    /** 탭↔사진 최근접 매칭(순수) — PhotoBatch._nearestAssign 과 같은 "|Δt| 최소" 철학이되,
     *  🔴 단조 순서 제약을 더한다: 탭은 현장에서 찍은 순서(시간순)이므로, 한 번 쓴 사진보다
     *  시간상 앞선 사진을 그 다음 탭에 쓸 수 없다(동선을 거슬러 갈 수 없다). 이 제약이 없으면
     *  두 탭이 시간상 가까운 사진 2장을 두고 "뒤바뀐" 채 배정될 수 있다(tests/p167 뮤테이션①).
     *  @param {{no,t}[]} taps  @param {{t,row}[]} photos (photos[].t 는 보정 전 EXIF/파일명 시각)
     *  @param {number} offsetMs 보정값(자동+수동 합산, correctedT = photo.t + offsetMs)
     *  @param {number} [toleranceMs] */
    _assignTapPhotos(taps, photos, offsetMs, toleranceMs) {
      const tol = Number.isFinite(toleranceMs) ? toleranceMs : this.DEFAULT_TOLERANCE_MS;
      const off = Number(offsetMs) || 0;
      const ph = (photos || [])
        .map((p) => ({ row: p.row || p, t: Number.isFinite(p.t) ? p.t + off : NaN }))
        .filter((p) => Number.isFinite(p.t))
        .sort((a, b) => a.t - b.t);
      const tp = (taps || []).slice().sort((a, b) => a.t - b.t);
      const used = new Set();
      const matches = [], unmatchedTaps = [];
      let cursor = 0; // 🔴 단조 순서 포인터 — 이 탭이 쓴 사진 다음부터만 다음 탭이 찾는다
      tp.forEach((tap) => {
        let bestJ = -1, bestDt = Infinity;
        for (let j = cursor; j < ph.length; j++) {
          if (used.has(j)) continue;
          const dt = Math.abs(ph[j].t - tap.t);
          if (dt <= tol && dt < bestDt) { bestDt = dt; bestJ = j; }
          if (bestJ !== -1 && ph[j].t - tap.t > bestDt) break; // 이미 찾았고 더 멀어지기만 하면 중단
        }
        if (bestJ === -1) { unmatchedTaps.push(tap); return; }
        matches.push({ tap: tap, photo: ph[bestJ].row, dtMs: bestDt });
        used.add(bestJ);
        cursor = bestJ + 1;
      });
      const unmatchedPhotos = ph.filter((_, j) => !used.has(j)).map((p) => p.row);
      return { matches: matches, unmatchedTaps: unmatchedTaps, unmatchedPhotos: unmatchedPhotos };
    },

    /** PhotoBatch.buildAutoRows(files) 결과(row.sortKey=ms) → 매칭용 photo 엔트리. */
    _rowsToPhotos(rows) { return (rows || []).filter((r) => Number.isFinite(r.sortKey)).map((r) => ({ t: r.sortKey, row: r })); },

    /** 미리보기(커밋 전) — 파일 선택 → 오프셋 자동추정 → 매칭. UI 가 표로 보여주고 confirmTapRegister 호출.
     *  🔴 photos 를 this._lastPhotos 에 캐시 — 수동 시계보정 슬라이더(_recomputeTapPreview)가 파일을
     *  다시 읽지 않고(EXIF 재파싱 0) 같은 photos 로 즉시 재매칭한다(§지시 "실시간 매칭 갱신"). */
    async finishTapPreview(files) {
      if (!this._s || this._s.mode !== "tap") return null;
      const rows = (typeof PhotoBatch !== "undefined" && PhotoBatch.buildAutoRows) ? await PhotoBatch.buildAutoRows(files) : [];
      const photos = this._rowsToPhotos(rows);
      this._lastPhotos = photos;
      return this._recomputeTapPreview();
    },

    /** 수동 오프셋 슬라이더(±120초) 변경 시 재계산 — this._lastPhotos(캐시)로 파일 재읽기 없이 즉시 재매칭. */
    async _recomputeTapPreview() {
      if (!this._s || this._s.mode !== "tap") return null;
      const photos = this._lastPhotos || [];
      const taps = this._s.taps;
      const autoOffset = (taps.length && photos.length) ? this._estimateOffsetMs(taps[0].t, photos[0].t) : 0;
      const totalOffset = autoOffset + (this._s.manualOffsetMs || 0);
      const result = this._assignTapPhotos(taps, photos, totalOffset, this.DEFAULT_TOLERANCE_MS);
      this._s.lastPreview = { autoOffsetMs: autoOffset, totalOffsetMs: totalOffset, matchCount: result.matches.length };
      await this._persist();
      return Object.assign({ autoOffsetMs: autoOffset, totalOffsetMs: totalOffset }, result);
    },

    /** 수동 오프셋(초) 설정 — ±120초로 clamp(슬라이더 min/max 와 같은 값, 단일 SoT). */
    MANUAL_OFFSET_MAX_S: 120,
    setManualOffsetSec(sec) {
      if (!this._s) return;
      const s = Math.max(-this.MANUAL_OFFSET_MAX_S, Math.min(this.MANUAL_OFFSET_MAX_S, Number(sec) || 0));
      this._s.manualOffsetMs = s * 1000;
    },

    /** 적용 — PhotoBatch._uploadOneRow 재사용(온라인 직접 업로드/오프라인 SyncQueue 큐잉, §10 SoT). */
    async confirmTapRegister(pins, matches) {
      if (!this._s) return { done: 0, fail: 0 };
      const usedNames = new Set();
      let done = 0, fail = 0;
      for (const m of matches) {
        const pin = (pins || []).find((p) => p && p.id === m.tap.pinId);
        if (!pin) { fail++; continue; }
        const r = (typeof PhotoBatch !== "undefined" && PhotoBatch._uploadOneRow)
          ? await PhotoBatch._uploadOneRow(pin, m.photo, false, usedNames, "촬영세션")
          : { status: "fail" };
        if (r && r.status === "done") done++; else if (r && r.status === "fail") fail++;
      }
      this._s.done = true;
      await this._persist();
      return { done: done, fail: fail };
    },

    /* ══ 흐름 B — 동선(연속 촬영, 탭 없음) ══════════════════════════════════ */
    /** 연속촬영 군집화(정지점 묶음, 순수) — 간격 ≤ gapMs 이면 같은 정지점(§3 근거: 연속 촬영 간격
     *  < 3초는 같은 자리에서 찍은 것). 제거하면 사진마다 정지점이 생겨 개수가 부풀어 오른다(뮤테이션③). */
    _clusterStops(photos, gapMs) {
      const g = Number.isFinite(gapMs) ? gapMs : this.DEFAULT_GAP_MS;
      const sorted = (photos || [])
        .map((p) => ({ row: p.row || p, t: p.t }))
        .filter((p) => Number.isFinite(p.t))
        .sort((a, b) => a.t - b.t);
      const stops = [];
      sorted.forEach((p) => {
        const cur = stops[stops.length - 1];
        if (cur && (p.t - cur.tEnd) <= g) { cur.photos.push(p); cur.tEnd = p.t; }
        else stops.push({ photos: [p], tStart: p.t, tEnd: p.t });
      });
      stops.forEach((s) => { s.tMid = (s.tStart + s.tEnd) / 2; });
      return stops;
    },

    /** 시각(ms) → 동선 진행률(0~1) 구간보간 함수(순수) — 기준점(anchors)이 있으면 구간별로
     *  다시 보간한다(뮤테이션④: anchors 를 무시하면 기준점을 추가해도 위치가 그대로다). */
    _timeToRatioFn(sessionStartMs, sessionEndMs, anchors) {
      const list = [{ t: sessionStartMs, r: 0 }]
        .concat((anchors || []).slice().sort((a, b) => a.t - b.t))
        .concat([{ t: sessionEndMs, r: 1 }]);
      return function (t) {
        if (t <= list[0].t) return list[0].r;
        for (let i = 1; i < list.length; i++) {
          if (t <= list[i].t) {
            const a = list[i - 1], b = list[i];
            const span = Math.max(1, b.t - a.t);
            return Math.max(0, Math.min(1, a.r + (b.r - a.r) * ((t - a.t) / span)));
          }
        }
        return list[list.length - 1].r;
      };
    },

    /** 정지점 → 동선 위 좌표(순수) — Routes.pointAtRatio 재사용(§10 SoT, 새 보간 0). */
    _placeStops(stops, routePoints, sessionStartMs, sessionEndMs, anchors) {
      const f = this._timeToRatioFn(sessionStartMs, sessionEndMs, anchors);
      const R = (typeof Routes !== "undefined") ? Routes : null;
      return (stops || []).map((s, i) => {
        const ratio = f(s.tMid);
        const pt = (R && R.pointAtRatio) ? R.pointAtRatio(routePoints, ratio) : ((routePoints && routePoints[0]) || { x: 0, y: 0 });
        return { no: i + 1, ratio: ratio, x: pt.x, y: pt.y, photos: s.photos, tMid: s.tMid };
      });
    },

    /** 미리보기(커밋 전) — 파일 선택 → 정지점 군집화 → 동선 배치. */
    async finishRoutePreview(files) {
      if (!this._s || this._s.mode !== "route" || !this._s.routePoints) return null;
      const rows = (typeof PhotoBatch !== "undefined" && PhotoBatch.buildAutoRows) ? await PhotoBatch.buildAutoRows(files) : [];
      const photos = this._rowsToPhotos(rows);
      const stops = this._clusterStops(photos, this._s.gapMs);
      const sessionEnd = stops.length ? stops[stops.length - 1].tEnd : this._s.startedAt;
      const placed = this._placeStops(stops, this._s.routePoints, this._s.startedAt, sessionEnd, this._s.anchors);
      this._s.lastPreview = { stopCount: placed.length, sessionEnd: sessionEnd };
      await this._persist();
      return placed;
    },

    /** 미리보기 핀 드래그 보정 — 호출부가 직접 st.x/st.y 를 바꾼 뒤 재호출 없이 그대로 createRoutePins. */
    createRoutePins(pins, placed) {
      if (!this._s) return [];
      const out = [];
      (placed || []).forEach((st) => {
        const nx = this._nextNo(pins, this._s.page, this._s.band, this._s.startNo, this._s.prefix);
        if (!nx || nx.full) return;
        const now = Date.now() + out.length; // 단일 틱 내 다중 생성 — id 충돌 방지
        const label = nx.label != null ? nx.label : String(nx.no);
        const pin = { id: now, createdAt: now, x: st.x, y: st.y, page: this._s.page, label: label, checkboard: false };
        pin.name = this._nameOf(this._s.nameTemplate, this._s.zoneName, nx.no, label);
        if (pins) pins.push(pin);
        this._s.createdPinIds.push(pin.id);
        st.pinId = pin.id; st.pin = pin;
        out.push(pin);
      });
      this._persist();
      return out;
    },

    /** 적용 — 정지점의 대표 사진(연속촬영 첫 장) 1장만 등록(60_PhotoFolder "연결핀 대표만 등록"과
     *  같은 전례 — 묶음 전체를 다 올리지 않는다). */
    async confirmRouteRegister(pins, placed) {
      const usedNames = new Set();
      let done = 0, fail = 0;
      for (const st of placed) {
        const pin = (pins || []).find((p) => p && p.id === st.pinId);
        const rep = st.photos && st.photos[0] && st.photos[0].row;
        if (!pin || !rep) { fail++; continue; }
        const r = (typeof PhotoBatch !== "undefined" && PhotoBatch._uploadOneRow)
          ? await PhotoBatch._uploadOneRow(pin, rep, false, usedNames, "촬영세션")
          : { status: "fail" };
        if (r && r.status === "done") done++; else if (r && r.status === "fail") fail++;
      }
      if (this._s) this._s.done = true;
      await this._persist();
      return { done: done, fail: fail };
    },

    /* ══ 되돌리기 — 세션이 만든 핀(사진 연결 포함) 일괄 취소 ══════════════════ */
    _undoApply(session, state) {
      if (!session || !state || !Array.isArray(state.pins)) return { removed: 0 };
      const ids = new Set(session.createdPinIds || []);
      const before = state.pins.length;
      for (let i = state.pins.length - 1; i >= 0; i--) {
        if (ids.has(state.pins[i].id)) state.pins.splice(i, 1);
      }
      return { removed: before - state.pins.length };
    },
    async undo() {
      const st = (typeof State !== "undefined") ? State : null;
      const r = this._undoApply(this._s, st);
      if (st && typeof UI !== "undefined") { UI.renderPinList && UI.renderPinList(); UI.renderPinsOnMap && UI.renderPinsOnMap(); }
      await this.clear();
      return r;
    },

    /* ══ DOM 연결(모바일 우선 — 엄지 영역, 44px 칩. 기존 .mdock-chip 재사용, 신규 CSS 0) ══ */
    init() {
      if (typeof document === "undefined") return;
      this.restore();
      this._ensureInput();
      this.mountDockButton();
    },
    _ensureInput() {
      if (document.getElementById("input-capture-session")) return;
      const inp = document.createElement("input");
      inp.type = "file"; inp.id = "input-capture-session"; inp.multiple = true; inp.accept = "image/*";
      inp.style.display = "none";
      inp.addEventListener("change", (e) => {
        const files = Array.from(e.target.files || []);
        e.target.value = "";
        if (files.length) this._onFilesChosen(files);
      });
      document.body.appendChild(inp);
    },
    mountDockButton() {
      if (!document.querySelector) return;
      const bar = document.querySelector("#mobile-dock .mdock-bar");
      if (!bar || document.getElementById("mdock-capture-session")) return;
      const b = document.createElement("button");
      b.type = "button"; b.id = "mdock-capture-session";
      b.className = "mdock-chip mdock-fieldcap hidden";
      b.innerHTML = '<span class="theta-app-label"><span aria-hidden="true">🧭</span> 촬영 세션</span>';
      b.title = "촬영 세션 — 탭 또는 동선으로 정지점을 기록하고 사진을 일괄 등록";
      b.addEventListener("click", (e) => { if (e && e.stopPropagation) e.stopPropagation(); this.open(); });
      const more = document.getElementById("mdock-more-toggle");
      if (more && more.parentNode === bar) bar.insertBefore(b, more); else bar.appendChild(b);
      this.syncDockButton();
      // 🔴 지도 탭 연결은 "click" 리스너가 아니라 20_App.js _bindMap() 의 mousedown 분기
      //   (Zones.onDrawStart/Routes.onDrawStart 와 같은 자리)가 onDrawStart() 를 직접 호출한다.
      //   이유(실측, p167-capture-session-cdp.mjs 로 발견) — MapCtrl.handlePanStart(mousedown)가
      //   먼저 돌며 pan 제스처를 잡아 이후 네이티브 "click" 합성이 억제된다(실 마우스·터치 둘 다).
      //   Zones/Routes 가 같은 문제를 mousedown 분기 자체에서 해결한 전례를 그대로 따른다.
    },
    syncDockButton() {
      const d = document.getElementById("mdock-capture-session");
      const on = typeof State !== "undefined" && State.mode === "designer" && State.regMode === "photo";
      if (d && d.classList) d.classList.toggle("hidden", !on);
    },

    /** 탭 모드 활성(armed) 여부 — 20_App.js _bindMap() 의 mousedown 분기가 Zones/Routes 와
     *  같은 자리에서 이 값으로 양보 여부를 묻는다. */
    isArmedTap() { return !!(this._s && this._s.mode === "tap" && !this._s.done); },
    /** 지도 탭 1회 처리(Zones.onDrawStart/Routes.onDrawStart 와 동일 호출 규약 — clientX/clientY,
     *  처리했으면 true). 20_App.js _bindMap() 이 State.placing/drawingZone/drawingRoute 분기와
     *  같은 자리에서 직접 호출한다(별도 "click" 리스너가 아님 — 위 mountDockButton 주석 참조). */
    onDrawStart(clientX, clientY) {
      if (!this.isArmedTap()) return false;
      if (typeof MapCtrl === "undefined" || !MapCtrl.viewportToPercent) return false;
      const pct = MapCtrl.viewportToPercent(clientX, clientY);
      if (!pct) return false;
      const r = this.addTap(State.pins, { x: +pct.x.toFixed(3), y: +pct.y.toFixed(3) });
      if (!r) return false;
      if (typeof UI !== "undefined") { UI.renderPinList && UI.renderPinList(); UI.renderPinsOnMap && UI.renderPinsOnMap(r.pin.id); }
      this._toast((this._s.taps.length) + "번째 정지점 — " + r.tap.name + " · THETA 로 촬영하세요");
      return true;
    },

    open() {
      if (typeof ThetaIntake === "undefined" || !ThetaIntake._sheet) { this._toast("촬영 세션 모듈을 불러오지 못했습니다"); return; }
      if (this._s && !this._s.done) { this._openActiveSheet(); return; }
      this._openStartSheet();
    },
    async _openStartSheet() {
      const zoneName = (typeof Projects !== "undefined" && Projects.currentDeck && Projects.currentDeck.name) || "";
      const r = await Prompt.ask({ title: "촬영 세션 — 구역/이름", sub: "구역명(이름 규칙: 구역명-번호) · 시작 번호", placeholder: "구역명", value: zoneName, second: "시작 번호(기본 1)" });
      if (!r) return;
      const startNo = parseInt(r.second, 10);
      ThetaIntake._sheet({
        id: "capsess-mode-sheet",
        title: "촬영 세션 — 방식 선택",
        body: "정지점 탭: 걸으면서 멈출 때마다 도면을 탭 → THETA 로 촬영.\n동선: 선을 그린 뒤 연속 촬영(탭 없음).",
        actions: [
          { label: "📍 정지점 탭(기본)", primary: true, run: () => this.start({ mode: "tap", zoneName: r.value, startNo: Number.isFinite(startNo) ? startNo : 1, page: (typeof State !== "undefined" ? State.pdfPage : 1) || 1 }).then(() => this._toast("세션 시작 — 도면을 탭해 정지점을 기록하세요")) },
          { label: "🧵 동선 그리기", run: () => { if (typeof Routes !== "undefined" && Routes.toggleDraw) Routes.toggleDraw(); this.start({ mode: "route", zoneName: r.value, startNo: Number.isFinite(startNo) ? startNo : 1, page: (typeof State !== "undefined" ? State.pdfPage : 1) || 1 }).then(() => this._toast("동선을 그리고 완료하면 연속 촬영을 시작하세요")); } },
          { label: "취소", run: () => {} }
        ]
      });
    },
    _openActiveSheet() {
      const s = this._s;
      ThetaIntake._sheet({
        id: "capsess-active-sheet",
        title: "촬영 세션 진행 중",
        body: (s.mode === "tap" ? ("정지점 " + s.taps.length + "개 기록됨") : "동선 모드") + " — 사진을 선택해 일괄 등록하거나 세션을 종료하세요.",
        actions: [
          { label: "📷 사진 선택 → 일괄 등록", primary: true, run: () => { const inp = document.getElementById("input-capture-session"); if (inp) inp.click(); } },
          // [WO THETA-OSC 20261019] 세션 중 [카메라로 촬영] — 73_ThetaOSC.js 에 세션을 넘겨 FAB가
          // "다음 핀 촬영"으로 동작하게 한다(함수 경계로만 연결, CaptureSession 내부 재구현 없음).
          { label: "📡 카메라로 촬영", run: () => { if (typeof ThetaOSC !== "undefined" && ThetaOSC.open) ThetaOSC.open({ session: s }); else this._toast("카메라 모듈을 불러오지 못했습니다"); } },
          { label: "↩ 세션 되돌리기(생성 핀 전부 취소)", run: () => this.undo().then((r) => this._toast(r.removed + "개 핀 되돌림")) },
          { label: "닫기", run: () => {} }
        ]
      });
    },
    async _onFilesChosen(files) {
      if (!this._s) return;
      if (this._s.mode === "tap") {
        const prev = await this.finishTapPreview(files);
        if (!prev) return;
        this._lastTapPreview = prev;
        this._showTapPreviewSheet(prev);
      } else if (this._s.mode === "route") {
        const placed = await this.finishRoutePreview(files);
        if (!placed) return;
        this._lastRoutePlaced = placed;
        this._renderGhostStops(placed);
        ThetaIntake._sheet({
          id: "capsess-preview-sheet", title: "미리보기 — 동선 배치",
          body: placed.length + "개 정지점(파란 점, 드래그로 위치 보정) — 확인하면 핀이 생성되고 사진이 연결됩니다.",
          actions: [
            { label: "확인 → 핀 생성·사진 연결", primary: true, run: () => this._confirmRoutePreview() },
            { label: "취소", run: () => this._removeGhostStops() }
          ]
        });
      }
    },

    /** 탭 모드 미리보기 시트 — ThetaIntake._sheet 는 텍스트 body + 버튼만 지원(§33 공용 규약) 이라
     *  수동 오프셋 슬라이더(±120초)는 반환된 시트 DOM에 직접 삽입한다(판정기준 §3 "실시간 매칭 갱신"). */
    _showTapPreviewSheet(prev) {
      const summarize = (r) => r.matches.length + "건 매칭 · 미연결 탭 " + r.unmatchedTaps.length + " · 미연결 사진 " + r.unmatchedPhotos.length
        + (r.autoOffsetMs ? (" · 자동보정 " + Math.round(r.autoOffsetMs / 1000) + "초") : "");
      const sheetEl = ThetaIntake._sheet({
        id: "capsess-preview-sheet", title: "미리보기 — 정지점 탭", body: summarize(prev),
        actions: [
          { label: "확인 → 일괄 등록", primary: true, run: () => this.confirmTapRegister(State.pins, (this._lastTapPreview || prev).matches).then((r) => this._toast("등록 완료 " + r.done + "건")) },
          { label: "취소", run: () => {} }
        ]
      });
      if (!sheetEl || typeof document === "undefined") return;
      const curSec = Math.round((this._s.manualOffsetMs || 0) / 1000);
      const row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;gap:10px;margin:6px 4px 10px;";
      const lbl = document.createElement("span");
      lbl.style.cssText = "font-size:12px;min-width:92px;flex:none;";
      lbl.textContent = "수동 시계보정 " + curSec + "초";
      const slider = document.createElement("input");
      slider.type = "range"; slider.min = String(-this.MANUAL_OFFSET_MAX_S); slider.max = String(this.MANUAL_OFFSET_MAX_S); slider.step = "1";
      slider.value = String(curSec);
      slider.style.cssText = "flex:1;min-width:0;";
      slider.setAttribute("aria-label", "수동 시계보정(초)");
      slider.addEventListener("input", async () => {
        const sec = parseInt(slider.value, 10) || 0;
        this.setManualOffsetSec(sec);
        await this._persist();
        const r = await this._recomputeTapPreview();
        this._lastTapPreview = r;
        lbl.textContent = "수동 시계보정 " + sec + "초";
        const bodyEl = sheetEl.querySelector(".theta-sheet-body");
        if (bodyEl && r) bodyEl.textContent = summarize(r);
      });
      row.appendChild(lbl); row.appendChild(slider);
      const titleEl = sheetEl.querySelector(".theta-sheet-title");
      if (titleEl && titleEl.nextSibling) sheetEl.insertBefore(row, titleEl.nextSibling);
      else sheetEl.appendChild(row);
    },

    /** 동선 미리보기 확정 — 드래그로 보정된 placed[].x/y 그대로 핀 생성 + 사진 연결(§지시: 생성될 핀 위치
     *  표시 → 드래그 보정 → 확정). 되돌리기 쉽게 핀 생성 → ghost 제거 순서(사용자가 보던 자리에서 바로 실핀으로). */
    async _confirmRoutePreview() {
      const placed = this._lastRoutePlaced;
      if (!placed) return;
      const created = this.createRoutePins(State.pins, placed);
      this._removeGhostStops();
      if (typeof UI !== "undefined") { UI.renderPinList && UI.renderPinList(); UI.renderPinsOnMap && UI.renderPinsOnMap(); }
      const r = await this.confirmRouteRegister(State.pins, placed);
      this._toast("등록 완료 " + r.done + "건 · 핀 " + created.length + "개");
      return r;
    },

    /* ══ 동선 미리보기 드래그 보정(ghost 점 — 실 핀 아님, 확정 전까지 State.pins 에 없음) ══ */
    _ghostEls: null,
    _renderGhostStops(placed) {
      this._removeGhostStops();
      if (typeof document === "undefined") return;
      const layer = document.getElementById("pins-layer");
      if (!layer) return;
      this._ghostEls = [];
      (placed || []).forEach((st) => {
        const el = document.createElement("div");
        el.className = "capsess-ghost-stop";
        el.dataset.no = String(st.no);
        el.style.cssText = "position:absolute;left:" + st.x + "%;top:" + st.y + "%;width:26px;height:26px;margin:-13px 0 0 -13px;"
          + "border-radius:50%;background:#2563eb;border:2px solid #ffffff;color:#ffffff;display:flex;align-items:center;justify-content:center;"
          + "font-size:11px;font-weight:800;z-index:60;cursor:grab;touch-action:none;box-shadow:0 1px 5px rgba(0,0,0,.45);user-select:none;";
        el.textContent = String(st.no);
        el.title = "정지점 " + st.no + " — 드래그로 위치 보정";
        this._bindGhostDrag(el, st);
        layer.appendChild(el);
        this._ghostEls.push(el);
      });
    },
    _bindGhostDrag(el, st) {
      let dragging = false;
      const onMove = (ev) => {
        if (!dragging) return;
        const cx = ev.touches ? ev.touches[0].clientX : ev.clientX;
        const cy = ev.touches ? ev.touches[0].clientY : ev.clientY;
        const pct = (typeof MapCtrl !== "undefined" && MapCtrl.viewportToPercent) ? MapCtrl.viewportToPercent(cx, cy) : null;
        if (!pct) return;
        st.x = Math.max(0, Math.min(100, pct.x));
        st.y = Math.max(0, Math.min(100, pct.y));
        el.style.left = st.x + "%"; el.style.top = st.y + "%";
        if (ev.cancelable) ev.preventDefault();
      };
      const onUp = () => {
        dragging = false;
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
      };
      el.addEventListener("pointerdown", (ev) => {
        dragging = true;
        document.addEventListener("pointermove", onMove);
        document.addEventListener("pointerup", onUp);
        if (ev.cancelable) ev.preventDefault();
      });
    },
    _removeGhostStops() {
      ((this._ghostEls) || []).forEach((el) => { try { el.remove(); } catch (e) {} });
      this._ghostEls = [];
    },
    _toast(m, ms) { try { if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast(m, ms); } catch (e) {} }
  };
