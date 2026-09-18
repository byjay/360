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

    /** entity:'pin'|'zone'|'anno', action:'upsert'|'delete' */
    async record(depId, entity, action, id, data) {
      if (!depId || !entity || id == null) return;
      const arr = await this._load(depId);
      arr.push({
        opId: this._newId(),
        entity, action, id,
        data: action === "delete" ? null : data,
        ts: Date.now(),
        author: (typeof Auth !== "undefined" && Auth.user && Auth.user.email) || "offline"
      });
      await this._save(depId, arr);
    },
    // 현재 열린 배포본 기준 간편 기록
    async recordCurrent(entity, action, id, data) {
      const depId = _curDepId();
      if (depId) await this.record(depId, entity, action, id, data);
    },
    async pending(depId) { return await this._load(depId); },
    async clearApplied(depId, appliedOpIds) {
      const set = new Set(appliedOpIds || []);
      const arr = (await this._load(depId)).filter((o) => !set.has(o.opId));
      await this._save(depId, arr);
    }
  };

  /** 편집 후 로컬 스냅샷(draft)도 갱신 — 새로고침 대비 */
  async function persistLocalDeployment(depId) {
    if (!depId) depId = _curDepId();
    if (!depId) return;
    const dep = (await SyncQueue.loadDraft("bundle:dep:" + depId)) || { id: depId };
    dep.pins = JSON.stringify(State.pins || []);
    dep.zones = JSON.stringify(State.zones || []);
    dep.annotations = JSON.stringify(State.annotations || []);
    await SyncQueue.saveDraft("bundle:dep:" + depId, dep);
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

  // App 에 op 플러시 메서드 부착 (_onReconnect 에서 호출)
  if (typeof App !== "undefined") {
    App._flushOpLogs = async function () {
      if (!navigator.onLine) return;
      const keys = await SyncQueue.allDraftKeys();
      const opKeys = keys.filter((k) => String(k).startsWith("oplog:"));
      for (const k of opKeys) {
        const depId = String(k).slice("oplog:".length);
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
            if (_curDepId() === depId && j.current) {
              try {
                const live = (arr) => (Array.isArray(arr) ? arr.filter((o) => !(o && o._deleted)) : arr);
                State.pins = live(JSON.parse(j.current.pins || "[]"));
                State.zones = live(JSON.parse(j.current.zones || "[]"));
                State.annotations = live(JSON.parse(j.current.annotations || "[]"));
                State.depVersion = Number(j.current.version) || 0;
                if (typeof UI !== "undefined") { UI.renderPinList(); UI.renderPinsOnMap(); }
                if (typeof Zones !== "undefined" && Zones.render) { Zones.render(); Zones.renderList && Zones.renderList(); }
              } catch (e) {}
            }
          }
        } catch (e) { /* 재단절 → 다음 online 때 op 유지하여 재시도 */ }
      }
    };
  }

  /* ── 오프라인 상태 UI (배지 + 대기 카운트) ──────────────────────── */
  async function updateNetBadge() {
    const badge = document.getElementById("net-badge");
    if (!badge) return;
    const text = document.getElementById("net-text");
    const q = document.getElementById("net-q");
    let pending = 0;
    const depId = _curDepId();
    if (depId) { try { pending = (await OpLog.pending(depId)).length; } catch (e) {} }
    try { pending += await SyncQueue.count(); } catch (e) {}
    // [P16] 토큰 만료로 업로드가 막힌 상태를 "동기화 중"과 구분해 정직하게 표시.
    //   온라인이어도 인증이 만료됐으면 실제로는 못 올라가는 중이므로 최우선으로 판정.
    if (typeof Auth !== "undefined" && Auth._expired) {
      badge.classList.add("show", "syncing");
      if (text) text.textContent = "인증 필요"; if (q) q.textContent = pending;
    } else if (!navigator.onLine) {
      badge.classList.add("show"); badge.classList.remove("syncing");
      if (text) text.textContent = "오프라인"; if (q) q.textContent = pending;
    } else if (pending > 0) {
      badge.classList.add("show", "syncing");
      if (text) text.textContent = "동기화 중"; if (q) q.textContent = pending;
    } else {
      badge.classList.remove("show", "syncing");
    }
  }

  // 네트워크 이벤트 + 주기 갱신 연결 (DOM 준비 후 init 에서 한 번 더 호출)
  const Offline = {
    Bundle: OfflineBundle,
    Load: OfflineLoad,
    OpLog: OpLog,
    resolvePanoSource: resolvePanoSource,
    persistLocalDeployment: persistLocalDeployment,
    updateNetBadge: updateNetBadge,
    curDepId: _curDepId,
    init() {
      try {
        window.addEventListener("online", updateNetBadge);
        window.addEventListener("offline", updateNetBadge);
        if (typeof SyncQueue !== "undefined" && SyncQueue.onChange) SyncQueue.onChange(() => updateNetBadge());
        setInterval(updateNetBadge, 3000);
        updateNetBadge();
      } catch (e) {}
    }
  };
