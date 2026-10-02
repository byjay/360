  /** 사진 URL 로 허용하는 확장자(이미지·영상) — pap-photo-url 검증의 유일한 기준(SoT). */
  const PAP_URL_RE = /^https?:\/\/.+\.(jpe?g|png|gif|webp|bmp|mp4|webm|mov)(\?.*)?$/i;
  const PAP_VIDEO_RE = /\.(mp4|webm|mov)(\?.*)?$/i;

  /** [WO 20260921] 🔴 등록 종류(B#pf-tools 흡수) — SoT. 라벨/순서가 여기 하나뿐이면
   *  중복 배치가 물리적으로 불가능하다(렌더 지점이 한 곳: _renderRegTools). */
  const PAP_REG_CATS = [
    { id: "photo", label: "사진" },
    { id: "theta", label: "360" },
    { id: "doc",   label: "문서" },
    { id: "note",  label: "노트" },
    { id: "video", label: "동영상" },
    { id: "url",   label: "URL" }
  ];
  /** 모바일 기준(720px) — style.css 전역과 동일 값(2720/2769 등). CSS 는 타 팀 점유라
   *  JS 로 직접 판정한다(인라인 스타일 방식은 이 파일 상단 주석과 동일 이유). */
  const PAP_MOBILE_MQ = "(max-width: 720px)";

  const PinActionPop = {
    _pinId: null,
    _layoutDone: false,

    /** [마스터 2026-09-17] 패널 = 화면 오른쪽 고정, 상(정보)/하(사진) 2분할.
     *  style.css 는 타 에이전트 점유 중이라 신규 클래스를 만들지 않고 인라인 스타일로 배치한다.
     *  ISO 전환 코드는 여기 없다(핀 클릭 시 ISO 를 켜지 않는다 — 마스터 명시). */
    _applyLayoutOnce() {
      if (this._layoutDone) return;
      this._layoutDone = true;
      const pop = document.getElementById("pin-action-pop");
      const card = document.getElementById("pap-card");
      if (pop) { pop.style.display = "flex"; pop.style.alignItems = "stretch"; pop.style.justifyContent = "flex-end"; }
      if (card) {
        card.style.cssText += "width:380px;max-width:92vw;height:100vh;max-height:100vh;" +
          "border-radius:0;display:flex;flex-direction:column;margin:0;";
      }
    },

    init() {
      const $ = (id) => document.getElementById(id);
      const el = $("pin-action-pop");
      if (!el) return;
      this._applyLayoutOnce();
      $("pap-close") && $("pap-close").addEventListener("click", () => this.close());
      const bd = el.querySelector(".pin-action-backdrop");
      bd && bd.addEventListener("click", () => this.close());
      $("pap-view") && $("pap-view").addEventListener("click", () => {
        const pin = this._pin(); if (!pin) return;
        this.close();
        if (App.pinHasContent(pin)) App.openPano(pin);
        else { App.focusPin(pin, false); if (typeof Inspector !== "undefined") Inspector.showPin(pin); }
      });
      $("pap-move") && $("pap-move").addEventListener("click", () => {
        const pin = this._pin(); if (!pin) return;
        State.pinEditUnlocked = pin.id;
        this.close();
        UI.renderPinsOnMap();
        const m = document.querySelector('.pin-marker[data-id="' + pin.id + '"]');
        if (m) m.classList.add("edit-unlocked");
        Prompt.toast && Prompt.toast("'" + (pin.label || ("#" + (pin.page||1))) + "' 이동 잠금 해제 — 도면에서 핀을 드래그하세요");
      });
      // [WO 20260929] 🔴 "수정 / 사진 추가" 버튼 제거(중복 정리) — 하던 일(라벨 입력 포커스 안내)은
      //   등록 탭이 대신하므로 기능 유실 없음(라벨 입력은 항상 보임 → 바로 클릭 가능).
      $("pap-del") && $("pap-del").addEventListener("click", async () => {
        const pin = this._pin(); if (!pin) return;
        if (await App.deletePin(pin.id)) this.close();
      });
      // ── 등록정보(위치명) / 번호 수정 — 저장은 명시 버튼(자동저장 OFF, 미저장 표시만) ──
      $("pap-label-save") && $("pap-label-save").addEventListener("click", () => this._saveLabel());
      // ── 사진 미리보기 클릭 → 전체화면(기존 파노 뷰어 경로 재사용) ──
      $("pap-photo-img") && $("pap-photo-img").addEventListener("click", () => {
        const pin = this._pin(); if (!pin) return;
        this.close();
        App.openPano(pin);
      });
      // ── 사진 등록: 파일 선택 ──
      $("pap-photo-file") && $("pap-photo-file").addEventListener("change", (e) => {
        const file = e.target.files && e.target.files[0];
        this._registerPhotoFile(file);
      });
      // ── 사진 등록: 경로(URL) 직접 입력 — 검증 없이 저장 금지 ──
      $("pap-photo-url-add") && $("pap-photo-url-add").addEventListener("click", () => this._registerPhotoUrl());
      // ── 노트(이슈) 등록 — 13_Notes.js 재사용(같은 /api/notes) ──
      $("pap-notes-submit") && $("pap-notes-submit").addEventListener("click", () => this._submitNote());
      // ── [WO 20260921] 등록 종류 선택(위임 바인딩, 중복 방지) ──
      const regGrid = $("pap-reg-tools");
      if (regGrid && !regGrid._papBound) {
        regGrid.addEventListener("click", (e) => {
          const btn = e.target.closest(".pap-reg-btn");
          if (!btn || btn.classList.contains("hidden")) return;
          this._selectRegCategory(btn.dataset.reg);
        });
        regGrid._papBound = true;
      }
      // ── 문서 등록: 파일 선택(다중) ──
      $("pap-doc-file") && $("pap-doc-file").addEventListener("change", (e) => {
        const files = Array.from(e.target.files || []);
        e.target.value = "";
        files.forEach((f) => this._registerDocFile(f));
      });
      // 화면 폭이 바뀌어도(모바일↔데스크톱 회전 등) 등록 종류 노출 상태를 다시 계산한다.
      if (typeof window !== "undefined" && window.addEventListener) {
        window.addEventListener("resize", () => { if (!el.classList.contains("hidden")) this._applyRegVisibility(); });
      }
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && !el.classList.contains("hidden")) this.close();
      });
    },

    /** [WO 20260921] 등록 종류 그리드 렌더 — 렌더 지점이 여기 하나뿐(중복 배치 물리적으로 불가). */
    _renderRegTools() {
      const grid = document.getElementById("pap-reg-tools");
      if (!grid) return;
      const cur = this._regCat || "photo";
      grid.innerHTML = PAP_REG_CATS.map((c) => {
        const active = c.id === cur;
        const style = "padding:6px 10px;border-radius:8px;font-size:12px;cursor:pointer;border:1px solid " +
          (active ? "#0f172a;background:#0f172a;color:#fff;" : "rgba(0,0,0,.14);background:#f8fafc;color:#334155;");
        return `<button type="button" class="pap-reg-btn" data-reg="${c.id}" aria-pressed="${active}" style="${style}">${c.label}</button>`;
      }).join("");
      this._applyRegVisibility();
      this._selectRegCategory(cur); // 버튼 active 색상 + 문서박스 표시/숨김 상태를 한 곳(SoT)에서 동기화
    },

    /** querySelectorAll 미지원 환경(테스트 fake DOM 등)에서도 안전하게 빈 배열을 준다. */
    _regBtns(grid) {
      return (grid && typeof grid.querySelectorAll === "function") ? Array.from(grid.querySelectorAll(".pap-reg-btn")) : [];
    },

    /** 모바일(≤720px)에서는 '사진'·'360'·'노트'만 노출 — 마스터 기존 지시(B#pf-tools 규칙) +
     *  [WO 20260929] 노트를 이 탭으로 통합하며 기능 유실 방지(모바일도 노트는 계속 쓸 수 있어야 함) +
     *  [WO 20260929-2] 🔴 THETA 360 현장 등록이 휴대폰 핵심 동선이라 '360'도 노출(마스터 재지시:
     *  "휴대폰에서도 360 사진 등록되게"). 문서·동영상·URL 은 계속 숨김(근거: 데스크톱 전용 파일 규모/입력). */
    _applyRegVisibility() {
      const grid = document.getElementById("pap-reg-tools");
      if (!grid) return;
      const mobile = this._isMobile();
      this._regBtns(grid).forEach((btn) => {
        const reg = btn.dataset.reg;
        btn.classList.toggle("hidden", mobile && reg !== "photo" && reg !== "theta" && reg !== "note");
      });
      this._updateRegHint();
    },

    _isMobile() { return !!(window.matchMedia && window.matchMedia(PAP_MOBILE_MQ).matches); },

    /** [지휘자 발주 2026-09-29 항목1] 🔴 등록 종류별 안내 — 예전엔 '360' 선택 시 Prompt.toast 로
     *  안내했는데, 모바일 좁은 화면에서 그 토스트가 등록 UI(파일선택/경로입력) 위를 덮어 조작이
     *  막혔다(지휘자 실측). 토스트 대신 이 탭 안 인라인 한 줄(기존 모바일 전용 안내 요소 재사용)로
     *  바꿔 등록 UI를 절대 가리지 않게 한다. 우선순위: 카테고리 전용 안내(360/동영상) > 모바일
     *  일반 안내 > 없음(빈 문자열이면 숨김 — 조용한 빈 줄 대신 요소 자체를 감춘다). */
    _updateRegHint() {
      const hint = document.getElementById("pap-reg-mobile-hint");
      if (!hint) return;
      const cat = this._regCat;
      let text = "";
      if (cat === "theta") text = "RICOH THETA 360 사진도 '사진'과 동일하게 등록됩니다(파일 선택 또는 경로).";
      else if (cat === "video") text = "동영상은 경로(URL, .mp4/.webm/.mov)로 등록하세요.";
      else if (this._isMobile()) text = "모바일에서는 360·사진·노트만 등록할 수 있어요. 문서·동영상·URL은 PC에서 추가하세요.";
      hint.textContent = text;
      hint.classList.toggle("hidden", !text);
    },

    /** 등록 종류 선택 — 사진/360/동영상/URL 은 기존 단일 위젯(pap-photo-area) 재사용(중복 위젯 생성 금지),
     *  문서·노트는 각각 전용 패널을 이 탭 안에서 보이고 나머지는 숨긴다(중복 노출 0). */
    _selectRegCategory(cat) {
      this._regCat = cat;
      const grid = document.getElementById("pap-reg-tools");
      this._regBtns(grid).forEach((b) => {
        const active = b.dataset.reg === cat;
        b.setAttribute("aria-pressed", String(active));
        b.style.background = active ? "#0f172a" : "#f8fafc";
        b.style.color = active ? "#fff" : "#334155";
        b.style.borderColor = active ? "#0f172a" : "rgba(0,0,0,.14)";
      });
      const $ = (id) => document.getElementById(id);
      const title = $("pap-reg-title");
      const photoArea = $("pap-photo-area");
      const docBox = $("pap-doc-register");
      const notesPanel = $("pap-notes-panel");
      const isDoc = cat === "doc", isNote = cat === "note";
      if (photoArea) photoArea.classList.toggle("hidden", isDoc || isNote);
      if (docBox) docBox.classList.toggle("hidden", !isDoc);
      if (notesPanel) notesPanel.classList.toggle("hidden", !isNote);
      const found = PAP_REG_CATS.find((c) => c.id === cat);
      if (title) title.textContent = found ? found.label : "사진";
      const bottom = $("pap-bottom"); if (bottom) bottom.scrollTop = 0;
      if (isNote) {
        const noteInput = $("pap-notes-input"); if (noteInput) noteInput.focus();
        return;
      }
      // [지휘자 발주 2026-09-29 항목1] 🔴 토스트가 등록 UI를 덮던 문제 — 인라인 안내로 대체(_updateRegHint).
      this._updateRegHint();
      if (cat === "url" || cat === "video") { const u = $("pap-photo-url"); if (u) u.focus(); }
    },
    _pin() { return (State.pins || []).find(p => p.id === this._pinId) || null; },

    /** 편집 권한(번호 수정·사진 등록·노트 작성) = 디자이너만. 뷰어는 보기 전용. */
    _canEdit() {
      if (typeof Auth !== "undefined" && Auth && typeof Auth.isDesigner !== "undefined") return !!Auth.isDesigner;
      return (typeof State !== "undefined" && State.mode === "designer");
    },

    open(pinId) {
      const el = document.getElementById("pin-action-pop");
      if (!el) return;
      const pin = (State.pins || []).find(p => p.id === pinId);
      if (!pin) return;
      this._pinId = pinId;
      this._applyLayoutOnce();
      // [WO 20260929-tree1] 🔴 번호 SoT = PinSeries.numbers/formatNo(01b_PinSeries.js) — 도면
      //   마커·미니맵·트리와 같은 번호(CHECKER=숫자 / 360=P접두)를 쓴다. 예전엔 여기서만
      //   samePage.indexOf 로 독자 채번해(계열 무시) 트리·마커와 다른 번호가 나왔다(§10 SoT).
      const page = pin.page || 1;
      const numMap = (typeof PinSeries !== "undefined" && PinSeries.numbers) ? PinSeries.numbers(State.pins, page) : new Map();
      const meta = numMap.get(pin.id) || null;
      const no = meta ? meta.no : 0;
      const noLabel = meta ? PinSeries.formatNo(meta.no, meta.series) : "?";
      const hasContent = App.pinHasContent(pin);
      const $ = (id) => document.getElementById(id);
      $("pap-no").textContent = "#" + noLabel;
      $("pap-title").textContent = this._titleFor(pin, noLabel);
      const mediaTxt = hasContent ? "360° 미디어 있음" : "미디어 없음";
      const addrTxt = (pin.label && pin.label.trim()) ? pin.label : "위치명 없음";
      // 🔴 [2026-09-21 WO] 도면 마커 위성 배지 3종(이슈·중복·작성자) 제거 — 여기(단일 편집창)로 이관.
      //   정본은 그대로 재사용(Notes.openCountFor / PinSeries.duplicateCheckboardIds / PinSeries.userMark) —
      //   숫자를 여기서 다시 세지 않는다(§10 SoT).
      const esc = (typeof UI !== "undefined" && UI.escapeHtml) ? UI.escapeHtml : (s) => String(s);
      let metaHtml = esc(addrTxt) + " · " + mediaTxt + " · " + page + "페이지";
      const openIssues = (typeof Notes !== "undefined" && Notes.openCountFor) ? Notes.openCountFor(pin.id) : 0;
      if (openIssues > 0) {
        metaHtml += ` <span class="pin-issue-badge" title="미해결 이슈 ${openIssues}건">${openIssues}</span>`;
      }
      const isDup = (typeof PinSeries !== "undefined" && PinSeries.duplicateCheckboardIds)
        ? PinSeries.duplicateCheckboardIds(State.pins, page).has(pin.id) : false;
      if (isDup) {
        metaHtml += ' <span class="pin-dup-badge" title="번호 중복 — 현장 확인 후 직접 수정하세요">중복</span>';
      }
      const userMark = (typeof PinSeries !== "undefined" && PinSeries.userMark) ? PinSeries.userMark(pin, no) : null;
      if (userMark) {
        const bandTxt = userMark.band != null
          ? ("번호 대역 " + (userMark.band * 100 + 1) + "~" + (userMark.band * 100 + 100))
          : ("작성자: " + esc(userMark.author || ""));
        metaHtml += ` <span style="color:${userMark.color};font-weight:700">● ${esc(bandTxt)}</span>`;
      }
      // [WO 20261001-gps] 좌표 + 지도 링크(탭 시에만 외부로 이동 — 데이터 전송 없음, 판정기준 §4).
      if (typeof GPS !== "undefined" && pin.gps) {
        const gpsTxt = GPS.displayText(pin.gps);
        if (gpsTxt) {
          const warn = GPS.accWarning(pin.gps);
          const mapHref = GPS.mapUrl(pin.gps);
          const warnHtml = warn ? ` <span class="pin-dup-badge" title="GPS 정확도 낮음">${esc(warn)}</span>` : "";
          metaHtml += mapHref
            ? ` · <a href="${esc(mapHref)}" target="_blank" rel="noopener" title="지도에서 보기">${esc(gpsTxt)}</a>${warnHtml}`
            : ` · ${esc(gpsTxt)}${warnHtml}`;
        }
      }
      $("pap-meta").innerHTML = metaHtml;
      // 360° 보기 버튼은 미디어 있을 때 강조
      const viewBtn = $("pap-view");
      if (viewBtn) viewBtn.classList.toggle("dim", !hasContent);

      const canEdit = this._canEdit();

      // ── 등록정보/번호(위치명) — 뷰어는 읽기전용 ──
      const labelInput = $("pap-label-input");
      if (labelInput) {
        labelInput.value = pin.label || "";
        labelInput.readOnly = !canEdit;
      }
      const labelSaveBtn = $("pap-label-save");
      if (labelSaveBtn) labelSaveBtn.classList.toggle("hidden", !canEdit);
      const labelHint = $("pap-label-hint");
      if (labelHint) labelHint.textContent = "";

      // [WO 20260930-moderole] 🔴 마스터: "체커는 번호만 매기는 기능" / "체커는 사진을 등록하지
      //   않을 거야" — CHECKER 계열 핀(SoT: PinSeries.seriesOf)은 등록 섹션(#pap-bottom: 등록
      //   종류 그리드 + 사진/문서/노트 패널) 전체를 숨긴다. 번호·위치명 수정·이동·삭제(#pap-top)는
      //   그대로 남는다. 기존에 이미 사진이 붙어 있던 CHECKER 핀도 데이터는 그대로 두고(유실 0),
      //   #pap-view(이미 있는 읽기 버튼)로만 본다 — 새 등록 경로는 열지 않는다.
      const isChecker = (typeof PinSeries !== "undefined" && PinSeries.seriesOf) ? PinSeries.seriesOf(pin) === "checkboard" : false;
      const bottom = $("pap-bottom");
      if (bottom) bottom.classList.toggle("hidden", isChecker);
      if (!isChecker) {
        this._renderPhoto(pin, canEdit);
        this._loadNotes(pin, canEdit);
        // [WO 20260921] 등록 종류 그리드 — 열 때마다 '사진'으로 초기화(이전 핀의 선택 상태 유지 금지)
        this._regCat = "photo";
        this._renderRegTools();
        this._renderDocList(pin);
      }

      // [지휘자 발주 2026-09-29 항목2] 🔴 좌하단 도움말(?) 토글(36_Help.js, position:fixed
      // left:16/bottom:16)이 이 패널(모바일 92vw, 화면 오른쪽 정렬)의 왼쪽 가장자리와
      // 겹쳐 등록 버튼을 가렸다(지휘자 실측). 패널이 열려 있는 동안만 숨긴다(d59726b 와 동일
      // 관례 — 편집 화면에서 겹치는 상시 플로팅 버튼은 그 화면이 떠 있는 동안 숨김).
      if (typeof Help !== "undefined" && Help.setVisible) Help.setVisible(false);
      el.classList.remove("hidden");
    },
    close() {
      const el = document.getElementById("pin-action-pop");
      if (el) el.classList.add("hidden");
      this._pinId = null;
      if (typeof Help !== "undefined" && Help.setVisible) Help.setVisible(true);
    },
    /** [지휘자 발주 2026-09-29 항목4] 제목 = 위치명. 번호(pap-no 배지)와 같은 문자열이면
     *  중복 표시("#2  2")가 되므로 제목을 비운다(배지가 이미 번호를 보여주므로 정보 유실 없음).
     *  형제 호출부(open()/_saveLabel()) 모두 이 한 곳만 쓴다(§10 SoT). */
    _titleFor(pin, noLabel) {
      const raw = (pin && pin.label && pin.label.trim()) ? pin.label.trim() : "";
      if (!raw) return "포인트 " + noLabel;
      if (raw === noLabel) return "";
      return raw;
    },

    /** ── 등록정보/번호 저장 — 자동저장 OFF: pin.label 만 갱신하고 미저장 표시만 남긴다 ──
     *  [WO 20260918] 🔴 체크보드 핀은 label 이 곧 번호(유일해야 함) — 이미 쓰는 번호로
     *  바꾸려 하면 조용히 삼키지 않고 거부한다(01b_PinSeries.js validateCheckboardLabel 정본).
     *  콘텐츠/빈 핀은 label 이 자유 텍스트라 이 검증을 적용하지 않는다(기존 동작 불변). */
    _saveLabel() {
      const pin = this._pin(); if (!pin) return;
      if (!this._canEdit()) return;
      const $ = (id) => document.getElementById(id);
      const v = ($("pap-label-input") && $("pap-label-input").value || "").trim();
      if (pin.checkboard && typeof PinSeries !== "undefined" && PinSeries.validateCheckboardLabel) {
        const check = PinSeries.validateCheckboardLabel(State.pins, pin.page || 1, pin.id, v);
        if (!check.ok) {
          const hintEl = $("pap-label-hint");
          if (hintEl) hintEl.textContent = check.reason;
          Prompt.toast && Prompt.toast(check.reason);
          return; // 저장하지 않는다 — 조용한 실패 금지(이유를 보여주고 중단)
        }
      }
      if (pin.checkboard && String(pin.label) !== v) pin.labelManual = true; // [WO 20260930-numdup] 직접 고친 번호 — 동시 생성 재채번 제외
      pin.label = v;
      if (typeof App !== "undefined" && App._markDirty) App._markDirty();
      if (!navigator.onLine && typeof OpLog !== "undefined" && OpLog.recordCurrent) { try { OpLog.recordCurrent("pin", "upsert", pin.id, pin); } catch (e) {} }
      if (typeof UI !== "undefined") { UI.renderPinsOnMap && UI.renderPinsOnMap(); UI.renderPinList && UI.renderPinList(); }
      // 화면 갱신(번호/제목/메타 재계산) — 페이지 재조회 없이 open()의 표시 로직만 재사용
      // [WO 20260929-tree1] 🔴 형제 호출부(§G-2-5) — open() 과 같은 SoT(PinSeries.numbers/formatNo)로 통일.
      const page = pin.page || 1;
      const numMap2 = (typeof PinSeries !== "undefined" && PinSeries.numbers) ? PinSeries.numbers(State.pins, page) : new Map();
      const meta2 = numMap2.get(pin.id) || null;
      const noLabel2 = meta2 ? PinSeries.formatNo(meta2.no, meta2.series) : "?";
      $("pap-title").textContent = this._titleFor(pin, noLabel2);
      const hint = $("pap-label-hint");
      if (hint) hint.textContent = "미저장 변경 — '저장하기'(포인트 편집 패널) 또는 자동저장 이벤트 발생 시 서버에 반영됩니다.";
      Prompt.toast && Prompt.toast("위치명/번호 반영됨 (미저장)");
    },

    /** ── 사진 섹션: 있으면 미리보기 + (편집가능이면) 추가등록 칸도 계속 노출, 없으면 등록 UI만.
     *  [WO 20260929-2] 🔴 "사진이 이미 있어도 추가 가능" — 모바일 360/사진 재등록 동선을 위해
     *  registerBox 를 hasPhoto 로 숨기지 않는다(canEdit 로만 결정). 뷰어(canEdit=false)는 계속 숨김. */
    _renderPhoto(pin, canEdit) {
      const $ = (id) => document.getElementById(id);
      const previewBox = $("pap-photo-preview");
      const registerBox = $("pap-photo-register");
      const img = $("pap-photo-img");
      const hasPhoto = (typeof App !== "undefined" && App.pinHasMedia) ? App.pinHasMedia(pin) : !!(pin && (pin.imageId || pin.imageUrl || pin.videoUrl || pin.pendingOpId || pin.localPreview));
      if (previewBox) previewBox.classList.toggle("hidden", !hasPhoto);
      if (hasPhoto) this._resolvePhotoSrc(pin).then((src) => { if (img && src) img.src = src; });
      // [지휘자 발주 보강 2026-09-29 §4-2] "영역/구역 · 시각 · 원본파일명" 한 줄 — index.html 수정
      // 금지(다른 팀 점유)라 JS 로 요소를 만들어 붙인다(기존 "index.html 수정 금지" 관례 그대로,
      // p87 등 최소 가짜DOM 에 appendChild 가 없을 수 있어 기능감지로 방어).
      if (hasPhoto && typeof PhotoNaming !== "undefined" && previewBox && typeof previewBox.appendChild === "function") {
        let metaEl = document.getElementById("pap-photo-meta");
        if (!metaEl) {
          metaEl = document.createElement("div");
          metaEl.id = "pap-photo-meta";
          // [p100 정정, 2026-09-30] #94a3b8 는 흰 카드 위 2.56:1(AA 미달, 헤드리스 Chrome 실측) —
          // slate-500 #64748b 로 교체(공유 함수·형제 호출부 색상 값 CSS 동형, 실측 4.76:1).
          if (metaEl.setAttribute) metaEl.setAttribute("style", "font-size:11px;color:#64748b;margin-top:2px;");
          previewBox.appendChild(metaEl);
        }
        const desc = PhotoNaming.describe(pin);
        metaEl.textContent = desc;
        if (metaEl.classList && metaEl.classList.toggle) metaEl.classList.toggle("hidden", !desc);
      }
      if (registerBox) {
        registerBox.classList.toggle("hidden", !canEdit);
        // index.html 수정 금지 — 안내 문구만 상태에 맞게 JS 로 갱신(첫 자식 = 고정 안내 div).
        const desc = registerBox.firstElementChild;
        if (desc) desc.textContent = hasPhoto
          ? "새 파일을 선택하면 기존 사진/360을 교체합니다."
          : "등록된 사진이 없습니다. 파일을 선택하거나 경로를 입력하세요.";
      }
      if (!hasPhoto) {
        const errEl = $("pap-photo-err"); if (errEl) errEl.classList.add("hidden");
        const statusEl = $("pap-photo-status"); if (statusEl) statusEl.textContent = "";
        const urlInput = $("pap-photo-url"); if (urlInput) urlInput.value = "";
        const fileInput = $("pap-photo-file"); if (fileInput) fileInput.value = "";
      }
    },

    /** 미리보기 이미지 소스 해석 — 21_AllPins.js._loadThumb 과 같은 캐시/조회 경로 재사용 */
    async _resolvePhotoSrc(pin) {
      try {
        if (pin.imageId) {
          if (typeof Cloud !== "undefined" && Cloud._cache && Cloud._cache[pin.imageId]) return Cloud._cache[pin.imageId];
          if (typeof Cloud !== "undefined" && Cloud.fetchImage) return await Cloud.fetchImage(pin.imageId);
        }
        if (pin.localPreview) return pin.localPreview;
        if (pin.imageUrl && !PAP_VIDEO_RE.test(pin.imageUrl)) return pin.imageUrl;
      } catch (e) { /* 썸네일 실패는 무시 — 등록 상태 자체는 이미 표시됨 */ }
      return null;
    },

    /** ── 사진/360 등록: 파일 선택 — 기존 저장 경로(Cloud.resizeImage/uploadImage, imageId/imageName)
     *  재사용(신규 업로드 로직 금지, WO 20260929-2). '360' 탭 선택 시에만 등장방형 비율을 강제 검사한다
     *  — 판정 로직은 App._detect360(20_App.js) 을 그대로 재사용(SoT, 임계값 중복 금지). ── */
    async _registerPhotoFile(file) {
      const pin = this._pin(); if (!pin || !this._canEdit()) return;
      const $ = (id) => document.getElementById(id);
      const errEl = $("pap-photo-err"), statusEl = $("pap-photo-status");
      if (errEl) errEl.classList.add("hidden");
      if (!file) { if (errEl) { errEl.textContent = "파일을 선택하세요."; errEl.classList.remove("hidden"); } return; }
      const wantsTheta = this._regCat === "theta";
      if (wantsTheta) {
        if (statusEl) statusEl.textContent = "360 비율 확인 중…";
        const is360 = await new Promise((resolve) => {
          if (typeof App !== "undefined" && App._detect360) App._detect360(file, (ok) => resolve(ok));
          else resolve(false);
        });
        if (!is360) {
          if (statusEl) statusEl.textContent = "";
          if (errEl) {
            errEl.textContent = "360 사진이 아닙니다(가로:세로 ≈ 2:1 등장방형만 인식). 일반 사진은 '사진' 탭에서 등록하세요.";
            errEl.classList.remove("hidden");
          }
          return; // 조용한 실패 금지 — 이유를 보여주고 중단, 업로드하지 않는다
        }
      }
      if (statusEl) statusEl.textContent = "업로드 중…";
      try {
        const { dataURL, width, height } = await Cloud.resizeImage(file);
        // [WO 20261002-gap 묶음A②] 촬영시각 SoT = shotAt — 단건 등록도 35_PhotoBatch._sortRows의
        // 정본 우선순위(EXIF DateTimeOriginal → THETA 파일명 타임스탬프 → 파일 수정시각)를 그대로
        // 재사용한다(_parseExifDate 재사용 — 새 EXIF 파서 금지). 신호가 전혀 없을 때만 등록시각(Date.now())으로 폴백.
        let shotAt = null, shotSrc = null;
        if (typeof PhotoBatch !== "undefined" && PhotoBatch._sortRows) {
          try {
            const _buf = await file.slice(0, 262144).arrayBuffer();
            const exif = PhotoBatch._parseExifDate(_buf);
            const sorted = PhotoBatch._sortRows([{ file, name: file.name, lastModified: file.lastModified, exif }])[0];
            if (sorted && Number.isFinite(sorted.sortKey)) { shotAt = sorted.sortKey; shotSrc = sorted.timeSource; }
            // [WO 20261001-gps] 사진 EXIF GPS가 있으면 기기 GPS보다 우선(판정기준 §2) — 같은 버퍼 재사용(이중 읽기 없음).
            if (typeof GPS !== "undefined" && GPS.applyExifIfAny) GPS.applyExifIfAny(pin, _buf);
          } catch (e) { /* EXIF 실패는 치명적이지 않음 — 아래 등록시각 폴백 */ }
        }
        if (shotAt == null) { shotAt = Date.now(); shotSrc = "등록시각"; }
        // [지휘자 발주 보강 2026-09-29 §3] 저장 이름 = 영역/구역이름_촬영시각(PhotoNaming SoT,
        // 35_PhotoBatch.js) — 없으면 기존처럼 핀 라벨 기반. typeof 가드는 로드순서 무관 재사용 관례.
        const fullName = (typeof PhotoNaming !== "undefined")
          ? PhotoNaming.name(pin, file.name, shotAt, new Set())
          : (pin.label || ("pin_" + pin.id)).replace(/[^a-zA-Z0-9_\-가-힣]/g, "_");
        const imgName = fullName.replace(/\.[^.]+$/, "");
        const imageId = await Cloud.uploadImage(imgName, dataURL, width, height);
        // [WO 20261002-gap 묶음A①] 덮어쓰기 직전, 지금 "현재" 사진을 이력에 적립(SoT — pushHistory).
        if (typeof PhotoNaming !== "undefined" && PhotoNaming.pushHistory) PhotoNaming.pushHistory(pin, "단건등록");
        pin.imageId = imageId; pin.imageName = imgName; pin.origKey = null; pin.pendingOpId = null; pin.pendingSync = false;
        // [지휘자 발주 보강 §4] 표시용 메타(있는 것만 — 지어내지 않음).
        pin.origName = file.name; pin.shotAt = shotAt; pin.shotSrc = shotSrc;
        // [WO 20261001-gps] 사진 등록도 자동 위치 기록 트리거 — EXIF GPS 있으면 위에서 이미 채워졌고(우선),
        // 없으면 기기 GPS로 보강(비동기·실패해도 등록을 막지 않음).
        if (typeof GPS !== "undefined" && GPS.attachToPin) GPS.attachToPin(pin);
        if (wantsTheta) pin.is360 = true; // SoT: 20_App.js:2083 과 동일 필드(신규 필드 도입 금지)
        if (typeof Cloud !== "undefined") { Cloud._cache = Cloud._cache || {}; Cloud._cache[imageId] = dataURL; }
        // [WO 20261002-gap 묶음A④] 360 원본(풀해상도) 보관 — 보기용(4096px)과 별도로 R2에 백그라운드 업로드.
        if (wantsTheta && typeof SyncQueue !== "undefined" && SyncQueue.keepOriginal) SyncQueue.keepOriginal(pin, file, imageId);
        if (typeof App !== "undefined" && App._markDirty) App._markDirty();
        if (typeof UI !== "undefined") { UI.renderPinsOnMap && UI.renderPinsOnMap(); UI.renderPinList && UI.renderPinList(); }
        if (statusEl) statusEl.textContent = (wantsTheta ? "360° 사진 등록됨" : "사진 등록됨") + " (미저장 — 저장 버튼으로 서버에 반영하세요)";
        this._renderPhoto(pin, true);
      } catch (e) {
        if (errEl) { errEl.textContent = "업로드 실패: " + (e.message || e); errEl.classList.remove("hidden"); }
        if (statusEl) statusEl.textContent = "";
      }
    },

    /** ── 사진 등록: 경로(URL) 직접 입력 — 빈 값·잘못된 형식은 거부하고 이유 표시 ── */
    _registerPhotoUrl() {
      const pin = this._pin(); if (!pin || !this._canEdit()) return;
      const $ = (id) => document.getElementById(id);
      const errEl = $("pap-photo-err"), statusEl = $("pap-photo-status");
      const raw = ($("pap-photo-url") && $("pap-photo-url").value || "").trim();
      if (errEl) errEl.classList.add("hidden");
      if (!raw) { if (errEl) { errEl.textContent = "경로를 입력하세요."; errEl.classList.remove("hidden"); } return; }
      let parsed;
      try { parsed = new URL(raw); } catch (e) { parsed = null; }
      if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
        if (errEl) { errEl.textContent = "올바른 URL 형식이 아닙니다(http:// 또는 https:// 로 시작해야 함)."; errEl.classList.remove("hidden"); }
        return;
      }
      if (!PAP_URL_RE.test(raw)) {
        if (errEl) { errEl.textContent = "지원하지 않는 형식입니다(.jpg/.png/.gif/.webp/.mp4/.webm/.mov 만 허용)."; errEl.classList.remove("hidden"); }
        return;
      }
      pin.imageUrl = raw;
      pin.isVideo = PAP_VIDEO_RE.test(raw);
      if (typeof App !== "undefined" && App._markDirty) App._markDirty();
      if (typeof UI !== "undefined") { UI.renderPinsOnMap && UI.renderPinsOnMap(); UI.renderPinList && UI.renderPinList(); }
      if (statusEl) statusEl.textContent = "경로 등록됨 (미저장 — 저장 버튼으로 서버에 반영하세요)";
      this._renderPhoto(pin, true);
    },

    /** ── [WO 20260921] 문서 등록 — Cloud.uploadDoc/fileToDataURL 재사용(20_App.js 수정 0),
     *  pin.attachments 에 직접 추가(20_App.js 의 기존 attachments 형태 {id,name,size,type/docId}와 동일 SoT). ── */
    async _registerDocFile(file) {
      const pin = this._pin(); if (!pin || !this._canEdit()) return;
      const $ = (id) => document.getElementById(id);
      const statusEl = $("pap-doc-status");
      if (!file) return;
      if (typeof Cloud !== "undefined" && Cloud.MAX_DOC_BYTES && file.size > Cloud.MAX_DOC_BYTES) {
        const mb = (Cloud.MAX_DOC_BYTES / 1024 / 1024).toFixed(0);
        if (statusEl) statusEl.textContent = "\"" + file.name + "\" 은 너무 큽니다(최대 " + mb + "MB).";
        return;
      }
      if (statusEl) statusEl.textContent = "업로드 중…";
      try {
        const dataURL = await Cloud.fileToDataURL(file);
        const docId = await Cloud.uploadDoc(file.name, dataURL);
        if (!Array.isArray(pin.attachments)) pin.attachments = [];
        pin.attachments.push({ id: "d" + Date.now() + Math.random().toString(36).slice(2, 6), name: file.name, size: file.size, docId });
        if (typeof App !== "undefined" && App._markDirty) App._markDirty();
        if (typeof UI !== "undefined") { UI.renderPinList && UI.renderPinList(); }
        this._renderDocList(pin);
        if (statusEl) statusEl.textContent = "문서 등록됨 (미저장 — 저장 버튼으로 서버에 반영하세요)";
      } catch (e) {
        if (statusEl) statusEl.textContent = "업로드 실패: " + (e.message || e);
      }
    },

    /** 문서 첨부 목록 표시(등록된 문서 없으면 안내문) — pin.attachments 를 그대로 읽는다(SoT 1개). */
    _renderDocList(pin) {
      const list = document.getElementById("pap-doc-list");
      if (!list) return;
      const atts = (pin && pin.attachments) || [];
      const esc = (typeof UI !== "undefined" && UI.escapeHtml) ? UI.escapeHtml : (s) => String(s);
      list.innerHTML = atts.length
        ? atts.map((a) => "<div>· " + esc(a.name || "문서") + "</div>").join("")
        : "<span style=\"color:#94a3b8\">등록된 문서가 없습니다.</span>";
    },

    /** ── 노트(이슈) — 13_Notes.js 데이터/엔드포인트 재사용 ── */
    async _loadNotes(pin, canEdit) {
      const $ = (id) => document.getElementById(id);
      const formRow = $("pap-notes-form-row");
      if (formRow) formRow.classList.toggle("hidden", !canEdit);
      if (typeof Notes === "undefined") return;
      Notes.setPin(pin);
      try { await Notes.loadForPin(); } catch (e) {}
      if (Notes.renderCompact) Notes.renderCompact("pap-notes-list");
    },
    async _submitNote() {
      const pin = this._pin(); if (!pin || !this._canEdit()) return;
      const $ = (id) => document.getElementById(id);
      const input = $("pap-notes-input");
      const body = (input && input.value || "").trim();
      if (!body || typeof Notes === "undefined" || !Notes.submitCompact) return;
      const ok = await Notes.submitCompact(pin, body);
      if (ok) {
        if (input) input.value = "";
        if (Notes.renderCompact) Notes.renderCompact("pap-notes-list");
        Prompt.toast && Prompt.toast("노트 등록됨");
      } else {
        Prompt.toast && Prompt.toast("노트 등록 실패(네트워크 확인)");
      }
    }
  };

  /* ══════════════════════════════════════════
     ADMIN PANELS — 최상위 관리자: 기능/메뉴 관장 · AI 설정 · 코드맵
  ══════════════════════════════════════════ */
  // 이 프로젝트에서 켜고 끌 수 있는 기능 정의(키 = app_settings.features 의 키)
  const FEATURE_DEFS = [
    { key: "annotations", label: "PDF 주석(형광펜·도형·메모)", desc: "도면 위 주석 도구 모음" },
    { key: "zones",       label: "영역/구역 지정",            desc: "사각형·원·다각형 구역 그리기" },
    { key: "pin360",      label: "360° 파노라마 핀",          desc: "핀 클릭 시 360 뷰어 열기" },
    { key: "fls3d",       label: "3D 포인트 클라우드(FLS)",   desc: "FLS/E57/LAS 첨부·듀얼뷰" },
    { key: "ai",          label: "AI 도우미",                 desc: "에러·사용 가이드 LLM(키 설정 시)" },
    { key: "timelapse",   label: "타임랩스 비교",             desc: "동일 위치 시점 비교" },
    { key: "export",      label: "내보내기/배포",             desc: "JSON 내보내기·뷰어 배포" }
  ];
