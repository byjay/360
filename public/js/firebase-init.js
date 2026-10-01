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
    _authCbs: [], _idTokenCbs: [],
  };
  window.SeaFirebase = SF;

  if (!window.FIREBASE_ENABLED) {
    console.info("[SeaFirebase] Firebase 미설정 — Cloudflare D1 백엔드만 사용합니다. (public/js/firebase-config.js 채우면 활성화)");
    SF.loginGoogle = async () => { throw new Error("Firebase 미설정: firebase-config.js 를 채워주세요."); };
    SF.logout = async () => {};
    SF.currentUser = () => null;
    SF.onAuth = (cb) => { try { cb(null); } catch (e) {} };
    SF.onIdTokenChanged = () => {};   // 미설정 시 no-op(22_Auth.js 가드가 이 없는 경우도 대비하지만 안전하게)
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
      /* [p113 토큰만료 수정] onAuthStateChanged 는 로그인/로그아웃에만 울린다. Firebase SDK가
         내부적으로(또는 reauth가) ID 토큰을 갱신할 때는 onIdTokenChanged 만 울리므로 별도로
         구독을 열어둔다(22_Auth.js 의 Auth.headers() 가 최신 토큰을 돌려주기 위한 공급원).
         🔴 [형제 호출부] 기존 p107 테스트 하니스의 authMod 스텁은 onAuthStateChanged 등 일부만
         흉내내므로, 실 SDK에는 항상 있는 이 함수가 없어도 초기화 전체가 죽지 않도록 가드한다. */
      if (typeof authMod.onIdTokenChanged === "function") {
        authMod.onIdTokenChanged(SF._auth, (u) => {
          SF._idTokenCbs.forEach((cb) => { try { cb(u); } catch (e) {} });
        });
      }
      SF.onIdTokenChanged = (cb) => { SF._idTokenCbs.push(cb); };

      // [SEcMS 검증 로직 이식] services/firebase.ts signInWithGoogle 패턴
      SF.loginGoogle = async () => {
        // ① 전체화면 위에서는 OS 구글 팝업이 가려지거나 차단됨 → 팝업 직전 전체화면 해제 (SEcMS Fix#131)
        try { if (document.fullscreenElement && document.exitFullscreen) await document.exitFullscreen(); } catch (e) {}
        // ② 매번 계정 선택 UI 강제 (자동 단일계정 진입 방지)
        try { provider.setCustomParameters({ prompt: "select_account" }); } catch (e) {}
        const res = await authMod.signInWithPopup(SF._auth, provider);
        return res.user;
      };
      /* [WO 20261001-bulkreauth] 본인 재인증 — 구글 공식 창에서 비밀번호/2단계 인증을 거친다(앱은 비밀번호를 받지 않는다).
         반환: 새 Firebase ID 토큰(auth_time 갱신). 팝업이 막힌 환경(모바일 등)은 redirect 로 폴백 →
         페이지가 이동하므로 이 약속은 끝나지 않고, 복귀 후 SF.reauthRedirectResult() 가 토큰을 돌려준다. */
      SF.REAUTH_REDIRECT_KEY = "wm_reauth_redirect";
      SF.reauthGoogle = async (email) => {
        try { if (document.fullscreenElement && document.exitFullscreen) await document.exitFullscreen(); } catch (e) {}
        const rp = new authMod.GoogleAuthProvider();
        try { rp.setCustomParameters(email ? { login_hint: email } : { prompt: "select_account" }); } catch (e) {}
        const cur = SF._auth.currentUser;
        try {
          const res = cur ? await authMod.reauthenticateWithPopup(cur, rp) : await authMod.signInWithPopup(SF._auth, rp);
          return await res.user.getIdToken(true);
        } catch (err) {
          const code = String((err && err.code) || "");
          if (code === "auth/popup-blocked" || code === "auth/operation-not-supported-in-this-environment") {
            try { sessionStorage.setItem(SF.REAUTH_REDIRECT_KEY, String(Date.now())); } catch (e) {}
            if (cur) await authMod.reauthenticateWithRedirect(cur, rp); else await authMod.signInWithRedirect(SF._auth, rp);
            return new Promise(() => {});   // 페이지 이동 — 복귀 후 reauthRedirectResult()
          }
          throw err;
        }
      };
      /** redirect 재인증 복귀 처리 — 표시가 있을 때만 결과를 읽고 새 ID 토큰을 돌려준다(없으면 null). */
      SF.reauthRedirectResult = async () => {
        let mark = null;
        try { mark = sessionStorage.getItem(SF.REAUTH_REDIRECT_KEY); sessionStorage.removeItem(SF.REAUTH_REDIRECT_KEY); } catch (e) {}
        if (!mark) return null;
        const res = await authMod.getRedirectResult(SF._auth);
        return (res && res.user) ? await res.user.getIdToken(true) : null;
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
