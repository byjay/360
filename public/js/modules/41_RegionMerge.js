  /* ══════════════════════════════════════════
     REGION MERGE — [WO 20260930-merge] 구역 단위 포인트 합치기 (설계 .tmp/design-multiuser.md §6 D5)
     마스터: "다른 사람이 한 포인트도 전체 복사해서 구역 단위로 합치는 기능도 구현해.
             모든 기능은 가장 쉽고 심플하지만 강력하고 버그 없이."

     동선: 트리의 "지금 열린 구역/영역" 행 → [다른 구역 포인트 가져오기] → 모달 1장
           ① 가져올 구역(핀 수 · 좌표 변환 가능/불가 배지) ② 사진 O / 노트 X
           ③ 미리보기 "N개 중 M개 · K개 범위 밖 · 번호 중복 J건 · 같은 위치 중복 의심 D건" ④ [가져오기]
           → 토스트 [되돌리기] (배치 단위)

     🔴 규칙(바꾸지 마라 — 테스트 p96 이 지킨다):
       · 좌표: 새 수식 0. MapCtrl.deckCropPctToPage / pageToDeckCropPct 두 순수함수만 쓴다.
         공통 좌표계 = 구역의 "기준 배포본 페이지 %"(boxOf). 벡터 복사 구역은 0031 src_* 기록이 있어야 변환된다.
         범위 밖 핀은 가져오지 않고 개수만 사실대로 표시한다.
       · 모드: 구역은 CHECKER/360 공유(모드로 구역을 거르지 않는다 — decks.mode 비의존).
         **핀만** 활성 모드 계열(PinSeries.seriesOf == PinSeries.activeSeries())로 거른다.
         🔴 [WO 20261019-unifymode] 모드 통일 — 핀도 계열로 거르지 않는다(series = null = 전부). plan()의 series 인자는 하위호환.
       · 번호: 원본 번호 유지(자동 재채번 없음). 중복은 PinSeries.duplicateCheckboardIds 로 **표시만**.
       · 첨부: 360 사진은 imageId 참조 공유(R2 복제 0) · URL 문자열 복사 · 노트(pin_notes)는 기본 미복사.
       · 멱등: 복사 핀에 srcDeckId·srcPinId·mergeBatchId. 같은 원본을 두 번 합치면 두 번째는 0건(증분).
       · 되돌리기: mergeBatchId 핀 전부를 App._removePins(기존 삭제 경로 · tombstone) 로 지운다.
       · Jev: "같은 위치 중복 핀" 판정에만. 표시·선택 해제 기본값에만 쓰고 삭제·확정엔 안 쓴다.
         게이트 p≥0.90 사용 / 0.70~0.90 「추정」 / p<0.70·실패·키 없음·타임아웃 → 거리 규칙.
     ══════════════════════════════════════════ */
  const RegionMerge = {
    /** 거리 규칙(폴백) — 대상 구역 화면 기준 % 거리가 이 값 미만이면 "같은 위치".
     *  근거: 핀 마커(지름 약 28px)는 화면 맞춤 상태의 구역 폭(데스크톱 1200~1900px)에서 1.5~2.3% 를 차지한다.
     *  중심 거리 1% 미만이면 두 마커가 절반 이상 겹쳐 사람 눈에도 한 점으로 보인다 — 보수적으로(과잉 "중복" 방지) 1% 로 둔다. */
    SAME_PCT: 1.0,
    /** Jev 질의 창 — 이 거리 안에 대상 핀이 있는 쌍만 Jev 에 묻는다(마커 1~2개 폭). 밖은 규칙으로 "다른 지점"(호출 0). */
    NEAR_PCT: 3.0,
    /** 확률 게이트(전역 CLAUDE.md §1-B · 스킬 §3). 표시용 판정이라 기본값을 그대로 쓴다. */
    P_USE: 0.90,
    P_EST: 0.70,
    /** 한 요청 쌍 상한 — 서버 src/lib/jevDup.ts DUP_MAX_PAIRS 와 같은 값(초과분은 나눠 보낸다). */
    JEV_CHUNK: 40,
    /** "사진 함께" 옵션이 다루는 필드 — 끄면 이 필드를 싣지 않는다. */
    PHOTO_KEYS: ["imageId", "imageUrl", "imageName", "is360", "isVideo", "videoUrl"],
    /** 세션 전용·로컬 상태 필드 — 복사하지 않는다(다른 기기의 blob·업로드 진행 표시). */
    DROP_KEYS: ["id", "localPreview", "pendingSync", "uploading", "_deleted", "srcDeckId", "srcPinId", "mergeBatchId"],

    _last: null,       // 마지막 배치 { batchId, ids, noteIds, depId }
    _ctx: null,        // 모달 상태

    /* ══ 순수 함수 ══════════════════════════════════════════ */

    /** 합치기용 구역 키 — 실제 구역은 id, 구역 행이 없는 원본 도면(pickOriginalDeck 의 id:null)은 "dep:<배포본>". */
    deckKey(deck) { return deck && deck.id != null ? String(deck.id) : "dep:" + String((deck && deck.deployment_id) || ""); },

    /** 구역이 차지하는 상자 = { dep(기준 배포본), page(기준 페이지|null=전 페이지), crop(기준 페이지 %|null), copy }.
     *  · 벡터 복사 구역(0031 기록): 기준 = 원본 배포본의 src_page·src_crop. 자기 핀은 복사본 1페이지의 crop 기준 %.
     *  · 창 구역·원본·기록 없는 레거시 복사본: 기준 = 자기 배포본(page·crop). 핀은 그 페이지 %(H7 이후 저장 형식). */
    boxOf(deck) {
      if (!deck) return null;
      const sc = deck.src_crop;
      if (deck.src_dep_id && sc && sc.w > 0 && sc.h > 0) {
        return { dep: String(deck.src_dep_id), page: Number(deck.src_page) || 1, crop: sc, copy: true };
      }
      const c = deck.crop && deck.crop.w > 0 && deck.crop.h > 0 ? deck.crop : null;
      return { dep: String(deck.deployment_id || ""), page: deck.page != null ? Number(deck.page) : null, crop: c, copy: false };
    },

    /** 두 구역 사이 좌표 변환 가능 = 같은 기준 배포본. 아니면 "좌표 그대로 얹기"만(기본 미선택). */
    canTransform(srcDeck, dstDeck) {
      const a = this.boxOf(srcDeck), b = this.boxOf(dstDeck);
      return !!(a && b && a.dep && a.dep === b.dep);
    },

    /** 배포본의 핀 중 이 구역 화면에 보이는 핀인가(창 구역은 그 페이지·crop 안만). */
    inDeck(box, p) {
      if (!p || !box) return false;
      if (box.copy) return true;
      if (box.page != null && (p.page || 1) !== box.page) return false;
      return !box.crop || MapCtrl.pageToDeckCropPct(p.x, p.y, box.crop) !== null;
    },

    /** 구역 핀(저장 좌표) → 기준 배포본 페이지 % */
    toBase(box, p) {
      if (box.copy) { const q = MapCtrl.deckCropPctToPage(p.x, p.y, box.crop); return { page: box.page, x: q.x, y: q.y }; }
      return { page: p.page || 1, x: p.x, y: p.y };
    },

    /** 기준 페이지 % → 대상 구역 저장 좌표. 대상 범위 밖이면 null(가져오지 않는다). */
    fromBase(box, b) {
      if (box.page != null && b.page !== box.page) return null;
      if (box.copy) {
        const q = MapCtrl.pageToDeckCropPct(b.x, b.y, box.crop);
        return q ? { page: 1, x: q.x, y: q.y } : null;
      }
      if (box.crop && MapCtrl.pageToDeckCropPct(b.x, b.y, box.crop) === null) return null;
      return { page: b.page, x: b.x, y: b.y };
    },

    /** 구역 핀 → 그 구역 화면 기준 %(보이는 그대로). 거리 판정·"그대로 얹기"의 좌표계. */
    toDisplay(box, p) {
      if (box.copy || !box.crop) return { x: p.x, y: p.y };
      return MapCtrl.pageToDeckCropPct(p.x, p.y, box.crop);
    },

    /** 화면 기준 % → 대상 구역 저장 좌표("좌표 그대로 얹기": 원본 화면에서 보이던 상대 위치 그대로). */
    fromDisplay(box, d, page) {
      if (box.copy) return { page: 1, x: d.x, y: d.y };
      const pg = box.page != null ? box.page : (page || 1);
      if (!box.crop) return { page: pg, x: d.x, y: d.y };
      const q = MapCtrl.deckCropPctToPage(d.x, d.y, box.crop);
      return { page: pg, x: q.x, y: q.y };
    },

    /** 합치기 계획(순수). srcPins = 원본 배포본 핀 전체(살아있는 것), dstPins = 대상 현재 핀.
     *  @returns {{items:[{src,pos}], total, outside, already, otherMode}} */
    plan({ srcDeck, dstDeck, srcPins, dstPins, raw, series }) {
      const sb = this.boxOf(srcDeck), db = this.boxOf(dstDeck);
      const srcKey = this.deckKey(srcDeck), dstKey = this.deckKey(dstDeck);
      const have = new Set();
      (dstPins || []).forEach((p) => { if (p && p.srcDeckId != null && p.srcPinId != null) have.add(String(p.srcDeckId) + "\u0000" + String(p.srcPinId)); });
      // [WO 20261012-pinsync] 같은 id 핀이 대상에 이미 있으면 같은 핀이다 — 원본↔벡터 복사 구역은 서버가 핀을 공유(별칭)하므로
      //   원본·형제 구역에서 가져오면 그 핀들이 이미 보인다 → "이미 있음"(자기 복제 0). 후보 목록은 그대로 둔다:
      //   다른 구역이 연동(별칭)인지 아직 따로 저장(pending)인지는 그 배포본을 읽어야 알 수 있어 목록 단계에서 거르지 않는다.
      const sameId = new Set();
      (dstPins || []).forEach((p) => { if (p && p.id != null && !p._deleted) sameId.add(String(p.id)); });
      const out = { items: [], total: 0, outside: 0, already: 0, otherMode: 0 };
      (srcPins || []).forEach((p) => {
        if (!p || p._deleted || !this.inDeck(sb, p)) return;
        if (series && PinSeries.seriesOf(p) !== series) { out.otherMode++; return; }
        out.total++;
        // 🔴 멱등 — 이미 가져온 핀(같은 원본 구역·같은 원본 핀) · 대상에서 건너갔던 핀(되돌려 합치면 자기 복제)
        if (have.has(srcKey + "\u0000" + String(p.id)) || (p.srcDeckId != null && String(p.srcDeckId) === dstKey) || sameId.has(String(p.id))) { out.already++; return; }
        let pos = null;
        if (raw) { const d = this.toDisplay(sb, p); pos = d ? this.fromDisplay(db, d, p.page || 1) : null; }
        else pos = this.fromBase(db, this.toBase(sb, p));
        if (!pos) { out.outside++; return; }
        out.items.push({ src: p, pos });
      });
      return out;
    },

    /** 복사 핀 생성(순수). id 는 문자열 "mg<batch>-<n>" — Date.now() 숫자 id 공간과 절대 겹치지 않는다(동시 작업자 충돌 0). */
    buildPins(items, { srcDeck, photos, batchId, takenIds }) {
      const taken = new Set(Array.from(takenIds || []).map(String));
      const srcKey = this.deckKey(srcDeck);
      let n = 0;
      return (items || []).map((it) => {
        const pin = {};
        Object.keys(it.src).forEach((k) => { if (this.DROP_KEYS.indexOf(k) < 0) pin[k] = it.src[k]; });
        if (!photos) this.PHOTO_KEYS.forEach((k) => { delete pin[k]; });
        if (typeof pin.videoUrl === "string" && pin.videoUrl.indexOf("blob:") === 0) delete pin.videoUrl;   // 다른 기기의 로컬 blob
        let id;
        do { id = "mg" + batchId + "-" + (n++); } while (taken.has(id));
        taken.add(id);
        pin.id = id;
        pin.x = it.pos.x; pin.y = it.pos.y; pin.page = it.pos.page;
        const ca = PinSeries.createdAt(it.src);
        if (ca != null) pin.createdAt = ca;              // 원본 생성시각 유지(사진-시각 매칭 SoT)
        pin.srcDeckId = srcKey; pin.srcPinId = String(it.src.id); pin.mergeBatchId = batchId;
        return pin;
      });
    },

    /** 번호 중복(표시용) — 가져올 핀 중 대상과 번호가 겹치는 수. 정본 PinSeries.duplicateCheckboardIds 재사용. */
    dupNumberCount(newPins, dstPins) {
      const all = (dstPins || []).concat(newPins || []);
      const mine = new Set((newPins || []).map((p) => String(p.id)));
      const pages = new Set((newPins || []).map((p) => p.page || 1));
      let n = 0;
      pages.forEach((pg) => { PinSeries.duplicateCheckboardIds(all, pg).forEach((id) => { if (mine.has(String(id))) n++; }); });
      return n;
    },

    _brief(p) { return { label: String(p.label == null ? "" : p.label), note: String(p.note || ""), photo: String(p.imageName || "") }; },

    /** "같은 위치" 후보 쌍 — 새 핀마다 대상의 같은 계열·같은 페이지 핀 중 가장 가까운 것(화면 %)이 NEAR_PCT 안이면 1쌍. */
    nearPairs(newPins, dstPins, dstDeck) {
      const box = this.boxOf(dstDeck);
      const pairs = [];
      (newPins || []).forEach((np, i) => {
        const a = this.toDisplay(box, np);
        if (!a) return;
        let best = null, bd = Infinity;
        (dstPins || []).forEach((e) => {
          if (!e || e._deleted || (e.page || 1) !== (np.page || 1)) return;   // [WO 20261019-unifymode] 계열 무관(핀은 하나)
          const b = this.toDisplay(box, e);
          if (!b) return;
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (d < bd) { bd = d; best = e; }
        });
        if (best && bd < this.NEAR_PCT) pairs.push({ i, distance_pct: bd, existingId: best.id, incoming: this._brief(np), existing: this._brief(best) });
      });
      return pairs;
    },

    /** 🔴 판정 게이트 SoT — probe = 서버 Jev 원시 결과 { ok, label, p } | { ok:false, error } | null.
     *  p≥P_USE → Jev 그대로 · P_EST≤p<P_USE → Jev + 「추정」 · 그 외(낮은 p·실패·키 없음·타임아웃) → 거리 규칙.
     *  🔴 확률을 버리고 라벨만 쓰지 않는다 — p 를 결과에 남긴다(감사). */
    decideDup(pair, probe) {
      if (probe && probe.ok && typeof probe.p === "number" && probe.p >= this.P_EST && (probe.label === "same" || probe.label === "different")) {
        return { verdict: probe.label, p: probe.p, source: "jev", estimated: probe.p < this.P_USE };
      }
      return {
        verdict: pair.distance_pct < this.SAME_PCT ? "same" : "different",
        p: probe && probe.ok && typeof probe.p === "number" ? probe.p : null,
        source: "rule", estimated: false,
        reason: !probe ? "no-probe" : (probe.ok ? "low-p" : String(probe.error || "error"))
      };
    },

    /* ══ I/O ══════════════════════════════════════════════════ */

    /** 쌍 → 판정. 서버 /api/merge/dup-check(키는 서버 시크릿). 네트워크·서버 실패도 거리 규칙으로 판정(조용한 실패 금지 — reason 기록). */
    async checkDups(pairs) {
      const probes = new Map();
      for (let s = 0; s < pairs.length; s += this.JEV_CHUNK) {
        const chunk = pairs.slice(s, s + this.JEV_CHUNK);
        let res = null;
        try {
          const r = await fetch("/api/merge/dup-check", {
            method: "POST", headers: Auth.headers(),
            body: JSON.stringify({ pairs: chunk.map((p) => ({ i: p.i, distance_pct: p.distance_pct, incoming: p.incoming, existing: p.existing })) })
          });
          res = r.ok ? await r.json() : { ok: false, error: "http-" + r.status };
        } catch (e) { res = { ok: false, error: navigator.onLine ? "network" : "offline" }; }
        chunk.forEach((p) => {
          if (res && res.ok && Array.isArray(res.probes)) probes.set(p.i, res.probes.find((q) => q && q.i === p.i) || { ok: false, error: "missing" });
          else probes.set(p.i, { ok: false, error: (res && res.error) || "error" });
        });
      }
      return pairs.map((p) => Object.assign({ i: p.i, existingId: p.existingId, distance_pct: p.distance_pct }, this.decideDup(p, probes.get(p.i))));
    },

    /** 배포본의 살아있는 핀 — 서버본 tombstone 제외(App._live SoT). */
    async fetchPins(depId) {
      const r = await fetch("/tables/deployments/" + encodeURIComponent(depId), { headers: Auth.headers() });
      if (!r.ok) throw new Error("http-" + r.status);
      const d = await r.json();
      let pins = [];
      try { pins = JSON.parse((d && d.pins) || "[]"); } catch (e) { pins = []; }
      return (typeof App !== "undefined" && App._live) ? App._live(pins) : pins.filter((p) => p && !p._deleted);
    },

    /** 대상(지금 열린 구역)이 합치기를 받을 수 있는가 — 설계자 편집 화면 + 로드된 배포본. */
    canMergeInto(deck) {
      return !!deck && typeof State !== "undefined" && State.mode === "designer"
        && typeof Auth !== "undefined" && !!Auth.isDesigner && !Auth.readonly
        && !!deck.deployment_id && String(State.currentDeploymentId || "") === String(deck.deployment_id);
    },

    /** 원본 후보 — 같은 프로젝트의 구역/영역(+ 구역 행 없는 원본 도면). 대상과 같은 배포본(=같은 핀을 이미 보는 창)은 제외.
     *  🔴 모드로 구역을 거르지 않는다(구역은 CHECKER/360 공유 — 마스터 확정). */
    candidates(dstDeck) {
      const decks = ((typeof Projects !== "undefined" && Projects.decks) || []).slice();
      const orig = (typeof Projects !== "undefined" && Projects.pickOriginalDeck) ? Projects.pickOriginalDeck(decks) : null;
      if (orig && orig.id == null && orig.deployment_id) decks.push(Object.assign({}, orig, { name: (orig.name || "원본") + " (전체 도면)" }));
      return decks.filter((d) => d && d.deployment_id && this.deckKey(d) !== this.deckKey(dstDeck)
        && String(d.deployment_id) !== String(dstDeck.deployment_id));
    },

    /** 미리보기 1회 계산(모달·테스트 공용). opts = { raw, photos }. */
    async prepare(dstDeck, srcDeck, opts) {
      opts = opts || {};
      const series = null;   // [WO 20261019-unifymode] 계열 거름 없음
      const srcPins = await this.fetchPins(srcDeck.deployment_id);
      const dstPins = (State.pins || []).slice();
      const plan = this.plan({ srcDeck, dstDeck, srcPins, dstPins, raw: !!opts.raw, series });
      const batchId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const pins = this.buildPins(plan.items, { srcDeck, photos: opts.photos !== false, batchId, takenIds: dstPins.map((p) => p.id) });
      const dupNos = this.dupNumberCount(pins, dstPins);
      const pairs = this.nearPairs(pins, dstPins, dstDeck);
      const dups = pairs.length ? await this.checkDups(pairs) : [];
      // 선택 기본값 — "같은 위치" 판정 핀만 해제(가져오지 않음). 사용자가 다시 켤 수 있다(확정 판단은 사람).
      const include = pins.map((_, i) => !dups.some((d) => d.i === i && d.verdict === "same"));
      return { dstDeck, srcDeck, series, plan, pins, batchId, dupNos, dups, include, raw: !!opts.raw, photos: opts.photos !== false };
    },

    /** 적용 — 핀 추가 경로(20_App 신규 핀과 같은 순서): State.pins → 렌더 → 오프라인 OpLog → _autoSave(draft+dirty).
     *  @returns {{batchId, ids}} */
    apply(prep, include) {
      include = include || prep.include;
      const add = prep.pins.filter((_, i) => include[i]);
      if (!add.length) return { batchId: prep.batchId, ids: [] };
      State.pins = (State.pins || []).concat(add);
      if (typeof Log !== "undefined" && Log.push) Log.push("pin.merge", prep.batchId, { from: this.deckKey(prep.srcDeck), n: add.length });
      if (typeof Zones !== "undefined" && Zones.refreshPinLinks) Zones.refreshPinLinks();
      if (typeof UI !== "undefined") { UI.renderPinList && UI.renderPinList(); UI.renderPinsOnMap && UI.renderPinsOnMap(); }
      if (typeof PinGrid !== "undefined" && PinGrid.render) { try { PinGrid.render(); } catch (e) {} }
      // [WO offline2 회귀수정] 로컬 스냅샷은 아래 App._autoSave 가 공유 SoT로 1회만 쓴다
      //   (persistLocalDeployment 중복 호출 제거)
      if (!navigator.onLine && typeof OpLog !== "undefined" && OpLog.recordCurrent) {
        add.reduce((pr, p) => pr.then(() => OpLog.recordCurrent("pin", "upsert", p.id, p)), Promise.resolve())
          .catch(() => {});
      }
      if (typeof App !== "undefined" && App._autoSave) App._autoSave();
      const batch = { batchId: prep.batchId, ids: add.map((p) => p.id), noteIds: [], depId: State.currentDeploymentId };
      this._last = batch;
      return batch;
    },

    /** 되돌리기 — 그 배치의 핀 전부를 기존 삭제 경로(App._removePins: tombstone·OpLog·_autoSave)로. 복사한 노트도 지운다. */
    async undo(batch) {
      batch = batch || this._last;
      if (!batch) return 0;
      if (String(State.currentDeploymentId || "") !== String(batch.depId || "")) {
        Prompt.toast && Prompt.toast("다른 구역이 열려 있어 되돌릴 수 없습니다 — 가져온 구역을 다시 열고 핀을 지우세요", 4200);
        return 0;
      }
      const ids = (State.pins || []).filter((p) => p && p.mergeBatchId === batch.batchId).map((p) => p.id);
      const removed = (typeof App !== "undefined" && App._removePins) ? App._removePins(ids) : [];
      for (const nid of batch.noteIds || []) {
        try { await fetch("/api/notes/" + encodeURIComponent(nid), { method: "DELETE", headers: Auth.headers() }); } catch (e) {}
      }
      if (this._last === batch) this._last = null;
      return removed.length;
    },

    /** 노트(pin_notes) 복사 — 옵션. 🔴 핀이 서버에 저장된 뒤에만(안 그러면 없는 핀에 노트가 붙는다). 본문 앞에 출처 표기. */
    async copyNotes(prep, batch) {
      const srcDep = prep.srcDeck.deployment_id, dstDep = batch.depId;
      const r = await fetch("/api/notes?deployment_id=" + encodeURIComponent(srcDep), { headers: Auth.headers() });
      if (!r.ok) return { ok: false, n: 0 };
      const list = ((await r.json()) || {}).data || [];
      const byPin = new Map();
      prep.pins.forEach((p) => { if (batch.ids.indexOf(p.id) >= 0) byPin.set(String(p.srcPinId), p); });
      let n = 0;
      for (const note of list) {
        const pin = byPin.get(String(note.pin_id));
        if (!pin) continue;
        const body = ("[원본: " + (prep.srcDeck.name || "구역") + " #" + (pin.label == null ? "" : pin.label) + "] " + String(note.body || "")).slice(0, 4000);
        const w = await fetch("/api/notes", { method: "POST", headers: Auth.headers(),
          body: JSON.stringify({ deployment_id: dstDep, pin_id: pin.id, pin_label: pin.label || "", body, status: note.status, assignee: note.assignee || "" }) });
        if (w.ok) { const j = await w.json(); if (j && j.id) { batch.noteIds.push(j.id); n++; } }
      }
      return { ok: true, n };
    },

    /* ══ UI ══════════════════════════════════════════════════ */

    /** 트리 진입점 — 지금 열린(편집 가능) 구역/영역 행 아래에 버튼 1개. 조건 미달이면 null(렌더 안 함). */
    treeButton(deck, isCur) {
      if (!isCur || !this.canMergeInto(deck)) return null;
      const wrap = document.createElement("div");
      wrap.className = "tree-project-actions rm-tree-actions";
      const b = document.createElement("button");
      b.type = "button"; b.className = "btn-mini rm-open-btn";
      b.textContent = "다른 구역에서 가져오기";
      b.title = "같은 프로젝트의 다른 구역/영역에 있는 포인트를 이 구역으로 복사합니다(되돌리기 가능)";
      b.addEventListener("click", (e) => { e.stopPropagation(); this.open(deck); });
      wrap.appendChild(b);
      return wrap;
    },

    _el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; },

    _ensureModal() {
      let m = document.getElementById("rm-modal");
      if (m) return m;
      m = this._el("div", "admin-gate hidden");
      m.id = "rm-modal"; m.setAttribute("role", "dialog"); m.setAttribute("aria-modal", "true"); m.setAttribute("aria-labelledby", "rm-title");
      m.innerHTML =
        '<div class="admin-gate-backdrop"></div>' +
        '<div class="admin-gate-card rm-card">' +
        '<h2 id="rm-title" class="admin-gate-title">다른 구역의 포인트 가져오기</h2>' +
        '<p id="rm-sub" class="admin-gate-sub"></p>' +
        '<label class="rm-lbl" for="rm-src">① 가져올 구역</label>' +
        '<select id="rm-src" class="admin-gate-input"></select>' +
        '<p id="rm-badge" class="rm-badge"></p>' +
        '<label id="rm-raw-row" class="rm-chk hidden"><input type="checkbox" id="rm-raw"> 좌표 그대로 얹기 (원본 화면에서 보이던 상대 위치 — 실제 위치와 다를 수 있음)</label>' +
        '<div class="rm-opts"><span class="rm-lbl">② 함께 가져오기</span>' +
        '<label class="rm-chk"><input type="checkbox" id="rm-photos" checked> 사진</label>' +
        '<label class="rm-chk"><input type="checkbox" id="rm-notes"> 노트(대화)</label></div>' +
        '<p class="rm-lbl">③ 미리보기</p>' +
        '<p id="rm-preview" class="rm-preview" aria-live="polite"></p>' +
        '<div id="rm-dups" class="rm-dups"></div>' +
        '<div id="rm-err" class="admin-gate-error hidden"></div>' +
        '<div class="admin-gate-actions">' +
        '<button id="rm-cancel" class="admin-gate-btn ghost" type="button">취소</button>' +
        '<button id="rm-ok" class="admin-gate-btn primary" type="button">가져오기</button></div></div>';
      document.body.appendChild(m);
      m.querySelector(".admin-gate-backdrop").addEventListener("click", () => this.close());
      m.querySelector("#rm-cancel").addEventListener("click", () => this.close());
      m.querySelector("#rm-ok").addEventListener("click", () => this._commit());
      m.querySelector("#rm-src").addEventListener("change", () => this._refresh());
      m.querySelector("#rm-raw").addEventListener("change", () => this._refresh());
      m.querySelector("#rm-photos").addEventListener("change", () => this._refresh());
      m.addEventListener("keydown", (e) => { if (e.key === "Escape") this.close(); });
      return m;
    },

    close() {
      const m = document.getElementById("rm-modal");
      if (!m) return;
      m.classList.remove("on");
      setTimeout(() => m.classList.add("hidden"), 200);
      this._ctx = null;
    },

    /** 모달 열기 — 후보 구역마다 핀 수를 병렬로 센다. */
    async open(dstDeck) {
      if (!this.canMergeInto(dstDeck)) { Prompt.toast && Prompt.toast("지금 열린 구역에서만 가져올 수 있습니다(설계자 편집 화면)"); return; }
      if (!navigator.onLine) { Prompt.toast && Prompt.toast("오프라인이라 다른 구역의 포인트를 불러올 수 없습니다 — 연결 후 다시 시도하세요"); return; }
      const m = this._ensureModal();
      const cands = this.candidates(dstDeck);
      this._ctx = { dstDeck, cands, counts: new Map(), prep: null, seq: 0 };
      m.querySelector("#rm-sub").textContent = "대상: " + (dstDeck.name || "(이름 없음)");
      const sel = m.querySelector("#rm-src");
      sel.innerHTML = "";
      if (!cands.length) { sel.appendChild(this._el("option", null, "가져올 다른 구역이 없습니다")); sel.value = ""; }
      else cands.forEach((d, i) => { const o = this._el("option", null, this._candLabel(d, dstDeck, null)); o.value = String(i); sel.appendChild(o); });
      m.querySelector("#rm-raw").checked = false;
      m.querySelector("#rm-photos").checked = true;
      m.querySelector("#rm-notes").checked = false;
      m.classList.remove("hidden");
      requestAnimationFrame(() => m.classList.add("on"));
      const ctx = this._ctx;
      await Promise.all(cands.map(async (d, i) => {
        try {
          const pins = await this.fetchPins(d.deployment_id);
          const box = this.boxOf(d);
          ctx.counts.set(i, pins.filter((p) => this.inDeck(box, p)).length);
        } catch (e) { ctx.counts.set(i, null); }
        const o = sel.options[i];
        if (o && this._ctx === ctx) o.textContent = this._candLabel(d, dstDeck, ctx.counts.get(i));
      }));
      if (this._ctx === ctx) await this._refresh();
    },

    _candLabel(d, dstDeck, count) {
      const n = count === undefined || count === null ? (count === null ? "핀 수 확인 실패" : "…") : "핀 " + count + "개";
      return (d.name || "(이름 없음)") + (d.parent_id ? " (영역)" : "") + " · " + n + " · " + (this.canTransform(d, dstDeck) ? "좌표 변환 가능" : "좌표 변환 불가");
    },

    async _refresh() {
      const ctx = this._ctx, m = document.getElementById("rm-modal");
      if (!ctx || !m) return;
      const seq = ++ctx.seq;
      const idx = Number(m.querySelector("#rm-src").value);
      const src = ctx.cands[idx];
      const okB = m.querySelector("#rm-ok"), pv = m.querySelector("#rm-preview"), dupsEl = m.querySelector("#rm-dups");
      const badge = m.querySelector("#rm-badge"), rawRow = m.querySelector("#rm-raw-row"), err = m.querySelector("#rm-err");
      err.classList.add("hidden"); dupsEl.innerHTML = ""; ctx.prep = null; okB.disabled = true;
      if (!src) { pv.textContent = "가져올 구역이 없습니다."; badge.textContent = ""; rawRow.classList.add("hidden"); return; }
      const can = this.canTransform(src, ctx.dstDeck);
      badge.className = "rm-badge " + (can ? "ok" : "warn");
      badge.textContent = can
        ? "좌표 변환 가능 — 같은 원본 도면 기준으로 위치를 옮깁니다. 이 구역 범위 밖 핀은 가져오지 않습니다."
        : "좌표 변환 불가 — 두 구역의 원본 위치 관계가 기록돼 있지 않습니다(이전 방식으로 만든 구역이거나 다른 도면).";
      rawRow.classList.toggle("hidden", can);
      const raw = !can && m.querySelector("#rm-raw").checked;
      if (!can && !raw) { pv.textContent = "가져오려면 아래 \"좌표 그대로 얹기\"를 직접 선택하세요."; return; }
      pv.textContent = "계산 중…";
      let prep;
      try { prep = await this.prepare(ctx.dstDeck, src, { raw, photos: m.querySelector("#rm-photos").checked }); }
      catch (e) { if (seq === ctx.seq) { pv.textContent = ""; err.textContent = "원본 구역을 불러오지 못했습니다 — 네트워크를 확인하세요"; err.classList.remove("hidden"); } return; }
      if (seq !== ctx.seq || this._ctx !== ctx) return;   // 그 사이 다른 선택 — 낡은 결과 버림
      ctx.prep = prep;
      this._renderPreview();
    },

    _renderPreview() {
      const ctx = this._ctx, m = document.getElementById("rm-modal");
      const prep = ctx && ctx.prep;
      if (!prep) return;
      const pl = prep.plan;
      const sel = prep.include.filter(Boolean).length;
      const same = prep.dups.filter((d) => d.verdict === "same");
      const parts = ["핀 " + pl.total + "개 중 " + sel + "개 가져옴"];
      if (pl.outside) parts.push(pl.outside + "개는 대상 범위 밖");
      if (pl.already) parts.push(pl.already + "개는 이미 가져옴");
      if (prep.dupNos) parts.push("번호 중복 " + prep.dupNos + "건");
      if (same.length) parts.push("같은 위치 중복 의심 " + same.length + "건");
      m.querySelector("#rm-preview").textContent = parts.join(" · ") + (pl.otherMode ? "  (다른 모드 핀 " + pl.otherMode + "개 제외)" : "");
      const box = m.querySelector("#rm-dups");
      box.innerHTML = "";
      same.concat(prep.dups.filter((d) => d.verdict !== "same" && d.source === "jev" && d.estimated)).forEach((d) => {
        const pin = prep.pins[d.i];
        const row = this._el("label", "rm-chk rm-dup");
        const cb = document.createElement("input");
        cb.type = "checkbox"; cb.checked = !!prep.include[d.i];
        cb.addEventListener("change", () => { prep.include[d.i] = cb.checked; this._renderPreview(); });
        row.appendChild(cb);
        const how = d.source === "jev" ? ("Jev p=" + d.p.toFixed(2) + (d.estimated ? " 「추정」" : "")) : ("거리 규칙" + (d.reason ? "(" + d.reason + ")" : ""));
        row.appendChild(document.createTextNode(" #" + (pin.label == null ? "" : pin.label) + " — " + (d.verdict === "same" ? "같은 위치 의심" : "다른 지점") + " · " + d.distance_pct.toFixed(2) + "% · " + how));
        box.appendChild(row);
      });
      const okB = m.querySelector("#rm-ok");
      okB.disabled = sel === 0;
      okB.textContent = sel ? "가져오기 (" + sel + ")" : "가져올 핀 없음";
    },

    async _commit() {
      const ctx = this._ctx, m = document.getElementById("rm-modal");
      const prep = ctx && ctx.prep;
      if (!prep) return;
      const withNotes = m.querySelector("#rm-notes").checked;
      const batch = this.apply(prep);
      this.close();
      if (!batch.ids.length) return;
      let noteMsg = "";
      if (withNotes) {
        // 노트는 서버에 있는 핀에만 붙인다 — 먼저 저장(기존 '저장' 버튼과 같은 경로)
        const saved = (typeof App !== "undefined" && App._saveNow) ? await App._saveNow({ now: true }) : false;
        if (saved) { try { const r = await this.copyNotes(prep, batch); noteMsg = " · 노트 " + r.n + "건 복사"; } catch (e) { noteMsg = " · 노트 복사 실패"; } }
        else noteMsg = " · 저장 실패로 노트는 복사하지 않았습니다";
      }
      this._undoToast(batch.ids.length + "개 가져옴 — '" + (prep.srcDeck.name || "구역") + "'에서" + noteMsg + (withNotes ? "" : " · 저장을 눌러 반영"), batch);
    },

    /** 되돌리기 버튼이 달린 토스트 — Prompt.toast 호스트(#wm-toast-host)·스타일(.wm-toast) 재사용. 8초 유지. */
    _undoToast(msg, batch) {
      let host = document.getElementById("wm-toast-host");
      if (!host) { host = this._el("div", "wm-toast-host"); host.id = "wm-toast-host"; document.body.appendChild(host); }
      const t = this._el("div", "wm-toast rm-undo-toast");
      t.appendChild(this._el("span", null, msg));
      const b = this._el("button", "rm-undo-btn", "되돌리기");
      b.type = "button";
      b.addEventListener("click", async () => {
        b.disabled = true;
        const n = await this.undo(batch);
        t.remove();
        if (n) Prompt.toast && Prompt.toast("가져오기를 되돌렸습니다(" + n + "개 제거) · 저장을 눌러 반영", 3600);
      });
      t.appendChild(b);
      host.appendChild(t);
      requestAnimationFrame(() => t.classList.add("on"));
      setTimeout(() => { t.classList.remove("on"); setTimeout(() => t.remove(), 280); }, 8000);
    }
  };
