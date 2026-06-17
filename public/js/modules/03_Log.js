  const Log = {
    /** action(화이트리스트), targetId?, detail? */
    push(action, targetId, detail) {
      try {
        // 로그인 안 된 상태면 서버가 401 → 조용히 무시됨
        fetch("/api/client-log", {
          method: "POST",
          headers: Auth.headers(),
          body: JSON.stringify({ action, targetId: targetId || undefined, detail: detail || undefined }),
          keepalive: true
        }).catch(() => {});
      } catch (e) {}
    }
  };

  /* ══════════════════════════════════════════
     CLOUD  — 360° 그림 파일 저장소 (RESTful Table API)
  ══════════════════════════════════════════ */