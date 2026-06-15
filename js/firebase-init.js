/* ════════════════════════════════════════════════════════════
   SEASTAR · Firebase 초기화 모듈 (Auth + Firestore + Storage)
   ─────────────────────────────────────────────────────────────
   · FIREBASE_ENABLED === true 일 때만 실제 초기화
   · window.SeaFirebase 로 전역 API 노출:
        SeaFirebase.ready          : boolean
        SeaFirebase.loginGoogle()  : Google 팝업 로그인 → user
        SeaFirebase.logout()
        SeaFirebase.currentUser()
        SeaFirebase.onAuth(cb)
        SeaFirebase.saveDoc(col, id, data)   : Firestore 저장
        SeaFirebase.getDoc(col, id)
        SeaFirebase.listDocs(col)
        SeaFirebase.deleteDoc(col, id)
        SeaFirebase.uploadFile(path, blob)   : Storage 업로드 → URL
   · Firebase 미설정 시 모든 메서드는 안전하게 no-op/에러 메시지 반환
════════════════════════════════════════════════════════════ */
(function () {
  const SF = {
    ready: false,
    _app: null, _auth: null, _db: null, _storage: null, _user: null,
    _authCbs: [],
  };
  window.SeaFirebase = SF;

  if (!window.FIREBASE_ENABLED) {
    console.info("[SeaFirebase] Firebase 미설정 — Cloudflare D1 백엔드만 사용합니다. (public/js/firebase-config.js 채우면 활성화)");
    SF.loginGoogle = async () => { throw new Error("Firebase 미설정: firebase-config.js 를 채워주세요."); };
    SF.logout = async () => {};
    SF.currentUser = () => null;
    SF.onAuth = (cb) => { try { cb(null); } catch (e) {} };
    SF.saveDoc = SF.getDoc = SF.listDocs = SF.deleteDoc = SF.uploadFile =
      async () => { throw new Error("Firebase 미설정"); };
    return;
  }

  // 동적 import (v10 모듈 CDN)
  (async () => {
    try {
      const appMod = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js");
      const authMod = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js");
      const fsMod = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
      let stMod = null;
      try { stMod = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js"); } catch (e) {}

      SF._app = appMod.initializeApp(window.FIREBASE_CONFIG);
      SF._auth = authMod.getAuth(SF._app);
      SF._db = fsMod.getFirestore(SF._app);
      if (stMod) SF._storage = stMod.getStorage(SF._app);

      const provider = new authMod.GoogleAuthProvider();

      authMod.onAuthStateChanged(SF._auth, (u) => {
        SF._user = u;
        SF._authCbs.forEach((cb) => { try { cb(u); } catch (e) {} });
      });

      SF.loginGoogle = async () => {
        const res = await authMod.signInWithPopup(SF._auth, provider);
        return res.user;
      };
      SF.logout = async () => authMod.signOut(SF._auth);
      SF.currentUser = () => SF._user;
      SF.onAuth = (cb) => { SF._authCbs.push(cb); if (SF._user !== undefined) cb(SF._user); };

      SF.saveDoc = async (col, id, data) => {
        const ref = fsMod.doc(SF._db, col, String(id));
        await fsMod.setDoc(ref, { ...data, _updatedAt: Date.now(), _owner: SF._user?.email || null }, { merge: true });
        return id;
      };
      SF.getDoc = async (col, id) => {
        const snap = await fsMod.getDoc(fsMod.doc(SF._db, col, String(id)));
        return snap.exists() ? { id: snap.id, ...snap.data() } : null;
      };
      SF.listDocs = async (col) => {
        const snap = await fsMod.getDocs(fsMod.collection(SF._db, col));
        return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      };
      SF.deleteDoc = async (col, id) => fsMod.deleteDoc(fsMod.doc(SF._db, col, String(id)));

      SF.uploadFile = async (path, blob) => {
        if (!SF._storage || !stMod) throw new Error("Storage 미설정");
        const r = stMod.ref(SF._storage, path);
        await stMod.uploadBytes(r, blob);
        return stMod.getDownloadURL(r);
      };

      SF.ready = true;
      console.info("[SeaFirebase] ✅ 초기화 완료 — 본인 Google 계정으로 저장 가능:", window.FIREBASE_CONFIG.projectId);
      document.dispatchEvent(new CustomEvent("seafirebase:ready"));
    } catch (err) {
      console.error("[SeaFirebase] 초기화 실패:", err);
      SF.loginGoogle = async () => { throw err; };
    }
  })();
})();
