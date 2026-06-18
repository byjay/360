  const SyncQueue = {
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

    async _open() {
      if (this._db) return this._db;
      if (!("indexedDB" in window)) return null; // localStorage 폴백 사용
      this._db = await new Promise((res, rej) => {
        const req = indexedDB.open(this.DB_NAME, 2);   // ★ v2: drafts 스토어 추가
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(this.STORE)) {
            db.createObjectStore(this.STORE, { keyPath: "opId" });
          }
          if (!db.objectStoreNames.contains(this.DRAFT_STORE)) {
            db.createObjectStore(this.DRAFT_STORE, { keyPath: "key" }); // 도면 임시저장(오프라인/서버실패 폴백)
          }
        };
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error || new Error("indexedDB open failed"));
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

    /* ── localStorage 폴백 ── */
    _lsKey() { return "wm_sync_ops"; },
    _lsAll() { try { return JSON.parse(localStorage.getItem(this._lsKey()) || "[]"); } catch (e) { return []; } },
    _lsSet(arr) { try { localStorage.setItem(this._lsKey(), JSON.stringify(arr)); } catch (e) {} },

    /** op 추가 — {opId, kind:'image'|'doc', name, image_data, width?, height?, meta?} */
    async enqueue(op) {
      op.opId = op.opId || ("op" + Date.now() + Math.random().toString(36).slice(2, 8));
      op.createdAt = Date.now();
      op.status = "pending";
      const db = await this._open();
      if (db) {
        await new Promise((res, rej) => {
          const tx = db.transaction(this.STORE, "readwrite");
          tx.objectStore(this.STORE).put(op);
          tx.oncomplete = res; tx.onerror = () => rej(tx.error);
        });
      } else {
        const all = this._lsAll(); all.push(op); this._lsSet(all);
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
          if (!res.ok) { failed += batch.length; break; }
          const data = await res.json();
          for (const r of (data.results || [])) {
            if (r.ok && r.id) { map[r.opId] = r.id; uploaded++; await this._remove(r.opId); }
            else { failed++; }
          }
        }
      } finally {
        this._syncing = false; this._emit();
      }
      return { ok: failed === 0, uploaded, failed, map };
    },

    /** online 복구 시 자동 일괄 동기화 시작 */
    init() {
      window.addEventListener("online", () => { this.flush().then(r => {
        if (r && r.uploaded > 0 && typeof App !== "undefined") App._onSyncDone(r);
      }); });
      window.addEventListener("offline", () => this._emit());
      // 초기 1회 + 주기적 재시도(앱이 열려 있는 동안 백그라운드 동기화)
      this._emit();
      if (navigator.onLine) this.flush();
      setInterval(() => { if (navigator.onLine) this.flush(); }, 30000);
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