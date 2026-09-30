  const SyncQueue = {
    // 🔴 SoT — IndexedDB 이름은 이 리터럴 하나뿐이다(코드 전체 grep 결과: 다른 이름 0건).
    // [마스터 실측 2026-09-18] 프로덕션 브라우저에서 "wm-sync"(하이픈, 빈 DB)와
    // "wm_sync"(언더바, drafts 4건) 두 DB가 동시에 존재하는 것이 관찰됐다 — 그러나
    // 소스 전체(현재+git 이력)를 grep 해도 "wm-sync"(하이픈)를 생성하는 코드는
    // 이 리포에 존재하지 않는다(sw.js도 indexedDB 미사용, PWA/workbox 플러그인 없음).
    // 즉 하이픈 DB는 이 코드가 만든 게 아닌 잔여물로 추정 — 그래도 방어적으로
    // _migrateLegacyDb() 에서 감지 시 데이터가 있으면 옮기고 없으면 정리한다.
    LEGACY_DB_NAME: "wm-sync",
    DB_NAME: "wm_sync",
    STORE: "ops",
    _db: null,
    _syncing: false,
    _listeners: [],

    /** 상태 변경 구독 (배지 갱신용) */
    onChange(fn) { this._listeners.push(fn); },
    _emit() {
      this.count().then(n => {
        this._listeners.forEach(fn => { try { fn(n, navigator.onLine); } catch (e) {} });
      });
    },

    DRAFT_STORE: "drafts",
    AUTH_STORE: "authlocal",   // [P40] 오프라인 재인증 검증자(verifier) — 평문 비밀번호는 절대 담지 않는다

    async _open() {
      if (this._db) return this._db;
      if (!("indexedDB" in window)) return null; // localStorage 폴백 사용
      this._db = await new Promise((res, rej) => {
        const req = indexedDB.open(this.DB_NAME, 4);   // v2: drafts / v3: authlocal / v4: sources(원본 도면 바이트)
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(this.SRC_STORE)) {
            db.createObjectStore(this.SRC_STORE, { keyPath: "key" });   // 저장 전 원본 PDF(오프라인·서버실패 보존)
          }
          if (!db.objectStoreNames.contains(this.STORE)) {
            db.createObjectStore(this.STORE, { keyPath: "opId" });
          }
          if (!db.objectStoreNames.contains(this.DRAFT_STORE)) {
            db.createObjectStore(this.DRAFT_STORE, { keyPath: "key" }); // 도면 임시저장(오프라인/서버실패 폴백)
          }
          if (!db.objectStoreNames.contains(this.AUTH_STORE)) {
            db.createObjectStore(this.AUTH_STORE, { keyPath: "key" });  // 오프라인 재인증 검증자
          }
        };
        req.onsuccess = () => {
          const db = req.result;
          // 다른 탭(새 버전)이 업그레이드하려 하면 이 연결을 닫아 막지 않는다 — 다음 호출이 새로 연다.
          db.onversionchange = () => { try { db.close(); } catch (e) {} if (this._db === db) this._db = null; };
          res(db);
        };
        req.onerror = () => rej(req.error || new Error("indexedDB open failed"));
        // v3 를 연 채 떠 있는 구버전 탭이 업그레이드를 막으면 영원히 대기한다 → 이번 호출은 localStorage
        // 폴백으로 진행(null)하고, 막힘이 풀려 열리면 onsuccess 가 이후 호출용으로 캐시하지 않는다(다음 호출이 재시도).
        req.onblocked = () => res(null);
      }).catch(() => null);
      return this._db;
    },

    /* ═══ 도면 DRAFT 영속화 (오프라인/서버실패 시 도면 소실 방지) ═══
       key 별로 도면 스냅샷+핀+구역을 로컬에 보관. 새로고침/오프라인에도 유지.
       IndexedDB 우선, 미지원 시 localStorage 폴백. */
    async saveDraft(key, data) {
      const rec = { key: key, data: data, savedAt: Date.now() };
      const db = await this._open();
      if (db && db.objectStoreNames.contains(this.DRAFT_STORE)) {
        try {
          await new Promise((res, rej) => {
            const tx = db.transaction(this.DRAFT_STORE, "readwrite");
            tx.objectStore(this.DRAFT_STORE).put(rec);
            tx.oncomplete = res; tx.onerror = () => rej(tx.error);
          });
          return true;
        } catch (e) { /* 폴백으로 */ }
      }
      try { localStorage.setItem("wm_draft_" + key, JSON.stringify(rec)); return true; }
      catch (e) { return false; }
    },
    async loadDraft(key) {
      const db = await this._open();
      if (db && db.objectStoreNames.contains(this.DRAFT_STORE)) {
        try {
          const rec = await new Promise((res) => {
            const tx = db.transaction(this.DRAFT_STORE, "readonly");
            const rq = tx.objectStore(this.DRAFT_STORE).get(key);
            rq.onsuccess = () => res(rq.result); rq.onerror = () => res(null);
          });
          if (rec) return rec.data;
        } catch (e) {}
      }
      try { const r = JSON.parse(localStorage.getItem("wm_draft_" + key) || "null"); return r ? r.data : null; }
      catch (e) { return null; }
    },
    async removeDraft(key) {
      const db = await this._open();
      if (db && db.objectStoreNames.contains(this.DRAFT_STORE)) {
        try {
          await new Promise((res) => {
            const tx = db.transaction(this.DRAFT_STORE, "readwrite");
            tx.objectStore(this.DRAFT_STORE).delete(key);
            tx.oncomplete = res; tx.onerror = res;
          });
        } catch (e) {}
      }
      try { localStorage.removeItem("wm_draft_" + key); } catch (e) {}
    },
    async allDraftKeys() {
      const db = await this._open();
      if (db && db.objectStoreNames.contains(this.DRAFT_STORE)) {
        try {
          return await new Promise((res) => {
            const tx = db.transaction(this.DRAFT_STORE, "readonly");
            const rq = tx.objectStore(this.DRAFT_STORE).getAllKeys();
            rq.onsuccess = () => res(rq.result || []); rq.onerror = () => res([]);
          });
        } catch (e) {}
      }
      const keys = [];
      try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith("wm_draft_")) keys.push(k.slice(9)); } } catch (e) {}
      return keys;
    },

    /* ═══ [WO 20260929-lossless] 원본 도면 바이트(PDF) 보관 ═══
       draft 는 화면 스냅샷(이미지)만 담는다 — 새로고침·재진입 뒤 저장하면 원본 PDF 없이 배포본이 만들어져
       확대 시 깨졌다(prod dep_muksj6py: base64 JPEG + source_meta null). 원본은 서버에 올라가기 전까지
       여기(IndexedDB)에 둔다. 🔴 localStorage 폴백 없음 — 수 MB 바이너리는 담을 수 없다(없으면 false 를 정직하게 반환). */
    SRC_STORE: "sources",
    async _srcTx(mode, fn) {
      const db = await this._open();
      if (!db || !db.objectStoreNames.contains(this.SRC_STORE)) return null;
      try {
        return await new Promise((res) => {
          const tx = db.transaction(this.SRC_STORE, mode);
          const out = fn(tx.objectStore(this.SRC_STORE));
          tx.oncomplete = () => res(out && "result" in out ? out.result : true);
          tx.onerror = () => res(null); tx.onabort = () => res(null);
        });
      } catch (e) { return null; }
    },
    async saveSource(key, rec) {
      return !!(await this._srcTx("readwrite", (s) => { s.put(Object.assign({ key: key, savedAt: Date.now() }, rec)); }));
    },
    async loadSource(key) {
      const r = await this._srcTx("readonly", (s) => s.get(key));
      return (r && typeof r === "object") ? r : null;
    },
    /** 어떤 draft 도 가리키지 않는 원본을 지운다(keep = 살려 둘 key 집합). */
    async pruneSources(keep) {
      const keys = (await this._srcTx("readonly", (s) => s.getAllKeys())) || [];
      const dead = (Array.isArray(keys) ? keys : []).filter((k) => !keep.has(k));
      if (dead.length) await this._srcTx("readwrite", (s) => { dead.forEach((k) => s.delete(k)); });
      return dead.length;
    },

    /* ═══ [P40] 오프라인 재인증 검증자 보관 ═══
       저장되는 것은 PBKDF2-SHA256(100k) 해시 + salt 뿐이다(서버 hashPassword 와 동일 파라미터).
       기기를 털려도 원문 비밀번호는 복원되지 않는다. 보관 위치는 기존 IndexedDB 재사용(신규 저장소 없음). */
    AUTH_KEY: "offline-verifier",
    _authLsKey() { return "wm_offline_auth"; },
    async saveAuthRecord(rec) {
      const row = { key: this.AUTH_KEY, rec: rec };
      const db = await this._open();
      if (db && db.objectStoreNames.contains(this.AUTH_STORE)) {
        try {
          await new Promise((res, rej) => {
            const tx = db.transaction(this.AUTH_STORE, "readwrite");
            tx.objectStore(this.AUTH_STORE).put(row);
            tx.oncomplete = res; tx.onerror = () => rej(tx.error);
          });
          return true;
        } catch (e) { /* 폴백으로 */ }
      }
      try { localStorage.setItem(this._authLsKey(), JSON.stringify(row)); return true; } catch (e) { return false; }
    },
    async loadAuthRecord() {
      const db = await this._open();
      if (db && db.objectStoreNames.contains(this.AUTH_STORE)) {
        try {
          const row = await new Promise((res) => {
            const tx = db.transaction(this.AUTH_STORE, "readonly");
            const rq = tx.objectStore(this.AUTH_STORE).get(this.AUTH_KEY);
            rq.onsuccess = () => res(rq.result); rq.onerror = () => res(null);
          });
          if (row) return row.rec;
        } catch (e) {}
      }
      try { const r = JSON.parse(localStorage.getItem(this._authLsKey()) || "null"); return r ? r.rec : null; }
      catch (e) { return null; }
    },
    async clearAuthRecord() {
      const db = await this._open();
      if (db && db.objectStoreNames.contains(this.AUTH_STORE)) {
        try {
          await new Promise((res) => {
            const tx = db.transaction(this.AUTH_STORE, "readwrite");
            tx.objectStore(this.AUTH_STORE).delete(this.AUTH_KEY);
            tx.oncomplete = res; tx.onerror = res;
          });
        } catch (e) {}
      }
      try { localStorage.removeItem(this._authLsKey()); } catch (e) {}
    },

    /* ── localStorage 폴백 ── */
    _lsKey() { return "wm_sync_ops"; },
    _lsAll() { try { return JSON.parse(localStorage.getItem(this._lsKey()) || "[]"); } catch (e) { return []; } },
    _lsSet(arr) { try { localStorage.setItem(this._lsKey(), JSON.stringify(arr)); return true; } catch (e) { return false; } },

    /** op 추가 — {opId, kind:'image'|'doc', name, image_data, width?, height?, meta?} */
    async enqueue(op) {
      op.opId = op.opId || ("op" + Date.now() + Math.random().toString(36).slice(2, 8));
      op.createdAt = Date.now();
      op.status = "pending";
      const db = await this._open();
      // [버그수정 A] IDB 트랜잭션이 동기 throw(InvalidStateError: 모바일 백그라운드/versionchange)하면
      //   op이 큐에도 안 들어가 영구손실 → try/catch + localStorage 폴백으로 항상 저장 보장.
      let stored = false;
      if (db) {
        try {
          await new Promise((res, rej) => {
            const tx = db.transaction(this.STORE, "readwrite");
            tx.objectStore(this.STORE).put(op);
            tx.oncomplete = res; tx.onerror = () => rej(tx.error);
          });
          stored = true;
        } catch (e) { /* IDB 실패 → 아래 localStorage 폴백 */ }
      }
      if (!stored) {
        const all = this._lsAll(); all.push(op); stored = this._lsSet(all);
      }
      if (!stored) {
        // [무신호 손실 차단] IDB·localStorage 모두 실패(저장공간 부족/차단) →
        //   기존엔 opId 를 반환해 배지엔 떴지만 영영 전송 못 하는 '유령 op' 였다.
        //   이제 사용자에게 명시 신호 + null 반환 → 호출부가 pendingOpId 를 세팅하지 않도록.
        try { if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("오프라인 저장 실패 — 기기 저장공간 부족"); } catch (e) {}
        this._emit();
        return null;
      }
      this._emit();
      return op.opId;
    },

    async all() {
      const db = await this._open();
      if (db) {
        return await new Promise((res) => {
          const tx = db.transaction(this.STORE, "readonly");
          const rq = tx.objectStore(this.STORE).getAll();
          rq.onsuccess = () => res(rq.result || []);
          rq.onerror = () => res([]);
        });
      }
      return this._lsAll();
    },

    async count() {
      const all = await this.all();
      return all.filter(o => o.status !== "done").length;
    },

    async _remove(opId) {
      const db = await this._open();
      if (db) {
        await new Promise((res) => {
          const tx = db.transaction(this.STORE, "readwrite");
          tx.objectStore(this.STORE).delete(opId);
          tx.oncomplete = res; tx.onerror = res;
        });
      } else {
        this._lsSet(this._lsAll().filter(o => o.opId !== opId));
      }
    },

    /** 전체 큐를 서버로 일괄 업로드/업데이트. 결과: {ok, uploaded, failed, map:{opId:serverId}} */
    async flush() {
      if (this._syncing) return { ok: false, busy: true };
      if (!navigator.onLine) return { ok: false, offline: true };
      // [P40 보안] 오프라인 검증자로만 인증된 상태(서버가 검증하지 않은 신원)로는 서버 쓰기를 시도하지 않는다.
      //   큐는 그대로 보존 → 온라인 재로그인(서버 재검증) 후 자동 업로드된다.
      if (typeof Auth !== "undefined" && Auth.canServerWrite && !Auth.canServerWrite()) {
        return { ok: false, offlineAuth: true, reason: "오프라인 인증 상태 — 서버 업로드는 온라인 재로그인 후 진행됩니다" };
      }
      const pending = (await this.all()).filter(o => o.status !== "done");
      if (pending.length === 0) { this._emit(); return { ok: true, uploaded: 0, map: {} }; }

      this._syncing = true; this._emit();
      const map = {};
      let uploaded = 0, failed = 0;
      try {
        // 한 번에 너무 큰 페이로드 방지 — 청크로 분할 업로드
        const CHUNK = 4;
        for (let i = 0; i < pending.length; i += CHUNK) {
          const batch = pending.slice(i, i + CHUNK).map(o => ({
            opId: o.opId, kind: o.kind, name: o.name,
            image_data: o.image_data, width: o.width, height: o.height
          }));
          let res;
          try {
            res = await fetch("/api/sync/batch", {
              method: "POST",
              headers: Auth.headers(),
              body: JSON.stringify({ ops: batch })
            });
          } catch (e) { failed += batch.length; break; } // 네트워크 단절 → 다음 online 때 재시도
          if (!res.ok) {
            // [WO 20260930-403] 401(만료)/403·409(권한없음·대상삭제) 를 공유 지점(Auth.classifyWriteFailure)
            //   에서 판정 — /api/sync/batch 는 프로젝트 스코프 검사가 없어 실제로는 항상 'expired'로
            //   분류되지만(§classifyWriteFailure), 세 호출부가 같은 판정을 쓰도록 통일한다(§G-2-5).
            //   큐는 그대로 보존(제거하지 않음) — 재로그인/재허용 후 자동 재시도.
            const kind = (typeof Auth !== "undefined" && Auth.classifyWriteFailure) ? await Auth.classifyWriteFailure(res) : null;
            if (kind === "expired") {
              if (typeof Auth !== "undefined" && Auth.authExpired) Auth.authExpired();
            } else if (kind === "denied" || kind === "conflict") {
              if (typeof Auth !== "undefined" && Auth.writeDenied) Auth.writeDenied(kind);
            }
            failed += batch.length; break;
          }
          const data = await res.json();
          for (const r of (data.results || [])) {
            if (r.ok && r.id) { map[r.opId] = r.id; uploaded++; await this._remove(r.opId); }
            else if (r.permanent === true) {
              // [데이터손실 차단] 결정적 거부(검증실패/용량초과 등)만 dead-letter 제거 →
              //   매 동기화 무한재시도("동기화 중" 영구표시) 방지. 서버가 permanent=true 로 명시할 때만.
              failed++;
              await this._remove(r.opId);
              try { console.warn("[SyncQueue] op 영구거부 → 제거:", r.opId, (r && r.error) || ""); } catch (e) {}
            } else {
              // [데이터손실 차단 — 핵심] 일시적 실패(DB장애/타임아웃 등)는 큐 '보존'.
              //   기존 코드는 일시 오류도 무조건 제거해 360 사진이 영구 소실됐다.
              //   → 다음 수동 동기화 때 재시도. (서버 멱등 source_op_id 로 중복생성도 0)
              failed++;
              try { console.warn("[SyncQueue] op 일시실패 → 큐 보존(재시도):", r.opId, (r && r.error) || ""); } catch (e) {}
            }
          }
        }
      } finally {
        this._syncing = false; this._emit();
      }
      return { ok: failed === 0, uploaded, failed, map };
    },

    /** [마스터: 자동 반영] 인터넷 복구 시 App 의 online 핸들러가 _onReconnect() 를 호출해
     *  오프라인 큐(첨부 사진/PDF)를 자동 업로드한다. 배지 "↑ 지금 올리기 N" 은 자동 flush 실패/
     *  대기 중 수동 재시도용으로 그대로 유지. (온라인 일반 저장은 큐를 거치지 않고 즉시 직접 업로드) */
    init() {
      if (this._inited) return; this._inited = true;
      window.addEventListener("online", () => this._emit());
      window.addEventListener("offline", () => this._emit());
      this._emit();
      // [마스터 요건1 2026-09-18] 옛 이름 잔여 DB 정리(있으면 데이터 이관 후 삭제) — fire-and-forget.
      try { this._migrateLegacyDb(); } catch (e) {}
    },

    /** [마스터 요건1 2026-09-18] LEGACY_DB_NAME("wm-sync", 하이픈) 잔여 DB가 있으면
     *  같은 이름의 스토어에 데이터가 있는 걸 정본 DB_NAME("wm_sync")으로 옮기고
     *  옛 DB는 삭제한다. indexedDB.databases() 미지원 브라우저(Safari 구버전 등)는
     *  조용히 건너뛴다(잔여 DB가 있어도 정본 읽기/쓰기 경로엔 영향 없음 — DB_NAME만 참조). */
    async _migrateLegacyDb() {
      if (!("indexedDB" in window) || typeof indexedDB.databases !== "function") return;
      try {
        const dbs = await indexedDB.databases();
        if (!dbs.some(d => d && d.name === this.LEGACY_DB_NAME)) return; // 잔여 DB 없음 — 정상
        const ldb = await new Promise((res) => {
          const req = indexedDB.open(this.LEGACY_DB_NAME);
          req.onsuccess = () => res(req.result);
          req.onerror = () => res(null);
        });
        if (ldb) {
          const storeNames = Array.from(ldb.objectStoreNames || []);
          for (const sn of storeNames) {
            let rows = [];
            try {
              rows = await new Promise((res) => {
                const tx = ldb.transaction(sn, "readonly");
                const rq = tx.objectStore(sn).getAll();
                rq.onsuccess = () => res(rq.result || []);
                rq.onerror = () => res([]);
              });
            } catch (e) {}
            if (rows.length) {
              const db = await this._open();
              if (db && db.objectStoreNames.contains(sn)) {
                try {
                  await new Promise((res) => {
                    const tx = db.transaction(sn, "readwrite");
                    rows.forEach(r => { try { tx.objectStore(sn).put(r); } catch (e) {} });
                    tx.oncomplete = res; tx.onerror = res;
                  });
                  console.warn("[SyncQueue] 잔여 DB(" + this.LEGACY_DB_NAME + ") " + sn + " " + rows.length + "건 → " + this.DB_NAME + " 이관");
                } catch (e) {}
              }
            }
          }
          try { ldb.close(); } catch (e) {}
        }
        // 이관 완료(또는 애초에 비어있었음) → 잔여 DB 삭제
        await new Promise((res) => {
          const del = indexedDB.deleteDatabase(this.LEGACY_DB_NAME);
          del.onsuccess = res; del.onerror = res; del.onblocked = res;
        });
      } catch (e) { /* 정리 실패해도 정본 DB_NAME 경로는 영향 없음 */ }
    },

    /** 재연동 시퀀스 — 첨부 동기화 + 핀ID 치환 + 도면 draft 서버반영을 순서대로 */
    async _onReconnect() {
      if (this._reconnecting) return; this._reconnecting = true;
      try {
        const r = await this.flush();
        // map 이 있으면(0건이어도) 핀의 pendingOpId → 서버 imageId/docId 치환
        if (r && r.map && typeof App !== "undefined" && App._onSyncDone) App._onSyncDone(r);
        // 오프라인 중 저장된 도면 draft 를 서버에 반영(낙관적 잠금 base_version 포함)
        if (typeof App !== "undefined" && App._flushDirtyDrafts) {
          try { await App._flushDirtyDrafts(); } catch (e) {}
        }
        // [오프라인 작업지시서 ] 오프라인 op 로그 replay(충돌없는 엔티티 병합)
        if (typeof App !== "undefined" && App._flushOpLogs) {
          try { await App._flushOpLogs(); } catch (e) {}
        }
        // 재연동 토스트(대기 항목이 실제로 있었을 때만)
        if (r && (r.uploaded > 0) && typeof Prompt !== "undefined" && Prompt.toast) {
          Prompt.toast("온라인 복구 — 오프라인 변경 " + r.uploaded + "건 동기화 완료");
        }
      } finally { this._reconnecting = false; this._emit(); }
    }
  };

  /* 파일 종류 헬퍼 — 아이콘/라벨용 */
  function docKind(nameOrMime) {
    const s = (nameOrMime || "").toLowerCase();
    if (/\.pdf|pdf/.test(s)) return { type: "pdf", label: "PDF", color: "#f87171" };
    if (/\.docx?|word|officedocument\.wordprocessing|msword/.test(s)) return { type: "word", label: "WORD", color: "#60a5fa" };
    if (/\.xlsx?|sheet|excel/.test(s)) return { type: "excel", label: "XLS", color: "#34d399" };
    if (/\.pptx?|presentation|powerpoint/.test(s)) return { type: "ppt", label: "PPT", color: "#fb923c" };
    if (/\.txt|text\/plain/.test(s)) return { type: "txt", label: "TXT", color: "#cbd5e1" };
    if (/\.(png|jpe?g|gif|webp|bmp)|^image\//.test(s)) return { type: "img", label: "IMG", color: "#a78bfa" };
    return { type: "file", label: "FILE", color: "#94a3b8" };
  }
  function fmtBytes(n) {
    if (!n) return "";
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + " KB";
    return (n / 1024 / 1024).toFixed(1) + " MB";
  }

  /* ══════════════════════════════════════════
     PANO VIEWER  — Three.js WebGL (고속)
  ══════════════════════════════════════════ */