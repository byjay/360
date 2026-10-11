  /* ══════════════════════════════════════════════════════════════════
     OFFLINE  — 오프라인 완전작업 (다운로드 → 오프라인편집 → 자동싱크 · 충돌0)
     작업지시서 SEASTAR_OFFLINE_WORKORDER 
     실식별자 보정: State.depId → State.autoSaveDepId, Auth.currentUser → Auth.user
     IndexedDB 키(SyncQueue.DRAFT_STORE, keyPath="key"):
       bundle:manifest:<projectId> / bundle:project:<projectId> / bundle:decks:<projectId>
       bundle:dep:<deploymentId>  / bundle:pano:<imageId>      / oplog:<deploymentId>
  ══════════════════════════════════════════════════════════════════ */

  // 현재 열려있는 배포본 id (작업지시서의 State.depId 대응)
  function _curDepId() {
    if (typeof State !== "undefined" && State.autoSaveDepId) return State.autoSaveDepId;
    if (typeof Projects !== "undefined" && Projects.currentDeck && Projects.currentDeck.deployment_id)
      return Projects.currentDeck.deployment_id;
    return null;
  }
  function _authHeaders() {
    return (typeof Auth !== "undefined" && Auth.headers) ? Auth.headers() : {};
  }
  function _toast(msg) {
    if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast(msg);
  }

  /* ── 온라인: 프로젝트 전체 번들 다운로드 ─────────────────────────── */
  const OfflineBundle = {
    /** 프로젝트 전체를 오프라인용으로 다운로드. onProgress(done,total,label) 콜백. */
    async download(projectId, onProgress) {
      if (!navigator.onLine) throw new Error("온라인 상태에서만 다운로드할 수 있습니다.");
      const H = _authHeaders();
      // [마스터 요건5 근본원인 대응 2026-09-18] IndexedDB 는 브라우저가 저장공간
      // 압박 시 조용히 축출(evict)할 수 있다 — persist()로 축출 대상에서 제외 요청.
      // 실패해도 무시(모든 브라우저가 지원하지 않음 — 다운로드를 막지 않는다).
      try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) {}

      // [마스터 요건5 근본원인 수정] saveDraft() 는 실패(IDB 에러/localStorage 용량초과)해도
      // 조용히 false 를 반환할 뿐 throw 하지 않는다 — 기존 코드는 반환값을 확인하지 않아
      // "다운로드 완료" 토스트가 뜨지만 실제로는 일부 데이터가 저장되지 않는 조용한 실패가
      // 가능했다(재현: 마스터 기기에서 다운로드했는데 새로고침/재방문 후 "저장됨"이 안 보임).
      // → 저장 실패 시 즉시 throw 해 사용자에게 정직하게 "실패"로 보이게 한다.
      const saveOrThrow = async (key, data) => {
        const ok = await SyncQueue.saveDraft(key, data);
        if (!ok) throw new Error("로컬 저장 실패(기기 저장공간 부족) — " + key);
        return ok;
      };

      // 1) 프로젝트 메타
      const proj = await (await fetch("/api/projects", { headers: H })).json();
      const project = (proj.data || []).find((p) => p.id === projectId);
      if (!project) throw new Error("프로젝트를 찾을 수 없습니다.");
      await saveOrThrow("bundle:project:" + projectId, project);

      // 2) 데크 목록
      const decksRes = await (await fetch("/api/projects/" + projectId + "/decks", { headers: H })).json();
      const decks = decksRes.data || [];
      await saveOrThrow("bundle:decks:" + projectId, decks);

      // 3) 데크가 가리키는 배포본 id 수집(중복 제거)
      const depIds = Array.from(new Set(decks.map((d) => d.deployment_id).filter(Boolean)));
      const total = depIds.length;
      let done = 0;
      const panoIds = new Set();

      // 4) 각 배포본 + 그 안의 파노 imageId 수집
      for (const depId of depIds) {
        const dep = await (await fetch("/tables/deployments/" + depId, { headers: H })).json();
        await saveOrThrow("bundle:dep:" + depId, dep);
        let pins = []; try { pins = JSON.parse(dep.pins || "[]"); } catch (e) {}
        pins.forEach((p) => { if (p && p.imageId) panoIds.add(p.imageId); });
        done++; onProgress && onProgress(done, total, "도면 " + (dep.title || depId));
      }

      // 5) 파노 360 이미지 전부 다운로드 → IndexedDB + 메모리 캐시
      const panoArr = Array.from(panoIds);
      for (let i = 0; i < panoArr.length; i++) {
        const imgId = panoArr[i];
        const rec = await (await fetch("/tables/pano_images/" + imgId, { headers: H })).json();
        if (rec && rec.image_data) {
          await saveOrThrow("bundle:pano:" + imgId, rec.image_data);
          if (typeof Cloud !== "undefined") { Cloud._cache = Cloud._cache || {}; Cloud._cache[imgId] = rec.image_data; }
        }
        onProgress && onProgress(total + i + 1, total + panoArr.length, "3D 비워 " + (i + 1) + "/" + panoArr.length);
      }

      // 6) 매니페스트 기록(무결성 검증용) — 위 저장이 전부 성공했을 때만 여기 도달
      const manifest = {
        projectId, downloadedAt: Date.now(),
        decks: decks.length, deployments: depIds.length, panos: panoArr.length,
        depIds, panoIds: panoArr
      };
      await saveOrThrow("bundle:manifest:" + projectId, manifest);
      return manifest;
    },

    /** [마스터 요청 2026-09-18] "다운받은 상태"인지 여부(가벼운 체크 — 매니페스트 존재만).
     *  offline 배지가 "오프라인 모드"(번들 있음) / "작업 불가"(번들 없음)를 가르는 데 쓴다.
     *  verify()보다 훨씬 가볍다(각 dep/pano 개별 조회 없이 매니페스트 존재만 확인). */
    async hasManifest(projectId) {
      if (!projectId) return false;
      try { return !!(await SyncQueue.loadDraft("bundle:manifest:" + projectId)); }
      catch (e) { return false; }
    },

    /* ── 번들 무결성 검증 ── */
    async verify(projectId) {
      const m = await SyncQueue.loadDraft("bundle:manifest:" + projectId);
      if (!m) return { ok: false, reason: "매니페스트 없음 — 다운로드 안 됨" };
      const missing = [];
      for (const depId of (m.depIds || []))
        if (!(await SyncQueue.loadDraft("bundle:dep:" + depId))) missing.push("dep:" + depId);
      for (const imgId of (m.panoIds || []))
        if (!(await SyncQueue.loadDraft("bundle:pano:" + imgId))) missing.push("pano:" + imgId);
      return { ok: missing.length === 0, missing, downloadedAt: m.downloadedAt };
    }
  };

  /* ── 오프라인 부팅 — IndexedDB에서 계층 복원 ─────────────────────── */
  const OfflineLoad = {
    async projects() { // 프로젝트 목록(오프라인)
      const keys = await SyncQueue.allDraftKeys();
      const out = [];
      for (const k of keys) if (String(k).startsWith("bundle:project:")) out.push(await SyncQueue.loadDraft(k));
      return out;
    },
    async decks(projectId) {
      return (await SyncQueue.loadDraft("bundle:decks:" + projectId)) || [];
    },
    async deployment(depId) {
      return await SyncQueue.loadDraft("bundle:dep:" + depId);
    },
    async pano(imageId) {
      if (typeof Cloud !== "undefined" && Cloud._cache && Cloud._cache[imageId]) return Cloud._cache[imageId];
      const d = await SyncQueue.loadDraft("bundle:pano:" + imageId);
      if (d && typeof Cloud !== "undefined") { Cloud._cache = Cloud._cache || {}; Cloud._cache[imageId] = d; }
      return d;
    }
  };

  /* ── 오프라인 3D 비워 소스 결정 ── */
  async function resolvePanoSource(pin) {
    if (!pin) return null;
    if (pin.imageId) {
      const d = await OfflineLoad.pano(pin.imageId);     // 캐시/IndexedDB 우선
      if (d) return d;
    }
    if (navigator.onLine && pin.imageId && typeof Cloud !== "undefined" && Cloud.fetchImage) {
      try { return await Cloud.fetchImage(pin.imageId); } catch (e) {}
    }
    return null; // 표시 불가
  }

  /* ── 오프라인 편집 → op 로그(충돌없는 핵심) ──────────────────────── */
  const OpLog = {
    _key(depId) { return "oplog:" + depId; },
    async _load(depId) { return (await SyncQueue.loadDraft(this._key(depId))) || []; },
    async _save(depId, arr) {
      await SyncQueue.saveDraft(this._key(depId), arr);
      if (SyncQueue._emit) SyncQueue._emit();
    },
    _newId() { return "op-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8); },

    // 🔴 [WO offline2 데이터유실 근본수정 2026-10-02] depId 별 직렬화 체인(동시성 가드).
    //   근본원인(지휘자 재현 p114 "360 사진이 서버에 올라가 핀에 연결됨" FAIL, HEAD 추출본 실측):
    //   record()는 load→push→save 의 읽고-고치고-쓰기(read-modify-write)인데 호출부 다수(특히
    //   _placeCheckboardPin 연속 탭 → _autoSave → persistLocalDeployment → recordPinDelta 처럼 비await/fire-and-forget
    //   으로 연달아 들어오는 경로)가 **같은 depId 키**에
    //   동시에 호출한다. 두 호출이 거의 같은 순간 _load()로 같은 옛 배열을 읽으면, 각자 자기
    //   항목만 push한 뒤 나중에 저장(_save)한 쪽이 앞선 쪽의 기록을 통째로 덮어써 핀 생성 op가
    //   통째로 사라진다(실측: 오프라인 24개 생성 중 대부분의 op가 유실되어 재연결 후 서버에 거의
    //   반영 안 됨). 이 체인으로 같은 depId 의 record/clearApplied 를 **항상 순서대로**(한 번에
    //   하나씩) 실행해 lost-update 를 없앤다 — 데이터 모양·API 변경 없음, 동시 호출만 직렬화.
    _chains: {},
    _enqueue(depId, fn) {
      const prev = this._chains[depId] || Promise.resolve();
      const run = prev.then(fn, fn);
      this._chains[depId] = run.catch(() => {});
      return run;
    },

    /** op 1건의 모양 — record / recordPinDelta 공유(SoT). */
    _mkOp(entity, action, id, data, depId) {
      const op = {
        opId: this._newId(),
        entity, action, id,
        data: action === "delete" ? null : data,
        ts: Date.now(),
        author: (typeof Auth !== "undefined" && Auth.user && Auth.user.email) || "offline"
      };
      // 🔴 [WO 20261010-offmatrix S-REV] 이 편집이 기준으로 삼은 배포본 버전 — 서버 /ops 가 그 이후 적용된 도면 개정으로
      //   좌표를 이월한다(개정 전 좌표가 복귀 업로드로 다시 올라가던 결함). 모르면 싣지 않는다(서버는 종전대로).
      if (depId && typeof State !== "undefined" && String(State.autoSaveDepId) === String(depId) && State.depVersion != null) op.base = Number(State.depVersion);
      return op;
    },

    /** entity:'pin'|'zone'|'anno', action:'upsert'|'delete' */
    async record(depId, entity, action, id, data) {
      if (!depId || !entity || id == null) return;
      return this._enqueue(depId, async () => {
        const arr = await this._load(depId);
        arr.push(this._mkOp(entity, action, id, data, depId));
        await this._save(depId, arr);
      });
    },

    /** 🔴 [WO 20261006-oplog] 오프라인 핀 생성·수정 기록의 **단일 지점**(persistLocalDeployment 가 호출).
     *  근본원인(실 Chrome p114 EXPLORE 재현, .tmp/xoplog.mjs): 핀 기록이 진입점마다 손으로 박혀 있어
     *  CHECKER 배치(_placeCheckboardPin)·사진 연결(PhotoBatch._uploadOneRow → ThetaIntake 재사용)·핀 이동·
     *  시야각 등은 oplog 를 0건 남겼다. 그 핀들의 유일한 운반체는 도면 draft PATCH 인데, 약전파로 그 PATCH 가
     *  실패하고 작은 /ops POST 만 성공하면 서버엔 그 핀이 없다(실측: 오프라인 4핀 → 서버 0, 최종 6 중 2).
     *  → 모든 편집이 지나는 로컬 스냅샷 갱신(persistLocalDeployment, _autoSave·PhotoBatch._markUnsaved 공유)에서
     *  "이전 스냅샷 대비 새로 생기거나 바뀐 핀"을 upsert 로 기록한다. 삭제는 기록하지 않는다(명시 삭제 경로
     *  App._removePins 가 tombstone 과 함께 기록 — 스냅샷 차이로 서버 핀을 지우는 코드는 넣지 않는다).
     *  기존 진입점의 개별 기록과 같은 내용이면 건너뛴다(같은 체인 안에서 마지막 op 와 비교 — 중복 0). */
    async recordPinDelta(depId, prevPins, nextPins) {
      return this.recordDelta("pin", depId, prevPins, nextPins, null);
    },
    /** 🔴 [WO 20261006-annodel] 스냅샷 차이 기록의 공용 본체 — 핀(recordPinDelta)·주석(persistLocalDeployment) 공유.
     *  upsert = 이전 스냅샷 대비 새로 생기거나 바뀐 항목. delete = 이전 스냅샷엔 있고 지금 없으며 **명시 tombstone**
     *  (delIds — 사용자가 실제로 지운 id, App._annoTombstones)에 든 항목만. 스냅샷 차이만으로는 지우지 않는다
     *  (추정 삭제 금지 — 서버 삭제는 이 delete op → 서버 /ops tombstone 경로로만). 같은 내용 연속 op 는 건너뛴다. */
    async recordDelta(entity, depId, prevArr, nextArr, delIds) {
      if (!depId || !Array.isArray(prevArr) || !Array.isArray(nextArr)) return 0;
      const prevJ = new Map();
      prevArr.forEach((p) => { if (p && p.id != null) prevJ.set(String(p.id), JSON.stringify(p)); });
      const changed = [];
      const nextIds = new Set();
      nextArr.forEach((p) => {
        if (!p || p.id == null || p._deleted) return;
        nextIds.add(String(p.id));
        const j = JSON.stringify(p);
        if (prevJ.get(String(p.id)) !== j) changed.push({ id: p.id, j });
      });
      const del = new Set((delIds || []).map(String));
      const gone = [];
      // 스냅샷에 이미 서버 tombstone({_deleted}, /ops 응답 반영분)으로 있는 항목은 다시 지우지 않는다(중복 delete op 0).
      prevArr.forEach((p) => { if (p && p.id != null && !p._deleted && !nextIds.has(String(p.id)) && del.has(String(p.id))) gone.push(p.id); });
      if (!changed.length && !gone.length) return 0;
      return this._enqueue(depId, async () => {
        const arr = await this._load(depId);
        const last = new Map();
        arr.forEach((o) => { if (o && o.entity === entity) last.set(String(o.id), o.action === "delete" ? null : JSON.stringify(o.data)); });
        let n = 0;
        changed.forEach((c) => {
          if (last.get(String(c.id)) === c.j) return;
          arr.push(this._mkOp(entity, "upsert", c.id, JSON.parse(c.j), depId));
          n++;
        });
        gone.forEach((id) => {
          if (last.has(String(id)) && last.get(String(id)) === null) return;   // 이미 delete 기록됨
          arr.push(this._mkOp(entity, "delete", id, null, depId));
          n++;
        });
        if (n) await this._save(depId, arr);
        return n;
      });
    },
    // 현재 열린 배포본 기준 간편 기록
    async recordCurrent(entity, action, id, data) {
      const depId = _curDepId();
      if (depId) await this.record(depId, entity, action, id, data);
    },
    async pending(depId) { return await this._load(depId); },
    async clearApplied(depId, appliedOpIds) {
      const set = new Set(appliedOpIds || []);
      return this._enqueue(depId, async () => {
        const arr = (await this._load(depId)).filter((o) => !set.has(o.opId));
        await this._save(depId, arr);
      });
    }
  };

  // 🔴 [WO offline2 데이터유실 근본수정] persistLocalDeployment 도 OpLog.record 와 같은 read-
  //   modify-write — depId 별 체인(위 OpLog._enqueue 와 별도 맵, 같은 패턴)으로 직렬화해 빠른
  //   연속 호출(_autoSave 가 핀마다 호출)이 서로를 덮어쓰지 않게 한다.
  const _persistChains = {};
  function _persistEnqueue(depId, fn) {
    const prev = _persistChains[depId] || Promise.resolve();
    const run = prev.then(fn, fn);
    _persistChains[depId] = run.catch(() => {});
    return run;
  }
  /** 편집 후 로컬 스냅샷(draft)도 갱신 — 새로고침 대비 */
  async function persistLocalDeployment(depId) {
    if (!depId) depId = _curDepId();
    if (!depId) return;
    return _persistEnqueue(depId, async () => {
      const dep = (await SyncQueue.loadDraft("bundle:dep:" + depId)) || { id: depId };
      // 커밋 직전 최신 State 반영(큐 대기 중 더 많은 핀이 쌓였을 수 있음 — OpLog._enqueue 와 동일 이유)
      // 🔴 [WO 20261006-oplog] 기록과 스냅샷은 **같은 시점의 사본**이어야 한다 — 기록을 기다리는 동안 들어온 핀까지
      //   스냅샷에 넣으면 다음 차례의 비교 기준에 이미 들어 있어 그 핀은 영영 기록되지 않는다(그 핀의 _autoSave 가
      //   뒤에 줄 선 persist 로 기록한다).
      const nextJ = JSON.stringify(State.pins || []);
      // 🔴 [WO 20261006-oplog] 오프라인이면 이전 스냅샷 대비 생성·수정된 핀을 oplog 에 기록(단일 지점 — OpLog.recordPinDelta).
      //   이전 스냅샷이 없으면(기준 모름) 기록하지 않는다 — 서버 핀 전체를 옛 값으로 덮어쓰는 op 를 만들지 않기 위해서다.
      if (typeof navigator !== "undefined" && !navigator.onLine && typeof dep.pins === "string") {
        let prev = null;
        try { prev = JSON.parse(dep.pins); } catch (e) { prev = null; }
        if (Array.isArray(prev)) { try { await OpLog.recordPinDelta(depId, prev, JSON.parse(nextJ)); } catch (e) {} }
      }
      // 🔴 [WO 20261006-annodel] 주석도 같은 지점·같은 규칙 — 생성·수정 upsert + **명시 tombstone 된** 삭제만 delete.
      //   종전엔 PdfAnno._persist 가 남은 주석만 upsert 로 기록해 오프라인 삭제가 0건이었다 → draft PATCH 실패 시
      //   서버의 같은 주석이 복귀 병합으로 되살아났다(실 Chrome 실측).
      const annoJ = JSON.stringify(State.annotations || []);
      if (typeof navigator !== "undefined" && !navigator.onLine && typeof dep.annotations === "string") {
        let prevA = null;
        try { prevA = JSON.parse(dep.annotations); } catch (e) { prevA = null; }
        const tombA = (typeof App !== "undefined" && App._annoTombstones) ? Object.keys(App._annoTombstones()) : [];
        if (Array.isArray(prevA)) { try { await OpLog.recordDelta("anno", depId, prevA, JSON.parse(annoJ), tombA); } catch (e) {} }
      }
      dep.pins = nextJ;
      dep.zones = JSON.stringify(State.zones || []);
      dep.annotations = annoJ;
      await SyncQueue.saveDraft("bundle:dep:" + depId, dep);
    });
  }

  /* ── 온라인 복귀 자동 싱크 (op 로그 replay) ─────────────────────── */
  // 지수 백오프 POST (항구 약전파 대비)
  async function _postWithRetry(url, body, max) {
    max = max || 3;
    for (let i = 0; i < max; i++) {
      try {
        const r = await fetch(url, { method: "POST", headers: _authHeaders(), body: JSON.stringify(body) });
        if (r.ok) return r;
        if (r.status < 500) return r; // 4xx는 재시도 무의미
      } catch (e) {}
      await new Promise((s) => setTimeout(s, Math.pow(2, i) * 1000)); // 1s,2s,4s
    }
    return null;
  }

  // [WO 20260930-403] 권한없음/대상삭제로 거부된 depId — 세션 내 재시도 중단(op 로그는 보존, 무한재시도 금지)
  const _deniedOpDeps = new Set();

  // App 에 op 플러시 메서드 부착 (_onReconnect 에서 호출)
  if (typeof App !== "undefined") {
    App._flushOpLogs = async function () {
      if (!navigator.onLine) return;
      const keys = await SyncQueue.allDraftKeys();
      const opKeys = keys.filter((k) => String(k).startsWith("oplog:"));
      for (const k of opKeys) {
        const depId = String(k).slice("oplog:".length);
        if (_deniedOpDeps.has(depId)) continue; // 이미 거부 확인됨(이 세션) — 재시도 안 함
        const ops = await OpLog.pending(depId);
        if (!ops.length) continue;
        try {
          const res = await _postWithRetry(
            "/tables/deployments/" + encodeURIComponent(depId) + "/ops",
            { base_version: null, ops }
          );
          if (res && res.ok) {
            const j = await res.json();
            await OpLog.clearApplied(depId, j.applied || ops.map((o) => o.opId));
            // [오프라인 노트] 임시id → 서버 실제id 치환(화면의 노트 참조 유지, 핀 pendingOpId 와 같은 목적)
            if (j.noteIdMap && typeof Notes !== "undefined" && Notes.applyIdMap) {
              try { Notes.applyIdMap(j.noteIdMap); } catch (e) {}
            }
            // 서버 최신본을 로컬 번들에 반영(타 작업자 변경 흡수)
            if (j.current) await SyncQueue.saveDraft("bundle:dep:" + depId, j.current);
            // 현재 열려있는 도면이면 화면 갱신(tombstone 제외)
            // 🔴 [WO 20261006-oplog] 핀·영역은 서버본으로 **덮어쓰지 않고** 병합 SoT(_mergeConflict →
            //   _mergePins LWW + tombstone + pinBaseIds)로 합친다. 종전 덮어쓰기는 oplog 에 없는 내 미동기화 핀
            //   (도면 draft PATCH 가 약전파로 실패한 경우)을 화면에서 지웠고, 다음 _autoSave 가 그 화면으로 draft 를
            //   다시 써 영구 유실됐다(실 Chrome 실측: 오프라인 4핀 → 최종 서버 0). 라이브폴·409 와 같은 규칙.
            if (_curDepId() === depId && j.current) {
              try {
                App._mergeConflict(j.current);         // pins/zones 병합 + 기준(pinBaseIds)·버전 갱신 + 렌더
                // 🔴 [WO 20261006-oplog2 → annodel] 주석 병합(App._mergeAnnos)은 이제 _mergeConflict 안에서 한다
                //   (라이브폴·409·여기 공유) — 덮어쓰기 없음.
              } catch (e) {}
            }
          } else if (res) {
            // [WO 20260930-403] 401(만료)/403·409(권한없음·대상삭제) 를 공유 지점에서 판정.
            //   기존엔 이 분기가 아예 없어 권한거부/삭제된 배포본의 op 로그가 재연결마다
            //   조용히 무한 재시도됐다(만료 안내도 없었다).
            const kind = (typeof Auth !== "undefined" && Auth.classifyWriteFailure) ? await Auth.classifyWriteFailure(res) : null;
            if (kind === "expired") {
              if (typeof Auth !== "undefined" && Auth.authExpired) Auth.authExpired();
            } else if (kind === "denied" || kind === "conflict") {
              _deniedOpDeps.add(depId);            // op 로그는 그대로 보존, 이 세션에서만 재시도 중단
              if (typeof Auth !== "undefined" && Auth.writeDenied) Auth.writeDenied(kind);
            }
          }
        } catch (e) { /* 재단절 → 다음 online 때 op 유지하여 재시도 */ }
      }
    };
  }

  /** 🔴 [WO 20261010-offmatrix] 서버 반영 대기 건수의 **단일 판정**(SoT) — 배지(updateNetBadge)와 복귀 진행 표시
   *  (SyncQueue._onReconnect "N건 업로드 중 → 완료")가 같은 수를 쓴다. 종전 배지는 "지금 열린 도면"의 oplog 만 셌고
   *  복귀 토스트는 사진 큐 업로드 수만 셌다(실 Chrome 실측: 대기 25건인데 "1건 동기화 완료"). 모든 도면의 oplog +
   *  사진·첨부 큐 + 서버 미반영 dirty draft(App._countDirtyDrafts — _flushDirtyDrafts 와 같은 판정). */
  async function pendingTotal() {
    let n = 0;
    try {
      const keys = await SyncQueue.allDraftKeys();
      for (const k of keys) if (String(k).startsWith("oplog:")) n += ((await SyncQueue.loadDraft(k)) || []).length;
    } catch (e) {}
    try { n += await SyncQueue.count(); } catch (e) {}
    try { if (typeof App !== "undefined" && App._countDirtyDrafts) n += await App._countDirtyDrafts(); } catch (e) {}
    return n;
  }

  /* ── 오프라인 상태 UI (배지 + 대기 카운트) ──────────────────────── */
  async function updateNetBadge() {
    const badge = document.getElementById("net-badge");
    if (!badge) return;
    const text = document.getElementById("net-text");
    const q = document.getElementById("net-q");
    // [WO 20261001-mobilefast R3] dirty draft 포함 · [WO 20261010-offmatrix] 모든 도면 oplog — 단일 판정(pendingTotal)
    const pending = await pendingTotal();
    // [WO offline2-R4] 🔴 beforeunload(동기 이벤트)는 이 async 합계를 직접 await 할 수 없다 —
    //   여기서 3초 주기로 캐시해 두고 beforeunload 는 이 캐시값만 동기로 읽는다(공유 판정, §G-2-5).
    if (typeof App !== "undefined") App._pendingSyncCount = pending;
    // [P16] 토큰 만료로 업로드가 막힌 상태를 "동기화 중"과 구분해 정직하게 표시.
    //   온라인이어도 인증이 만료됐으면 실제로는 못 올라가는 중이므로 최우선으로 판정.
    if (typeof Auth !== "undefined" && Auth._expired) {
      badge.classList.add("show", "syncing");
      if (text) text.textContent = "인증 필요"; if (q) q.textContent = pending;
    } else if (!navigator.onLine) {
      badge.classList.add("show"); badge.classList.remove("syncing");
      if (text) text.textContent = "오프라인"; if (q) q.textContent = pending;
    } else if (pending > 0) {
      // 🔴 [WO 20261006-photolink] 조용한 실패 금지 — 마지막 동기화가 실패했으면 "동기화 중"으로
      //   위장하지 않는다(종전엔 영구히 "동기화 중 N" 이라, 사진이 안 올라간 사실을 알 길이 없었다).
      //   판정은 SyncQueue.noteSyncResult 가 세운 단일 값(_lastSyncError)만 읽는다(§G-2-5 — 여기서
      //   따로 재계산하지 않는다). 색은 기존 오프라인 상태와 같은 빨강(syncing 클래스 제거) 재사용.
      const syncErr = (typeof SyncQueue !== "undefined") ? SyncQueue._lastSyncError : null;
      // [WO 20261010-offmatrix] 복귀 업로드가 실제로 도는 중이면 "업로드 중"(남은 건수) — 대기만 있는 상태("동기화 중")와 구분
      const uploading = !syncErr && typeof SyncQueue !== "undefined" && !!SyncQueue._reconnecting;
      badge.classList.add("show");
      badge.classList.toggle("syncing", !syncErr);
      if (text) text.textContent = syncErr ? "동기화 실패" : (uploading ? "업로드 중" : "동기화 중");
      if (q) q.textContent = pending;
      badge.setAttribute("title", syncErr ? ("동기화 실패 — " + syncErr) : (uploading ? ("서버에 올리는 중 — 남은 " + pending + "건") : ("서버 반영 대기 " + pending + "건")));
    } else {
      badge.classList.remove("show", "syncing");
      badge.removeAttribute("title");
    }
  }

  /* ── [WO 20260929 photo-time-match] 오프라인 중 촬영한 360 사진 연결 안내 ──────────────
     마스터: "THETA X야 … 제어할 필요 없이 그 와이파이에 연결되었을 때는 감지해서 같이 작동 연동해".
     브라우저는 SSID 를 읽을 수 없다 — THETA 의 AP 에 붙는 순간은 곧 인터넷 단절이므로, 기존
     online/offline 이벤트(§ updateNetBadge 가 이미 구독)를 그대로 "감지" 신호로 재사용한다.
     그 오프라인 세션 중 핀이 1개 이상 생겼으면(PinSeries.createdAt SoT), 온라인 복귀 시
     "연결하기" 배너로 PhotoBatch.openTimeMatch() 를 안내한다. 새 폴링/권한 요청 없음. */
  let _offlineSessionStartAt = null;

  function _onGoOffline() {
    _offlineSessionStartAt = Date.now();
  }
  function _showReconnectBanner(pinCount) {
    try {
      const old = document.getElementById("wm-theta-reconnect");
      if (old) old.remove();
      const host = document.createElement("div");
      host.id = "wm-theta-reconnect";
      host.setAttribute("style",
        "position:fixed;left:50%;bottom:86px;transform:translateX(-50%);z-index:9999;" +
        "background:#1d4ed8;color:#fff;padding:10px 14px;border-radius:10px;" +
        "box-shadow:0 6px 18px rgba(0,0,0,.35);display:flex;gap:10px;align-items:center;" +
        "font-size:14px;max-width:92vw;");
      const msg = document.createElement("span");
      msg.textContent = "오프라인 중 핀 " + pinCount + "개 생성됨 — 촬영한 360 사진 연결하기";
      const btn = document.createElement("button");
      btn.type = "button"; btn.textContent = "연결하기";
      btn.setAttribute("style", "background:#fff;color:#1d4ed8;border:0;border-radius:6px;padding:6px 10px;font-weight:700;cursor:pointer;");
      btn.addEventListener("click", () => {
        host.remove();
        try { if (typeof PhotoBatch !== "undefined" && PhotoBatch.openTimeMatch) PhotoBatch.openTimeMatch(); } catch (e) {}
      });
      const close = document.createElement("button");
      close.type = "button"; close.textContent = "×";
      close.setAttribute("style", "background:transparent;color:#fff;border:0;font-size:16px;cursor:pointer;");
      close.addEventListener("click", () => host.remove());
      host.appendChild(msg); host.appendChild(btn); host.appendChild(close);
      document.body.appendChild(host);
      setTimeout(() => { if (host && host.parentNode) host.remove(); }, 20000);
    } catch (e) {}
  }
  function _onGoOnline() {
    updateNetBadge();
    try {
      if (_offlineSessionStartAt == null) return;
      const since = _offlineSessionStartAt;
      _offlineSessionStartAt = null;
      const pins = (typeof State !== "undefined" && Array.isArray(State.pins)) ? State.pins : [];
      // [WO 20260930-moderole] 🔴 마스터: "체커는 사진을 등록하지 않을 거야" — 이 배너는 360 사진
      // 연결을 안내하므로 대상도 360(content) 계열 핀만 센다(SoT: PinSeries.seriesOf). CHECKER
      // 핀까지 포함해 세면 "N개 생성됨"이라 안내하고도 매칭 대상이 0건인 조용한 불일치가 난다.
      const createdDuring = pins.filter((p) => {
        const t = (typeof PinSeries !== "undefined" && PinSeries.createdAt) ? PinSeries.createdAt(p) : null;
        if (!Number.isFinite(t) || t < since) return false;
        return (typeof PinSeries !== "undefined" && PinSeries.seriesOf) ? PinSeries.seriesOf(p) !== "checkboard" : true;
      });
      if (createdDuring.length) _showReconnectBanner(createdDuring.length);
    } catch (e) {}
  }

  // 네트워크 이벤트 + 주기 갱신 연결 (DOM 준비 후 init 에서 한 번 더 호출)
  const Offline = {
    Bundle: OfflineBundle,
    Load: OfflineLoad,
    OpLog: OpLog,
    resolvePanoSource: resolvePanoSource,
    persistLocalDeployment: persistLocalDeployment,
    updateNetBadge: updateNetBadge,
    pendingTotal: pendingTotal,
    curDepId: _curDepId,
    init() {
      try {
        window.addEventListener("online", _onGoOnline);
        window.addEventListener("offline", () => { _onGoOffline(); updateNetBadge(); });
        if (typeof SyncQueue !== "undefined" && SyncQueue.onChange) SyncQueue.onChange(() => updateNetBadge());
        setInterval(updateNetBadge, 3000);
        updateNetBadge();
      } catch (e) {}
    }
  };
