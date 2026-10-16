
  /* ══════════════════════════════════════════════════════════════
     사진 폴더 지정 — 핀 번호 ↔ 파일명 자동 매칭·등록 (구역별 확장)
     ────────────────────────────────────────────────────────────────
     [WO 20261013-photofolder] 마스터(음성): "지정한 폴더에서 핀 번호와 일치하는 360 사진 — 핀만
     찍으면 바로 찾아서 '이 사진을 등록할까요?' … 다음부터 핀만 찍으면 … 자동으로 등록하는 기능까지".

     [WO 20261015-photofolder2 · 지휘자 발주] 마스터(음성) 3건:
       ① "파일 이름 앞에 알파벳이 있더라도 뒤에 숫자 세 자리만 일치하면 완벽하게 갖다 꽂도록 해."
       ② "각 구역별로 폴더 지정을 먼저 일괄적으로 하면, 일괄 등록 기능과 하나씩 등록하는 기능을
          체크박스 옵션으로 구분하도록 해."
       ③ "체크보드 모드에서 번호만 일괄적으로 찍고 나서 사진 폴더나 특정 경로를 지정해서 …
          일치하면 바로 그 위치에 360도 사진이 일괄적으로 들어가게."

     [WO 20261015-photofolder2 추가확정 · 마스터(음성)] "핀 번호는 1 2 3 4 처럼 한 자리로
     보여주지만, 인식할 때는 001, 002, 003 처럼 세 자리로 인식하고, 파일 이름도 그런 식으로
     매칭할 수 있도록 해." → 표시(PinSeries.formatNo)는 절대 불변.

     🔴 [2026-10-15 지휘자 정정 · 번호 통합 설계 .tmp/design-numunify.md ③ 실측 근거] 다중 사용자
     번호 대역(예: 대역11=1001~1100)이 있어 "끝 3자리만 잘라 비교"하면 1001↔001 오매칭이 난다.
     그래서 비교는 **두 단계**다(matchKey 의 3자리 0채움은 미리보기 "인식 001" 표시용일 뿐,
     비교에는 안 쓴다):
       1차 — 파일 끝 숫자열 **전체**를 정수로(앞자리 0 무시) → 핀 번호와 직접 같으면 일치.
       2차(폴백) — 1차가 실패하고, 숫자열이 3자리를 넘고, 핀 번호가 999 이하이며, 그 숫자열
         전체 정수가 "이 페이지에 실제로 있는 다른 핀 번호"가 아닐 때만 — 마지막 3자리로 재비교
         ("그 사진은 그 핀의 것" — 진짜 주인이 있으면 폴백 금지).
     🔴 매칭 입력 번호는 반드시 PinSeries.numbers(State.pins, page).get(pin.id).no 다 — formatNo
     는 표시 문자열이라 쓰지 않는다(표시 형식이 바뀌면 매칭이 조용히 깨진다).

     기존 35_PhotoBatch.js(시각 최근접/일괄 매칭)와는 완전히 다른 경로다 — 이 모듈은 "파일명 ↔
     핀 번호" 매칭만 담당한다. 등록 자체(저장 API 조합)는 재구현하지 않고 PhotoBatch._uploadOneRow
     (resizeImage/uploadImage/SyncQueue.enqueue, 오프라인 폴백 포함)를 그대로 재사용한다(§10 SoT).
     360 판별도 App._detect360 재사용(자체 판별 로직 추가 금지).

     진입 훅(불변 — 20_App.js 수정 0): 20_App.js _handlePlaceClick() 의 State.regMode==="photo" 분기
     — 핀 생성 직후 PhotoFolder.handlePinPlaced(pin) 을 먼저 묻고, false(미처리)면 기존
     PhotoBatch.autoConnectPin 폴백으로 넘어간다. handlePinPlaced() 의 외부 시그니처는 845a081과
     100% 동일 — 내부가 구역별로 폴더를 고르도록 바뀌었을 뿐이다.

     🔴 구역별 폴더(SoT) — 키 = "photofolder:<projectId>:<deckKey>"(deckKey="__root__"는 "원본/
     프로젝트 기본값"). 핀이 속한 구역은 Projects.pinsForDeck()로 판정하고, 그 구역에 폴더가
     없으면 부모 구역 → 원본(__root__) 순서로 폴백한다(_deckChainForPin). 845a081의 프로젝트
     단위 키("photofolder:<projectId>")는 레거시로 남기고, __root__ 복원 시 1회만 마이그레이션
     한다(복제만 — 레거시 레코드 삭제 0, 데이터 유실 0).

     🔴 등록 방식 체크박스(구역별 저장) — "일괄 등록"(기존 핀 전체를 한 번에 미리보기→확인→등록)과
     "하나씩 등록"(845a081 원래 흐름 — 핀 찍을 때마다 확인/자동)을 구역마다 독립 ON/OFF 한다.
     둘 다 꺼진 구역은 종전 파일선택 폴백만(체감 변화 0).

     🔴 [WO 20261015-numunify] CHECKER(체크보드) 핀도 대상이다 — 244c5d8 의 "CHECKER 예외 미구현, 결정
     대기"는 **허용**으로 확정(마스터: "체크 모드와 360 모드 번호를 하나로 합치고 … 체크보드 모드에서 번호만
     일괄적으로 찍고 나서 사진폴더 … 바로 그 위치에 360도 사진이 일괄적으로"). 번호 공간이 (배포본, 페이지)
     1개로 통합돼(.tmp/design-numunify.md §2) 같은 번호가 두 핀에 걸리는 모호성이 없어졌다. 폴더 바는
     360 전용(syncUI 주석 — 모바일 가림 실측), CHECKER 진입 = 기능 메뉴 [구역별 사진 폴더 지정] → 일괄 등록.
     "핀 찍을 때 사진창"은 360 모드 배치에서만(20_App 진입 훅 불변).

     폴더 핸들 영속화: 새 IndexedDB 스토어/DB버전 업그레이드 없이 SyncQueue.saveDraft/loadDraft
     (05_SyncQueue.js DRAFT_STORE, 기존 스토어 재사용)를 재사용한다 — FileSystemDirectoryHandle 은
     구조적 복제(structured clone) 가능해 기존 draft 저장경로에 그대로 담긴다(§5 사다리).
  ══════════════════════════════════════════════════════════════ */
  const PhotoFolder = {
    _EXT_RE: /\.(jpe?g|png|heic)$/i,
    _decks: null,          // Map<deckKey, {mode,dirHandle,fallbackFiles,folderLabel,fileCount,permGranted,restored,restoring}>
    _pickTargetKey: null,  // 폴백(webkitdirectory) change 이벤트가 어느 구역 키를 겨냥한 pickFolder() 호출인지
    _afterPick: null,      // 폴백 change 완료 후 1회 콜백(Deck Manager 행 갱신용)
    _lastBatchRows: null,

    /* ══ 순수 로직 — 회귀 테스트가 직접 호출한다(DOM 무의존) ══════════════════════════ */

    /** [표시·로그 전용] 핀 번호 → 3자리 0채움 문자열(미리보기 "인식 001"). 🔴 비교에는 쓰지 않는다
     *  — 1001 번(대역11)과 1번이 둘 다 "001"이 되어 끝 3자리만으로 비교하면 서로 오매칭된다. */
    _matchKey(pinNo) {
      const n = parseInt(pinNo, 10);
      if (!Number.isFinite(n) || n < 0) return null;
      return String(n % 1000).padStart(3, "0");
    },

    /** 파일명(확장자 제외) 끝쪽 연속 숫자열(원본 문자열, 자르지 않음) — 없으면 null(끝이 숫자가 아님). */
    _fileDigits(filename) {
      const base = String(filename || "").replace(/\.[^.]+$/, "");
      const m = /(\d+)$/.exec(base);
      return m ? m[1] : null;
    },

    /** 1차 비교값 — 숫자열 **전체**를 정수로(parseInt 가 앞자리 0을 자동 무시). */
    _fileFullNo(filename) {
      const d = this._fileDigits(filename);
      if (d == null) return null;
      const n = parseInt(d, 10);
      return Number.isFinite(n) ? n : null;
    },

    /** 2차(폴백) 비교값 — 숫자열이 3자리를 넘을 때만 마지막 3자리(3자리 이하는 1차와 값이 같아
     *  폴백을 따로 둘 필요가 없다 → null = 폴백 비대상).
     *  ⚠ 한계: RICOH THETA 기본 파일명(R0010123.JPG)은 1차 실패 시 끝 3자리 "123"만 본다 —
     *  실제 촬영 순번과 무관하게 123번 핀 폴백 후보가 된다(이름을 그대로 쓰면 이 한계에 걸린다 —
     *  PhotoNaming 으로 저장 시 이름을 바꾸거나 핀 번호를 그 3자리에 맞추는 것을 권장). */
    _fileFallbackNo(filename) {
      const d = this._fileDigits(filename);
      if (d == null || d.length <= 3) return null;
      const n = parseInt(d.slice(-3), 10);
      return Number.isFinite(n) ? n : null;
    },

    /** 핀 번호(정수) ↔ 파일명 매칭(두 단계, 위 헤더 주석 참조).
     *  @param {Set<number>} [existingNumbers] 이 페이지에 실제로 존재하는 핀 번호 — 2차 폴백 억제 판정용.
     *  미전달 시 억제하지 않는다(단일 핀만 보는 순수 호출 — handlePinPlaced/previewBatch 는 항상 전달).
     *  예: 1↔"A001.jpg"/"ER_001.JPG"/"0000000001.jpg"/"1.jpg" true(1차). 1001↔"A1001.jpg" true(1차).
     *      1↔"A1001.jpg"(1001핀 존재) false(폴백 억제). 5↔"ER3005.jpg"(3005핀 없음) true(2차).
     *      1↔"A010.jpg"/"A100.jpg" false(숫자열 3자리 이하라 폴백 비대상). */
    isMatch(pinNo, filename, existingNumbers) {
      const pn = parseInt(pinNo, 10);
      if (!Number.isFinite(pn)) return false;
      const full = this._fileFullNo(filename);
      if (full !== null && full === pn) return true;
      if (pn > 999) return false;
      const fb = this._fileFallbackNo(filename);
      if (fb === null) return false;
      if (full !== null && existingNumbers && existingNumbers.has(full)) return false; // 그 숫자열의 진짜 주인 핀이 있으면 폴백 금지
      return fb === pn;
    },

    /** 대상 확장자(jpg/jpeg/png/heic) + 번호 일치 항목만. entries: [{name,...}]. 순수 함수. */
    findMatches(pinNo, entries, existingNumbers) {
      return (entries || []).filter((e) => e && e.name && this._EXT_RE.test(e.name) && this.isMatch(pinNo, e.name, existingNumbers));
    },

    /** [WO 20261016-multisheet P5] 파일명 숫자 앞 접두 토큰(FPX) — A012.jpg→"A", ER_A012.JPG→"A", B2-05.jpg→"B2", 012.jpg→"". 순수. */
    _filePrefix(filename) {
      const base = String(filename || "").replace(/\.[^.]+$/, "");
      const m = /(\d+)$/.exec(base);
      if (!m) return "";
      const before = base.slice(0, m.index).replace(/[-_]+$/, "");
      const t = /([A-Za-z][A-Za-z0-9]{0,5})$/.exec(before);
      return t ? t[1] : "";
    },
    /** [P5] 🔴 마스터 규칙 유지 + 충돌 시에만 접두 요구 — 숫자 매칭(findMatches, 불변) 위 레이어.
     *  peers = 같은 번호 공간의 논리 핀 [{no, prefix}]. 같은 숫자 번호를 가진 핀이 1개(접두 없는 프로젝트 전부)면 종전 그대로.
     *  2개 이상(A12·B12 공존)이면 파일 접두가 이 핀 접두와 같은 것만 매칭 — 없으면 매칭하지 않고, 다른 핀 접두에 속하지
     *  않는 파일(012.jpg)은 ambiguous 로 돌려 선택창에 띄운다(조용한 오등록 금지).
     *  @returns {{matches:Array, ambiguous:Array}} */
    rankMatches(pinNo, prefix, entries, peers, existingNumbers) {
      const base = this.findMatches(pinNo, entries, existingNumbers);
      const n = parseInt(pinNo, 10);
      const same = (peers || []).filter((q) => q && q.no === n);
      if (same.length < 2) return { matches: base, ambiguous: [] };
      const K = (s) => (typeof PinSeries !== "undefined" && PinSeries.prefixKey) ? PinSeries.prefixKey(s) : String(s || "").replace(/[-_]$/, "").toUpperCase();
      const mine = K(prefix || "");
      const fk = (e) => K(this._filePrefix(e.name));
      const keep = base.filter((e) => fk(e) === mine);
      if (keep.length) return { matches: keep, ambiguous: [] };
      const claimed = new Set(same.map((q) => K(q.prefix || "")));
      return { matches: [], ambiguous: base.filter((e) => !claimed.has(fk(e))) };
    },
    /** 번호 공간(시트 묶음 — PinSeries.scopePages, 연결 OFF 면 그 페이지) 논리 핀의 {id,no,prefix} — rankMatches peers. */
    _peers(page) {
      try {
        if (typeof PinSeries === "undefined" || !PinSeries.numbers) return [];
        const pins = (typeof State !== "undefined" ? State.pins : []) || [];
        const scope = PinSeries.scopePages ? PinSeries.scopePages(page, pins) : [page];
        const units = new Set(), out = [];
        scope.forEach((sp) => PinSeries.numbers(pins, sp).forEach((info, id) => {
          const p = pins.find((q) => q && q.id === id);
          const u = (p && p.linkId != null && p.linkId !== "") ? "L" + String(p.linkId) : "I" + String(id);
          if (units.has(u)) return;
          units.add(u);
          out.push({ id: id, no: info.no, prefix: info.prefix || "" });
        }));
        return out;
      } catch (e) { return []; }
    },
    /** 핀 표시 번호(접두 포함 A12) — 표시 전용(매칭은 .no). */
    _labelFor(pin, no) {
      try { const m = PinSeries.numbers(State.pins, (pin && pin.page) || State.pdfPage || 1).get(pin.id); if (m) return PinSeries.textOf(m); } catch (e) {}
      return (typeof PinSeries !== "undefined" && PinSeries.formatNo) ? PinSeries.formatNo(no, "content") : String(no);
    },
    _prefixFor(pin) {
      try { const m = PinSeries.numbers(State.pins, (pin && pin.page) || State.pdfPage || 1).get(pin.id); return (m && m.prefix) || ""; } catch (e) { return ""; }
    },

    /* ══ 구역 키 · 상태 저장소 ══════════════════════════════════════════════════════ */

    _deckKey(deck) { return (deck && deck.id != null) ? String(deck.id) : "__root__"; },
    _activeDeckKey() { return this._deckKey(typeof Projects !== "undefined" ? Projects.currentDeck : null); },

    _entry(key) {
      if (!this._decks) this._decks = new Map();
      if (!this._decks.has(key)) {
        this._decks.set(key, { mode: null, dirHandle: null, fallbackFiles: null, folderLabel: "", fileCount: null, permGranted: null, restored: false, restoring: null });
      }
      return this._decks.get(key);
    },

    hasFolder(key) {
      const e = this._entry(key || this._activeDeckKey());
      if (e.mode === "handle") return !!e.dirHandle;
      if (e.mode === "fallback") return !!(e.fallbackFiles && e.fallbackFiles.length);
      return false;
    },

    isSupported() { return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function"; },
    _projectId() { return (typeof Projects !== "undefined" && Projects.currentProject && Projects.currentProject.id) || "default"; },
    _draftKey(key) { return "photofolder:" + this._projectId() + ":" + key; },
    _legacyDraftKey() { return "photofolder:" + this._projectId(); },           // 845a081 프로젝트 단위 키
    _legacyAutoKey() { return "wm_photofolder_auto_" + this._projectId(); },    // 845a081 자동등록 플래그
    _prefKey(kind, key) { return "wm_photofolder_" + kind + "_" + this._projectId() + "_" + key; },

    isBatchOn(key) { try { return localStorage.getItem(this._prefKey("batch", key)) === "1"; } catch (e) { return false; } },
    setBatchOn(key, on) { try { localStorage.setItem(this._prefKey("batch", key), on ? "1" : "0"); } catch (e) {} this._updateStatusUI(key); },
    isSingleOn(key) { try { return localStorage.getItem(this._prefKey("single", key)) === "1"; } catch (e) { return false; } },
    setSingleOn(key, on) { try { localStorage.setItem(this._prefKey("single", key), on ? "1" : "0"); } catch (e) {} this._updateStatusUI(key); },
    isAutoOn(key) { try { return localStorage.getItem(this._prefKey("auto", key)) === "1"; } catch (e) { return false; } },
    setAuto(key, on) { try { localStorage.setItem(this._prefKey("auto", key), on ? "1" : "0"); } catch (e) {} this._updateStatusUI(key); },

    /** 지원 브라우저: showDirectoryPicker. 미지원: webkitdirectory input 폴백(스냅샷만, 재열거 없음).
     *  @returns {Promise<true>|false|null} true=성공(handle), false=취소/실패, null=비동기(폴백 change 대기) */
    async pickFolder(key) {
      key = key || this._activeDeckKey();
      if (this.isSupported()) {
        try {
          const handle = await window.showDirectoryPicker({ mode: "read" });
          const e = this._entry(key);
          e.dirHandle = handle; e.mode = "handle"; e.folderLabel = handle.name; e.permGranted = true; e.restored = true;
          try { if (typeof SyncQueue !== "undefined" && SyncQueue.saveDraft) await SyncQueue.saveDraft(this._draftKey(key), { name: handle.name, handle: handle }); } catch (e2) {}
          await this._refreshCount(key);
          return true;
        } catch (e) { return false; } // 사용자 취소 포함
      }
      this._ensureFallbackInput();
      this._pickTargetKey = key;
      const input = document.getElementById("photofolder-fallback-input");
      if (input) input.click();
      return null; // 비동기(change 이벤트)로 결정됨
    },

    _ensureFallbackInput() {
      if (document.getElementById("photofolder-fallback-input")) return;
      const input = document.createElement("input");
      input.type = "file"; input.multiple = true; input.id = "photofolder-fallback-input";
      input.setAttribute("webkitdirectory", "");
      input.setAttribute("accept", "image/*");
      input.style.display = "none";
      input.addEventListener("change", (e) => {
        const files = Array.from(e.target.files || []);
        e.target.value = "";
        if (!files.length) return;
        const key = this._pickTargetKey || this._activeDeckKey();
        const entry = this._entry(key);
        entry.fallbackFiles = files;
        entry.mode = "fallback";
        entry.restored = true;
        entry.folderLabel = (files[0] && files[0].webkitRelativePath) ? files[0].webkitRelativePath.split("/")[0] : "선택한 폴더";
        entry.fileCount = files.length;
        this._updateStatusUI(key);
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("사진 폴더 지정됨(" + files.length + "장) — 새 사진이 생기면 폴더를 다시 지정하세요");
        if (this._afterPick) { const cb = this._afterPick; this._afterPick = null; try { cb(key); } catch (e3) {} }
      });
      document.body.appendChild(input);
    },

    /** 구역 키별 1회, IndexedDB에서 이전에 지정한 폴더 핸들을 복원(있으면). 권한은 재요청 전까지
     *  "확인" 상태로만 두고(queryPermission, 사용자 제스처 불필요), 실제 읽기는 requestPermission()
     *  (버튼 클릭 = 사용자 제스처)이 통과해야 진행한다.
     *  🔴 key==="__root__" 이고 아직 새 키에 레코드가 없으면 845a081 레거시 프로젝트 단위 키를
     *  1회 마이그레이션(복제)한다 — 레거시 레코드는 지우지 않는다(데이터 유실 0). 이때 레거시
     *  "자동 등록" 플래그도 같이 넘겨, 이미 쓰고 있던 사용자의 체감이 바뀌지 않게 한다(하나씩
     *  등록 ON + 자동값 이관). */
    async _restoreKey(key) {
      const entry = this._entry(key);
      if (entry.restored) return;
      if (entry.restoring) { await entry.restoring; return; }
      entry.restoring = (async () => {
        try {
          if (typeof SyncQueue === "undefined" || !SyncQueue.loadDraft) return;
          let rec = await SyncQueue.loadDraft(this._draftKey(key));
          let migrated = false;
          if (!rec && key === "__root__") {
            try { rec = await SyncQueue.loadDraft(this._legacyDraftKey()); if (rec) migrated = true; } catch (e) {}
          }
          if (!rec || !rec.handle) return;
          entry.dirHandle = rec.handle; entry.mode = "handle"; entry.folderLabel = rec.name || rec.handle.name || "";
          try {
            const perm = await entry.dirHandle.queryPermission({ mode: "read" });
            entry.permGranted = perm === "granted";
          } catch (e) { entry.permGranted = false; }
          if (entry.permGranted) await this._refreshCount(key);
          if (migrated) {
            try { if (SyncQueue.saveDraft) await SyncQueue.saveDraft(this._draftKey(key), { name: entry.folderLabel, handle: entry.dirHandle }); } catch (e) {}
            try {
              if (localStorage.getItem(this._prefKey("single", key)) == null) this.setSingleOn(key, true);
              const legacyAuto = localStorage.getItem(this._legacyAutoKey());
              if (legacyAuto != null && localStorage.getItem(this._prefKey("auto", key)) == null) this.setAuto(key, legacyAuto === "1");
            } catch (e) {}
          }
        } catch (e) {}
      })();
      await entry.restoring;
      entry.restored = true;
    },

    /** 사용자 제스처(버튼 클릭) 안에서만 호출 — 재방문 시 권한 재요청. */
    async requestPermission(key) {
      key = key || this._activeDeckKey();
      const e = this._entry(key);
      if (!e.dirHandle || typeof e.dirHandle.requestPermission !== "function") return false;
      try {
        const perm = await e.dirHandle.requestPermission({ mode: "read" });
        e.permGranted = perm === "granted";
        if (e.permGranted) await this._refreshCount(key); else this._updateStatusUI(key);
        return e.permGranted;
      } catch (err) { return false; }
    },

    async _listEntries(key) {
      key = key || this._activeDeckKey();
      const e = this._entry(key);
      if (e.mode === "handle" && e.dirHandle) {
        if (e.permGranted === false) return [];
        const out = [];
        try {
          for await (const entry of e.dirHandle.values()) {
            if (entry.kind === "file") out.push({ name: entry.name, getFile: () => entry.getFile() });
          }
        } catch (err) {}
        return out;
      }
      if (e.mode === "fallback" && e.fallbackFiles) {
        return e.fallbackFiles.map((f) => ({ name: f.name, getFile: async () => f }));
      }
      return [];
    },

    async _refreshCount(key) {
      key = key || this._activeDeckKey();
      const entries = await this._listEntries(key);
      this._entry(key).fileCount = entries.length;
      this._updateStatusUI(key);
      return entries;
    },

    _updateStatusUI(key) {
      key = key || this._activeDeckKey();
      if (key !== this._activeDeckKey()) return; // 플로팅 바는 "지금 보는 구역"만 반영 — 다른 구역 갱신은 바에 영향 없음
      const e = this._entry(key);
      const el = document.getElementById("photofolder-status-text");
      const autoCb = document.getElementById("photofolder-auto-cb");
      const singleCb = document.getElementById("photofolder-single-cb");
      const batchCb = document.getElementById("photofolder-batch-cb");
      if (autoCb) autoCb.checked = this.isAutoOn(key);
      if (singleCb) singleCb.checked = this.isSingleOn(key);
      if (batchCb) batchCb.checked = this.isBatchOn(key);
      const reBtn = document.getElementById("photofolder-reconnect-btn");
      if (reBtn) reBtn.classList.toggle("hidden", !(e.mode === "handle" && e.permGranted === false));
      if (!el) return;
      if (!this.hasFolder(key)) { el.textContent = "사진 폴더: 지정 안됨"; return; }
      if (e.mode === "handle" && e.permGranted === false) { el.textContent = "사진 폴더: " + e.folderLabel + " — 재연결 필요"; return; }
      el.textContent = "사진 폴더: " + e.folderLabel + (Number.isFinite(e.fileCount) ? (" (" + e.fileCount + "장)") : "");
    },

    async _refreshBarForActiveDeck() {
      const key = this._activeDeckKey();
      await this._restoreKey(key);
      this._updateStatusUI(key);
    },

    /* ══ DOM 연결 — 상태 바(floating, index.html 비점유) ══════════════════════════════ */

    init() {
      this._ensureBar();
      try { this._refreshBarForActiveDeck(); } catch (e) {}
    },

    _ensureBar() {
      if (document.getElementById("photofolder-bar")) return;
      const bar = document.createElement("div");
      bar.id = "photofolder-bar";
      bar.className = "hidden";
      bar.setAttribute("style", "position:fixed;left:50%;bottom:64px;transform:translateX(-50%);z-index:900;background:rgba(17,17,17,.92);color:#fff;border-radius:10px;padding:8px 12px;display:flex;align-items:center;gap:8px;font-size:12px;max-width:92vw;flex-wrap:wrap;");
      const status = document.createElement("span"); status.id = "photofolder-status-text"; status.textContent = "사진 폴더: 지정 안됨";
      const pickBtn = document.createElement("button"); pickBtn.type = "button"; pickBtn.id = "photofolder-pick-btn"; pickBtn.textContent = "📁 사진 폴더 지정";
      pickBtn.setAttribute("style", "padding:4px 8px;border-radius:6px;border:1px solid #666;background:#2f6db5;color:#fff;cursor:pointer;font-size:12px;");
      const reBtn = document.createElement("button"); reBtn.type = "button"; reBtn.id = "photofolder-reconnect-btn"; reBtn.textContent = "재연결"; reBtn.className = "hidden";
      reBtn.setAttribute("style", "padding:4px 8px;border-radius:6px;border:1px solid #666;background:#f5f5f5;color:#111;cursor:pointer;font-size:12px;");
      const singleLabel = document.createElement("label"); singleLabel.setAttribute("style", "display:flex;align-items:center;gap:4px;cursor:pointer;");
      const singleCb = document.createElement("input"); singleCb.type = "checkbox"; singleCb.id = "photofolder-single-cb";
      singleLabel.appendChild(singleCb); singleLabel.appendChild(document.createTextNode("하나씩 등록"));
      const autoLabel = document.createElement("label"); autoLabel.setAttribute("style", "display:flex;align-items:center;gap:4px;cursor:pointer;");
      const autoCb = document.createElement("input"); autoCb.type = "checkbox"; autoCb.id = "photofolder-auto-cb";
      autoLabel.appendChild(autoCb); autoLabel.appendChild(document.createTextNode("자동(묻지 않음)"));
      const mgrBtn = document.createElement("button"); mgrBtn.type = "button"; mgrBtn.id = "photofolder-deckmgr-btn"; mgrBtn.textContent = "구역별 폴더 관리";
      mgrBtn.setAttribute("style", "padding:4px 8px;border-radius:6px;border:1px solid #666;background:#f5f5f5;color:#111;cursor:pointer;font-size:12px;");
      bar.appendChild(status); bar.appendChild(pickBtn); bar.appendChild(reBtn); bar.appendChild(singleLabel); bar.appendChild(autoLabel); bar.appendChild(mgrBtn);
      document.body.appendChild(bar);
      pickBtn.addEventListener("click", () => this.pickFolder(this._activeDeckKey()));
      reBtn.addEventListener("click", () => this.requestPermission(this._activeDeckKey()));
      singleCb.addEventListener("change", () => this.setSingleOn(this._activeDeckKey(), singleCb.checked));
      autoCb.addEventListener("change", () => this.setAuto(this._activeDeckKey(), autoCb.checked));
      mgrBtn.addEventListener("click", () => this.openDeckManager());
      this._updateStatusUI(this._activeDeckKey());
    },

    /** [WO 20261013-photofolder §5] 열람자(Auth.readonly)에게는 바를 포함해 기능 0. */
    syncUI() {
      const bar = document.getElementById("photofolder-bar");
      if (!bar) return;
      const readonly = typeof Auth !== "undefined" && Auth.readonly;
      // 🔴 [WO 20261015-numunify — 설계 §5 #9 의도적 미적용, 실측 근거] 이 바(position:fixed 하단 중앙)를 CHECKER 모드에도
      //   띄우면 모바일에서 ① 연속 탭 위치를 가리고(p114: 10탭 중 3탭이 #photofolder-bar 에 맞음) ② 배치 해제 상태에선 하단
      //   도크의 [포인트] 버튼을 가려 CHECKER 핀이 0개 생성됐다(p146 matrix O=[] — 기준 7cb6b66 은 3개). 그래서 바는 360 전용으로
      //   두고, CHECKER 의 "번호 찍고 → 폴더 지정 → 일괄 등록"은 모드 무관 진입인 기능 메뉴 [구역별 사진 폴더 지정](openDeckManager
      //   → 일괄 등록, _batchTargets 가 체커 핀 포함)과 [사진 폴더 일괄 매칭](#btn-photobatch, CHECKER 에서도 표시)으로 한다.
      const active = !readonly && typeof State !== "undefined" && State.checkboard && State.regMode === "photo";
      bar.classList.toggle("hidden", !active);
      if (active) { try { this._refreshBarForActiveDeck(); } catch (e) {} }
    },

    /* ══ 핀 → 구역(폴더) 해석 ══════════════════════════════════════════════════════ */

    /** 핀이 속한 가장 구체적인 구역 — 같은 페이지에서 핀을 품는 crop 중 면적이 가장 작은 것.
     *  crop 없는(벡터복사·루트) 구역은 "전체" 범위라 여기선 후보에서 제외하고, 못 찾으면
     *  현재 선택된 구역(Projects.currentDeck)으로 폴백한다(기존 단일-폴더 체감과 동일). */
    _deckForPin(pin) {
      if (typeof Projects === "undefined" || !Array.isArray(Projects.decks)) return (typeof Projects !== "undefined" ? Projects.currentDeck : null) || null;
      const page = (pin && pin.page) || 1;
      let best = null, bestArea = Infinity;
      Projects.decks.forEach((d) => {
        if (!d || (d.page || 1) !== page || !d.crop || !(d.crop.w > 0) || !(d.crop.h > 0)) return;
        const within = Projects.pinsForDeck ? Projects.pinsForDeck([pin], d).length > 0 : false;
        if (!within) return;
        const area = d.crop.w * d.crop.h;
        if (area < bestArea) { bestArea = area; best = d; }
      });
      return best || Projects.currentDeck || null;
    },

    /** 핀의 구역 → 부모 구역들 → 원본(__root__) 순서의 키 목록(폴더 폴백 순서). */
    _deckChainForPin(pin) {
      const chain = [];
      const decksArr = (typeof Projects !== "undefined" && Array.isArray(Projects.decks)) ? Projects.decks : [];
      const byId = new Map(decksArr.map((d) => [String(d.id), d]));
      let deck = this._deckForPin(pin);
      const seen = new Set();
      while (deck && deck.id != null && !seen.has(String(deck.id))) {
        seen.add(String(deck.id));
        chain.push(this._deckKey(deck));
        deck = deck.parent_id != null ? byId.get(String(deck.parent_id)) : null;
      }
      chain.push("__root__");
      return chain;
    },

    /** 핀의 구역 체인을 따라 폴더가 지정된 첫 구역 키를 찾는다. 없으면 null(기존 폴백으로). */
    async _resolveFolderKeyForPin(pin) {
      const chain = this._deckChainForPin(pin);
      for (const key of chain) {
        await this._restoreKey(key);
        if (this.hasFolder(key)) return key;
      }
      return null;
    },

    /* ══ 등록 1건 — PhotoBatch._uploadOneRow 재사용 ══════════════════════════════════ */

    _pinNo(pin) {
      try {
        if (typeof PinSeries === "undefined" || !PinSeries.numbers) return null;
        // [WO 20261016-multisheet] 핀 자신의 페이지(연결 대표는 다른 시트에 있을 수 있다) — 배치 직후 핀은 지금 페이지와 같다
        const page = (pin && pin.page) || (typeof State !== "undefined" ? (State.pdfPage || 1) : 1);
        const map = PinSeries.numbers(State.pins, page);
        const info = map.get(pin.id);
        return info ? info.no : null;
      } catch (e) { return null; }
    },

    /** 이 페이지에 실제로 존재하는 핀 번호 Set — isMatch() 2차 폴백 억제 판정용(§헤더 주석).
     *  PinSeries.numbers()의 `.no` 만 쓴다(§5 — formatNo 는 표시 문자열이라 매칭에 쓰지 않는다). */
    _existingNumbers(page) {
      try {
        if (typeof PinSeries === "undefined" || !PinSeries.numbers) return new Set();
        const pins = (typeof State !== "undefined" ? State.pins : []);
        const set = new Set();
        // [WO 20261016-multisheet P2] 번호 공간 전체(시트 묶음) — 연결 OFF 면 [page] = 종전
        const scope = PinSeries.scopePages ? PinSeries.scopePages(page, pins) : [page];
        scope.forEach((sp) => PinSeries.numbers(pins, sp).forEach((info) => { if (info && Number.isFinite(info.no)) set.add(info.no); }));
        return set;
      } catch (e) { return new Set(); }
    },

    /** @param {boolean} [overwrite=false] [WO 20261016-multiselect] 기본 false(기존 845a081 동작 불변) —
     *  67_PinMultiPhoto.js(핀 멀티선택 ↔ 파일 멀티선택 등록)만 true 를 넘긴다(§SoT, 업로드 경로는 1곳). */
    async _registerEntry(pin, entry, source, overwrite) {
      const file = await entry.getFile();
      const row = { file: file, name: entry.name, sortKey: Number.isFinite(file.lastModified) ? file.lastModified : NaN, timeSource: "폴더 매칭", is360: null, w: 0, h: 0 };
      await new Promise((resolve) => {
        if (typeof App === "undefined" || !App._detect360) { resolve(); return; }
        App._detect360(file, (is360, w, h) => { row.is360 = is360; row.w = w; row.h = h; resolve(); });
      });
      const usedNames = (typeof PhotoBatch !== "undefined" && PhotoBatch._usedPhotoNames) ? PhotoBatch._usedPhotoNames() : new Set();
      const r = (typeof PhotoBatch !== "undefined" && PhotoBatch._uploadOneRow) ? await PhotoBatch._uploadOneRow(pin, row, !!overwrite, usedNames, source) : { status: "fail", reason: "PhotoBatch 미로드" };
      if (r.status === "done") {
        try { UI.renderPinList(); UI.renderPinsOnMap(); if (typeof PinGrid !== "undefined") PinGrid.render(); } catch (e) {}
        try { App._updateSyncBadge && App._updateSyncBadge(); } catch (e) {}
        try { if (typeof PhotoBatch !== "undefined" && PhotoBatch._markUnsaved) PhotoBatch._markUnsaved(); } catch (e) {}
      }
      return r;
    },

    _undoLast(pin) {
      try {
        pin.imageId = null; pin.imageUrl = null; pin.pendingOpId = null; pin.pendingSync = false;
        pin.imageName = null; pin.origName = null; pin.shotAt = null; pin.shotSrc = null; pin.is360 = false;
        if (typeof UI !== "undefined") { UI.renderPinList(); UI.renderPinsOnMap(); }
        if (typeof PhotoBatch !== "undefined" && PhotoBatch._markUnsaved) PhotoBatch._markUnsaved();
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("등록을 취소했습니다");
      } catch (e) {}
    },

    _esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); },

    /* ══ 확인/선택 모달(JS 생성 — index.html 비점유, 기존 pb-tm-panel 관례와 동일) ══════ */

    _ensureConfirmModal() {
      if (document.getElementById("photofolder-confirm-modal")) return;
      const modal = document.createElement("div");
      modal.id = "photofolder-confirm-modal";
      modal.className = "admin-gate-backdrop hidden";
      modal.setAttribute("style", "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;");
      modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.add("hidden"); });
      const panel = document.createElement("div");
      panel.setAttribute("style", "background:#fff;color:#111;max-width:420px;width:88vw;border-radius:12px;padding:18px;");
      const msg = document.createElement("p"); msg.id = "photofolder-confirm-msg"; msg.setAttribute("style", "margin:0 0 14px;font-size:14px;color:#111;");
      const btnBar = document.createElement("div"); btnBar.setAttribute("style", "display:flex;flex-direction:column;gap:8px;");
      const mkBtn = (id, text, primary) => {
        const b = document.createElement("button"); b.type = "button"; b.id = id; b.textContent = text;
        b.setAttribute("style", "padding:10px 14px;border-radius:8px;border:1px solid #ccc;font-size:14px;cursor:pointer;" + (primary ? "background:#2f6db5;color:#fff;border-color:#1d4f88;" : "background:#f5f5f5;color:#111;"));
        return b;
      };
      btnBar.appendChild(mkBtn("photofolder-confirm-register", "등록", true));
      btnBar.appendChild(mkBtn("photofolder-confirm-auto", "앞으로 자동 등록", false));
      btnBar.appendChild(mkBtn("photofolder-confirm-skip", "건너뛰기", false));
      panel.appendChild(msg); panel.appendChild(btnBar);
      modal.appendChild(panel);
      document.body.appendChild(modal);
    },

    _showConfirmModal(pin, no, entry, key) {
      this._ensureConfirmModal();
      const modal = document.getElementById("photofolder-confirm-modal");
      const label = this._labelFor(pin, no);
      document.getElementById("photofolder-confirm-msg").textContent = label + " ← " + entry.name + " — 이 사진을 등록할까요?";
      const close = () => modal.classList.add("hidden");
      document.getElementById("photofolder-confirm-register").onclick = async () => {
        close();
        const r = await this._registerEntry(pin, entry, "폴더확인");
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast(r.status === "done" ? (label + " ← " + entry.name + " 등록 완료") : ("등록 실패: " + (r.reason || "")));
      };
      document.getElementById("photofolder-confirm-auto").onclick = async () => {
        this.setAuto(key, true); close();
        const r = await this._registerEntry(pin, entry, "폴더자동");
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast(r.status === "done" ? ("자동 등록 켬 · " + label + " ← " + entry.name + " 등록 완료") : ("등록 실패: " + (r.reason || "")));
      };
      document.getElementById("photofolder-confirm-skip").onclick = () => close();
      modal.classList.remove("hidden");
    },

    _ensurePickModal() {
      if (document.getElementById("photofolder-pick-modal")) return;
      const modal = document.createElement("div");
      modal.id = "photofolder-pick-modal";
      modal.className = "admin-gate-backdrop hidden";
      modal.setAttribute("style", "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;");
      modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.add("hidden"); });
      const panel = document.createElement("div");
      panel.setAttribute("style", "background:#fff;color:#111;max-width:420px;width:88vw;max-height:70vh;overflow:auto;border-radius:12px;padding:18px;");
      const title = document.createElement("p"); title.id = "photofolder-pick-title"; title.setAttribute("style", "margin:0 0 10px;font-size:14px;color:#111;");
      const list = document.createElement("div"); list.id = "photofolder-pick-list";
      const cancelBtn = document.createElement("button"); cancelBtn.type = "button"; cancelBtn.id = "photofolder-pick-cancel"; cancelBtn.textContent = "취소";
      cancelBtn.setAttribute("style", "margin-top:10px;padding:8px 14px;border-radius:8px;border:1px solid #ccc;background:#f5f5f5;color:#111;cursor:pointer;font-size:14px;");
      panel.appendChild(title); panel.appendChild(list); panel.appendChild(cancelBtn);
      modal.appendChild(panel);
      document.body.appendChild(modal);
      cancelBtn.addEventListener("click", () => modal.classList.add("hidden"));
    },

    _showPickModal(pin, no, candidates) {
      this._ensurePickModal();
      const modal = document.getElementById("photofolder-pick-modal");
      const list = document.getElementById("photofolder-pick-list");
      list.innerHTML = "";
      const label = this._labelFor(pin, no);
      document.getElementById("photofolder-pick-title").textContent = label + " — 일치하는 사진이 여러 개입니다. 선택하세요";
      candidates.forEach((entry) => {
        const b = document.createElement("button"); b.type = "button"; b.textContent = entry.name; b.className = "photofolder-pick-item";
        b.setAttribute("style", "display:block;width:100%;text-align:left;padding:8px 10px;margin-bottom:6px;border-radius:6px;border:1px solid #ccc;background:#f5f5f5;color:#111;cursor:pointer;");
        b.addEventListener("click", async () => {
          modal.classList.add("hidden");
          const r = await this._registerEntry(pin, entry, "폴더선택");
          if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast(r.status === "done" ? (label + " ← " + entry.name + " 등록 완료") : ("등록 실패: " + (r.reason || "")));
        });
        list.appendChild(b);
      });
      modal.classList.remove("hidden");
    },

    /* ══ [핵심 API] 20_App.js 360 핀 생성 훅(시그니처·호출부 불변) ══════════════════════
       @returns {Promise<boolean>} true=이 모듈이 처리함(호출부가 기존 폴백을 하지 않는다),
       false=미처리(호출부가 PhotoBatch.autoConnectPin 등 기존 경로로 폴백해야 한다). */
    async handlePinPlaced(pin) {
      try {
        if (!pin) return false;
        if (typeof Auth !== "undefined" && Auth.readonly) return false;
        // [WO 20261015-numunify] CHECKER 핀 차단 해제 — 결정 = 허용(헤더 주석). 계열 무관하게 번호로 매칭한다.
        if (typeof PinSeries !== "undefined" && PinSeries.mediaOf && PinSeries.mediaOf(pin)) return false; // 이미 사진 있는 핀은 덮어쓰지 않는다
        const key = await this._resolveFolderKeyForPin(pin);
        if (key == null) return false;
        if (!this.isSingleOn(key)) return false; // [WO 20261015] "하나씩 등록" 체크박스 꺼짐 → 기존 폴백
        const e = this._entry(key);
        if (e.mode === "handle" && e.permGranted === false) return false; // 재연결 전엔 자동 매칭 안 함
        const no = this._pinNo(pin);
        if (no == null) return false;
        const page = (typeof State !== "undefined") ? (State.pdfPage || 1) : 1;
        const entries = await this._listEntries(key);
        // [WO 20261016-multisheet P5] 같은 숫자 번호가 둘 이상(A12·B12)일 때만 접두 일치 요구 — 아니면 종전 findMatches 그대로
        const rk = this.rankMatches(no, this._prefixFor(pin), entries, this._peers(page), this._existingNumbers(page));
        const label = this._labelFor(pin, no);
        if (!rk.matches.length && rk.ambiguous.length) { this._showPickModal(pin, no, rk.ambiguous); return true; }
        const candidates = rk.matches;
        if (!candidates.length) {
          if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("폴더에 " + label + " 사진이 없습니다");
          return false;
        }
        if (candidates.length > 1) { this._showPickModal(pin, no, candidates); return true; }
        const entry = candidates[0];
        if (this.isAutoOn(key)) {
          const r = await this._registerEntry(pin, entry, "폴더자동");
          if (typeof Prompt !== "undefined" && Prompt.toast) {
            if (r.status === "done") {
              Prompt.toast(label + " ← " + entry.name + " 자동 등록" + (r.offline ? "(오프라인 저장됨)" : "") + " · [되돌리기]", 4000, { action: { label: "되돌리기", onClick: () => this._undoLast(pin) } });
            } else {
              Prompt.toast("자동 등록 실패: " + (r.reason || ""));
            }
          }
          return true;
        }
        this._showConfirmModal(pin, no, entry, key);
        return true;
      } catch (e) { return false; }
    },

    /* ══ 일괄 등록 — 구역의 "사진 없는 핀 전체" 미리보기 → 확인 → 순차 등록 ══════════════ */

    /** 일괄 등록 대상 — 그 구역(crop) 안, 아직 사진 없는 핀(계열 무관 — WO 20261015-numunify: CHECKER 핀 포함).
     *  🔴 root(deck=null)는 pinsForDeck 규약상 "전체"를 돌려준다(31_Projects.js SoT) — 여러
     *  구역에 걸쳐 중복 처리될 수 있으나 _uploadOneRow 가 이미 사진 있는 핀을 skip 하므로
     *  안전하다(§보고: 완벽한 구역 격리는 아님, 데이터 훼손은 없음). */
    _batchTargets(deck) {
      const pins = (typeof State !== "undefined" && State.pins) || [];
      const page = (typeof State !== "undefined") ? (State.pdfPage || 1) : 1;
      const scoped = (typeof Projects !== "undefined" && Projects.pinsForDeck) ? Projects.pinsForDeck(pins, deck) : pins;
      // [WO 20261016-multisheet P4] 연결 멤버 → 대표(사진은 대표에만) · 논리 핀 1개 = 대상 1개. 연결 없는 핀은 자기 자신(종전).
      const PL = (typeof PinLink !== "undefined" && PinLink.headOf) ? PinLink : null;
      const onPage = (scoped || []).filter((p) => p && !p._deleted && (p.page || 1) === page);
      const heads = PL ? PL.dedupe(onPage.map((p) => PL.headOf(pins, p))) : onPage;
      return heads.filter((p) => p && !p._deleted
        && !(typeof PinSeries !== "undefined" && PinSeries.mediaOf && PinSeries.mediaOf(p)));
    },

    /** 미리보기 행 계산(순수 비동기, DOM 없음 — 테스트가 직접 호출 가능).
     *  @returns {Promise<Array<{pin,no,key,candidates,status}>>} status: "일치"|"다중/확인필요"|"없음"|"번호없음" */
    async previewBatch(folderKey, deck) {
      await this._restoreKey(folderKey);
      const entries = await this._listEntries(folderKey);
      const targets = this._batchTargets(deck);
      const page = (typeof State !== "undefined") ? (State.pdfPage || 1) : 1;
      // [WO 20261016-multisheet] 핀 자신의 페이지 번호(연결 대표는 다른 시트일 수 있다) — 연결 OFF 면 전부 지금 페이지(종전)
      const byPage = new Map();
      const numOf = (pin) => {
        const pg = (pin && pin.page) || page;
        if (!byPage.has(pg)) byPage.set(pg, (typeof PinSeries !== "undefined" && PinSeries.numbers) ? PinSeries.numbers((typeof State !== "undefined" ? State.pins : []), pg) : new Map());
        return byPage.get(pg).get(pin.id);
      };
      const existing = this._existingNumbers(page);
      const peers = this._peers(page);
      return targets.map((pin) => {
        const info = numOf(pin);
        const no = info ? info.no : null;
        if (no == null) return { pin: pin, no: null, key: null, candidates: [], status: "번호없음" };
        const mk = this._matchKey(no);
        const rk = this.rankMatches(no, (info && info.prefix) || "", entries, peers, existing);   // [P5] 충돌 시에만 접두 요구
        const candidates = rk.matches.length ? rk.matches : rk.ambiguous;
        let status;
        if (!rk.matches.length && rk.ambiguous.length) status = "다중/확인필요";
        else if (!candidates.length) status = "없음";
        else if (candidates.length > 1) status = "다중/확인필요";
        else status = "일치";
        return { pin: pin, no: no, key: mk, candidates: candidates, status: status };
      });
    },

    /** 미리보기에서 "일치" 상태인 행만 순차 등록(동시성 없음 — 진행률 표시 목적).
     *  이미 사진 있는 핀은 _uploadOneRow 내부 가드로 덮어쓰지 않는다. */
    async runBatchConfirmed(rows, onProgress) {
      const applicable = (rows || []).filter((r) => r.status === "일치");
      let done = 0, skip = 0, fail = 0;
      for (const r of applicable) {
        const result = await this._registerEntry(r.pin, r.candidates[0], "폴더일괄");
        if (result.status === "done") done++; else if (result.status === "skip") skip++; else fail++;
        if (onProgress) { try { onProgress({ done: done, skip: skip, fail: fail, total: applicable.length }); } catch (e) {} }
      }
      return { done: done, skip: skip, fail: fail, total: applicable.length, excluded: (rows || []).length - applicable.length };
    },

    /* ══ 구역별 폴더 관리 화면(JS 생성 모달) ══════════════════════════════════════════ */

    _deckManagerTargets() {
      const decks = (typeof Projects !== "undefined" && Array.isArray(Projects.decks)) ? Projects.decks : [];
      return [{ key: "__root__", name: "원본(프로젝트 기본값)", deck: null }]
        .concat(decks.map((d) => ({ key: this._deckKey(d), name: (d && d.name) || "(이름없음)", deck: d })));
    },

    _ensureDeckManagerModal() {
      if (document.getElementById("photofolder-deckmgr-modal")) return;
      const modal = document.createElement("div");
      modal.id = "photofolder-deckmgr-modal";
      modal.className = "admin-gate-backdrop hidden";
      modal.setAttribute("style", "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;");
      modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.add("hidden"); });
      const panel = document.createElement("div");
      panel.setAttribute("style", "background:#fff;color:#111;max-width:640px;width:92vw;max-height:80vh;overflow:auto;border-radius:12px;padding:18px;");
      const title = document.createElement("h3"); title.textContent = "구역별 사진 폴더 지정"; title.setAttribute("style", "margin:0 0 6px;font-size:16px;color:#111;");
      const help = document.createElement("p"); help.setAttribute("style", "margin:0 0 12px;font-size:12px;color:#444;");
      help.textContent = "핀 번호는 3자리(001~999)로 인식해 파일명 끝 숫자와 맞춥니다. 1000번 이상·THETA 기본 파일명(R0010123.JPG 등)은 끝 3자리만 봐 다른 번호와 겹칠 수 있어 선택창으로 확인합니다.";
      const list = document.createElement("div"); list.id = "photofolder-deckmgr-list";
      const closeBtn = document.createElement("button"); closeBtn.type = "button"; closeBtn.textContent = "닫기";
      closeBtn.setAttribute("style", "margin-top:12px;padding:8px 14px;border-radius:8px;border:1px solid #ccc;background:#f5f5f5;color:#111;cursor:pointer;font-size:14px;");
      closeBtn.addEventListener("click", () => modal.classList.add("hidden"));
      panel.appendChild(title); panel.appendChild(help); panel.appendChild(list); panel.appendChild(closeBtn);
      modal.appendChild(panel);
      document.body.appendChild(modal);
    },

    openDeckManager() {
      this._ensureDeckManagerModal();
      const modal = document.getElementById("photofolder-deckmgr-modal");
      this._renderDeckManagerRows();
      modal.classList.remove("hidden");
    },

    _renderDeckManagerRows() {
      const list = document.getElementById("photofolder-deckmgr-list");
      if (!list) return;
      list.innerHTML = "";
      this._deckManagerTargets().forEach((t) => {
        const row = document.createElement("div");
        row.setAttribute("style", "border:1px solid #ddd;border-radius:8px;padding:10px;margin-bottom:8px;");
        row.dataset.key = t.key;
        list.appendChild(row);
        (async () => { await this._restoreKey(t.key); this._fillDeckManagerRow(row, t); })();
      });
    },

    _fillDeckManagerRow(row, t) {
      const key = t.key;
      const e = this._entry(key);
      const label = this.hasFolder(key) ? (e.folderLabel + (Number.isFinite(e.fileCount) ? (" (" + e.fileCount + "장)") : "")) : "지정 안됨";
      row.innerHTML = '<div style="font-weight:600;margin-bottom:4px;color:#111;">' + this._esc(t.name) + '</div>'
        + '<div style="font-size:12px;color:#444;margin-bottom:6px;">폴더: ' + this._esc(label) + '</div>'
        + '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">'
          + '<button type="button" class="pfdm-pick" style="padding:4px 8px;border-radius:6px;border:1px solid #666;background:#2f6db5;color:#fff;cursor:pointer;font-size:12px;">📁 폴더 지정</button>'
          + '<label style="display:flex;align-items:center;gap:4px;font-size:12px;color:#111;"><input type="checkbox" class="pfdm-batch"' + (this.isBatchOn(key) ? " checked" : "") + '/> 일괄 등록</label>'
          + '<label style="display:flex;align-items:center;gap:4px;font-size:12px;color:#111;"><input type="checkbox" class="pfdm-single"' + (this.isSingleOn(key) ? " checked" : "") + '/> 하나씩 등록</label>'
          + '<button type="button" class="pfdm-run" style="padding:4px 8px;border-radius:6px;border:1px solid #666;background:#1a7f37;color:#fff;cursor:pointer;font-size:12px;"' + ((this.isBatchOn(key) && this.hasFolder(key)) ? "" : " disabled") + '>지금 일괄 등록</button>'
        + '</div>';
      row.querySelector(".pfdm-pick").addEventListener("click", async () => {
        const result = await this.pickFolder(key);
        if (result === null) { this._afterPick = () => this._fillDeckManagerRow(row, t); return; }
        this._fillDeckManagerRow(row, t);
      });
      row.querySelector(".pfdm-batch").addEventListener("change", (ev) => { this.setBatchOn(key, ev.target.checked); this._fillDeckManagerRow(row, t); });
      row.querySelector(".pfdm-single").addEventListener("change", (ev) => { this.setSingleOn(key, ev.target.checked); });
      const runBtn = row.querySelector(".pfdm-run");
      if (runBtn) runBtn.addEventListener("click", () => this._openBatchPreview(key, t));
    },

    _ensureBatchPreviewModal() {
      if (document.getElementById("photofolder-batchprev-modal")) return;
      const modal = document.createElement("div");
      modal.id = "photofolder-batchprev-modal";
      modal.className = "admin-gate-backdrop hidden";
      modal.setAttribute("style", "position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;");
      const panel = document.createElement("div");
      panel.setAttribute("style", "background:#fff;color:#111;max-width:560px;width:92vw;max-height:80vh;overflow:auto;border-radius:12px;padding:18px;");
      const title = document.createElement("h3"); title.id = "photofolder-batchprev-title"; title.setAttribute("style", "margin:0 0 10px;font-size:15px;color:#111;");
      const rowsEl = document.createElement("div"); rowsEl.id = "photofolder-batchprev-rows"; rowsEl.setAttribute("style", "font-size:12px;max-height:50vh;overflow:auto;border:1px solid #eee;border-radius:6px;");
      const prog = document.createElement("div"); prog.id = "photofolder-batchprev-progress"; prog.setAttribute("style", "font-size:12px;color:#444;margin-top:8px;");
      const btnBar = document.createElement("div"); btnBar.setAttribute("style", "display:flex;gap:8px;margin-top:12px;");
      const confirmBtn = document.createElement("button"); confirmBtn.type = "button"; confirmBtn.id = "photofolder-batchprev-confirm"; confirmBtn.textContent = "확인하고 일괄 등록";
      confirmBtn.setAttribute("style", "padding:8px 14px;border-radius:8px;border:1px solid #1d4f88;background:#2f6db5;color:#fff;cursor:pointer;font-size:14px;");
      const cancelBtn = document.createElement("button"); cancelBtn.type = "button"; cancelBtn.id = "photofolder-batchprev-cancel"; cancelBtn.textContent = "취소";
      cancelBtn.setAttribute("style", "padding:8px 14px;border-radius:8px;border:1px solid #ccc;background:#f5f5f5;color:#111;cursor:pointer;font-size:14px;");
      cancelBtn.addEventListener("click", () => modal.classList.add("hidden"));
      btnBar.appendChild(confirmBtn); btnBar.appendChild(cancelBtn);
      panel.appendChild(title); panel.appendChild(rowsEl); panel.appendChild(prog); panel.appendChild(btnBar);
      modal.appendChild(panel);
      document.body.appendChild(modal);
    },

    async _openBatchPreview(key, t) {
      this._ensureBatchPreviewModal();
      const modal = document.getElementById("photofolder-batchprev-modal");
      const rows = await this.previewBatch(key, t.deck);
      this._lastBatchRows = rows;
      document.getElementById("photofolder-batchprev-title").textContent = t.name + " — 일괄 등록 미리보기(" + rows.length + "건 대상)";
      const body = document.getElementById("photofolder-batchprev-rows");
      if (!rows.length) {
        body.innerHTML = '<div style="padding:10px;color:#444;">사진 없는 핀이 없습니다</div>';
      } else {
        body.innerHTML = rows.map((r) => {
          const fname = r.candidates.length === 1 ? r.candidates[0].name : (r.candidates.length > 1 ? r.candidates.map((c) => c.name).join(", ") : "-");
          const color = r.status === "일치" ? "#1a7f37" : (r.status === "없음" ? "#767676" : "#9a4a00");
          return '<div style="display:flex;justify-content:space-between;gap:8px;padding:6px 8px;border-bottom:1px solid #eee;color:#111;">'
            + '<span>핀 ' + this._esc(r.no == null ? "?" : r.no) + (r.key ? ' (인식 ' + r.key + ')' : '') + '</span>'
            + '<span style="flex:1;text-align:left;margin-left:8px;color:#333;">' + this._esc(fname) + '</span>'
            + '<span style="font-weight:600;color:' + color + ';">' + r.status + '</span>'
            + '</div>';
        }).join("");
      }
      document.getElementById("photofolder-batchprev-progress").textContent = "";
      const confirmBtn = document.getElementById("photofolder-batchprev-confirm");
      const applicableCount = rows.filter((r) => r.status === "일치").length;
      confirmBtn.disabled = applicableCount === 0;
      confirmBtn.onclick = async () => {
        confirmBtn.disabled = true;
        const summary = await this.runBatchConfirmed(rows, (p) => {
          const el = document.getElementById("photofolder-batchprev-progress");
          if (el) el.textContent = "진행 " + p.done + "/" + p.total + " (건너뜀 " + p.skip + " · 실패 " + p.fail + ")";
        });
        modal.classList.add("hidden");
        try { UI.renderPinList(); UI.renderPinsOnMap(); if (typeof PinGrid !== "undefined") PinGrid.render(); } catch (e) {}
        try { if (typeof PhotoBatch !== "undefined" && PhotoBatch._markUnsaved) PhotoBatch._markUnsaved(); } catch (e) {}
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("일괄 등록 완료 " + summary.done + "건 · 제외 " + summary.excluded + "건" + (summary.fail ? (" · 실패 " + summary.fail) : ""));
      };
      modal.classList.remove("hidden");
    }
  };
