  /* ══════════════════════════════════════════════════════════════
     사진 폴더 일괄 매칭 — 핀 번호 ↔ 촬영시각 1:1 매칭
     ────────────────────────────────────────────────────────────────
     마스터 요청(2026-09-03, RESUME_LEDGER.md §H): "핀을 순서대로 찍어둔 뒤 사진이
     들어있는 폴더를 선택하면 사진 생성 시간 순서대로 핀 번호대로 1번부터 몇 번까지
     설정한 후 업로드하면 핀 번호 순서 ↔ 사진 시간 순서로 1:1 매칭돼서 그 위치에
     사진이 등록"

     정렬 우선순위(추측을 사실처럼 보이지 않도록 각 행에 근거를 표시한다):
       1) EXIF DateTimeOriginal(진짜 촬영시각)
       2) 파일 lastModified
       3) 파일명 자연정렬
       — build-tools/photo-timesort.mjs(참고구현·실데이터 57장 검증됨)와 같은 로직을
         브라우저(ArrayBuffer/DataView)로 포팅. 로직은 바꾸지 않는다.

     번호 정본: PinSeries.numbers()(01b_PinSeries.js).
     🔴 [마스터 요청 2026-09-03 갱신] 처음엔 "콘텐츠 계열"만 매칭 대상이었으나(체크보드는 별도
       채번이라 제외), 마스터가 "체크보드로 핀을 차례대로 박고 → 그 핀들에 사진 폴더를 일괄
       연동"이라고 명시해 체크보드 계열도 매칭 대상으로 바뀌었다. 번호가 계열마다 독립 채번(1부터)
       이라 같은 번호가 계열마다 존재할 수 있으므로, open()/_pinList() 는 **어느 계열의 범위인지**
       를 함께 받는다(series 미지정 시 기존 단독 진입과 동일하게 "content" 로 폴백 — 하위호환).
       tests/p6-photo-batch.test.mjs §④ 참조(체크보드 제외 기대값 → 계열 지정 매칭으로 변경, 사유 주석 포함).

     저장 경로: Cloud.resizeImage()/Cloud.uploadImage() + 오프라인 SyncQueue.enqueue() —
       20_App.js _confirmPin() 의 이미지 분기(≈1908~1934행)와 동일 API 조합을 그대로 쓴다.
       새 저장 경로를 만들지 않는다.
       🔴 단, App._uploadPinImageBg() 는 재사용하지 않는다 — 그 함수는 끝에서 this._autoSave()
       를 호출해 매 장마다 서버에 자동저장되는데, 이 기능은 "자동저장 OFF 정책 유지 — 등록 후
       미저장 표시만" 이 명시 요구사항(§H⑦)이라 상충한다. 그래서 동일한 저장 API 3개
       (resizeImage/uploadImage/SyncQueue.enqueue)만 재사용하고, 자동저장 대신
       App._markDirty() 로 "미저장" 표시만 남긴다.
     360 판별: App._detect360(file, cb) 재사용(자체 판별 로직 추가 금지).
  ══════════════════════════════════════════════════════════════ */
  /* ══ [지휘자 발주 보강 2026-09-29 §3·§4] 신규 등록 사진 저장 이름 + 표시용 메타 SoT ══════════
     마스터: "만약 영역이나 구역이 있다면 그 사진은 영역이름_시간으로 변경해서 등록해" /
     "사진정보를 바로 알아볼 수 있게".
     🔴 용어 주의 — 이 코드베이스엔 사각형 주석(State.zones, `Zones._contains`)도 "영역"으로
     불리는 곳이 있어 이름이 겹친다. 여기서는 발주 원문의 "crop 안" 표현을 근거로 **deck 계층**
     (Projects.currentDeck/decks, parent_id·crop)으로 해석했다 — [Uncertain] 100% 확정은 아니며,
     오판정이면 scopeOf() 한 곳만 고치면 된다(SoT). 적용은 신규 등록에만(기존 이름 불변). */
  const PhotoNaming = {
    _ILLEGAL_RE: /[\\/:*?"<>|\x00-\x1F]/g,
    sanitize(s) { return String(s == null ? "" : s).replace(this._ILLEGAL_RE, "-").trim(); },
    _fmtTs(ms) {
      if (!Number.isFinite(ms)) return null;
      const d = new Date(ms);
      const p = (n) => String(n).padStart(2, "0");
      return "" + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
    },
    _fmtDisplay(ms) {
      const d = new Date(ms);
      const p = (n) => String(n).padStart(2, "0");
      return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
    },
    /** 핀이 속한 영역(구역의 자식 deck, crop 안)/구역(부모 deck) 이름 — 트리와 동일 규칙
     *  (겹치면 면적이 작은 쪽, 11_UI.js zoneOfPin 알고리즘을 deck.crop 에 적용). */
    scopeOf(pin) {
      try {
        if (typeof Projects === "undefined" || !pin) return { area: null, zone: null };
        const cur = Projects.currentDeck;
        if (!cur) return { area: null, zone: null };
        const decks = Array.isArray(Projects.decks) ? Projects.decks : [];
        const isRegion = !!(cur.crop && cur.crop.w > 0 && cur.crop.h > 0);
        if (isRegion) {
          const parent = decks.find((d) => d.id === cur.parent_id);
          return { area: cur.name || null, zone: parent ? (parent.name || null) : null };
        }
        const children = decks.filter((d) => d.parent_id === cur.id && d.crop && d.crop.w > 0 && d.crop.h > 0 && (d.page || 1) === (pin.page || 1));
        let best = null, bestArea = Infinity;
        children.forEach((d) => {
          const c = d.crop;
          const inside = pin.x >= c.x && pin.x <= c.x + c.w && pin.y >= c.y && pin.y <= c.y + c.h;
          if (!inside) return;
          const area = c.w * c.h;
          if (area < bestArea) { bestArea = area; best = d; }
        });
        return { area: best ? (best.name || null) : null, zone: cur.name || null };
      } catch (e) { return { area: null, zone: null }; }
    },
    /** 저장 이름(확장자 포함) — 영역 있으면 영역이름_시각, 없고 구역만 있으면 구역이름_시각,
     *  둘 다 없으면 원본 파일명 유지. @param {Set<string>} [usedNames] 충돌 시 _2,_3… 접미사
     *  (이 함수 호출부가 한 배치 동안 공유하는 Set 하나 — 서버 전체 네임스페이스 조회는 하지 않는다). */
    name(pin, origName, shotAtMs, usedNames) {
      origName = origName || "";
      const extMatch = /\.[^.]+$/.exec(origName);
      const ext = extMatch ? extMatch[0].toLowerCase() : "";
      const scope = this.scopeOf(pin);
      const label = scope.area || scope.zone;
      if (!label) return origName || ("photo" + ext);
      const ts = this._fmtTs(shotAtMs) || this._fmtTs(Date.now());
      const base = this.sanitize(label) + "_" + ts;
      const used = usedNames || new Set();
      let candidate = base + ext, n = 2;
      while (used.has(candidate)) { candidate = base + "_" + n + ext; n++; }
      return candidate;
    },
    /** 표시용 한 줄 — "영역/구역명 · YYYY-MM-DD HH:MM:SS · 원본 파일명"(값 없는 항목은 생략).
     *  [지휘자 발주 2026-09-29 항목3] 🔴 shotAt/origName 은 이 WO 이후 신규 등록에만 채워지는
     *  필드라, 그 전에 이미 사진이 등록된 핀은 둘 다 없어 영역/구역명 한 단어만 보여 "사진 정보를
     *  바로 알아볼 수 있게"라는 요구를 충족 못 했다(지휘자 실측: "floor"만 표시). shotAt/origName이
     *  둘 다 없을 때는 등록 시 이미 저장된 pin.imageName(PhotoNaming.name 의 결과, 20_App.js/
     *  27_PinActionPop.js/35_PhotoBatch.js 저장 경로 공통 필드)을 대신 보여준다 — 새 필드를
     *  만들지 않고 기존 값을 재사용(§10 SoT, 조용한 실패 금지). */
    describe(pin) {
      if (!pin) return "";
      const parts = [];
      const scope = this.scopeOf(pin);
      const label = scope.area || scope.zone;
      if (label) parts.push(label);
      if (Number.isFinite(pin.shotAt)) parts.push(this._fmtDisplay(pin.shotAt));
      if (pin.origName) parts.push("원본 " + pin.origName);
      if (!Number.isFinite(pin.shotAt) && !pin.origName && pin.imageName) parts.push(pin.imageName);
      return parts.join(" · ");
    },

    /** [WO 20261002-gap 묶음A①] 사진 교체 직전 "지금 현재 사진"을 pin.timeline 이력에 적립 —
     *  단건(27_PinActionPop)·일괄(35_PhotoBatch run/applyTimeMatch)·자동연결(autoConnectPin)·
     *  오프라인(큐 적립) 4경로가 공유하는 SoT 1개(§10). pin.imageId/imageUrl/pendingOpId 중
     *  하나도 없으면(신규 등록) 적립할 "이전 사진"이 없으므로 조용히 아무 것도 하지 않는다.
     *  현재 필드 자체는 호출부가 뒤이어 새 값으로 덮어쓴다(이 함수는 적립만, 교체는 안 함). */
    pushHistory(pin, source) {
      if (!pin) return;
      const hasCurrent = pin.imageId || pin.imageUrl || pin.pendingOpId;
      if (!hasCurrent) return;
      if (!Array.isArray(pin.timeline)) pin.timeline = [];
      const last = pin.timeline[pin.timeline.length - 1];
      const dup = last && (
        (pin.imageId && last.imageId === pin.imageId) ||
        (pin.imageUrl && last.imageUrl === pin.imageUrl) ||
        (pin.pendingOpId && last.pendingOpId === pin.pendingOpId)
      );
      if (dup) return; // 재시도/중복호출 안전장치 — 같은 사진을 두 번 적립하지 않는다
      pin.timeline.push({
        id: "tl" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        imageId: pin.imageId || null,
        imageUrl: pin.imageUrl || null,
        pendingOpId: pin.pendingOpId || null,
        origKey: pin.origKey || null,
        isVideo: !!pin.isVideo,
        shotAt: Number.isFinite(pin.shotAt) ? pin.shotAt : (pin.capturedAt || null),
        shotSrc: pin.shotSrc || null,
        origName: pin.origName || null,
        source: source || null,
        by: (typeof Auth !== "undefined" && Auth.user && Auth.user.email) || null,
        at: Date.now()
      });
    }
  };

  const PhotoBatch = {
    /** 🔴 [WO 20261001-offline · p102 A2] 사진 연결 결과(pendingOpId·imageName)를 **로컬 draft 에도** 남기고 미저장 표시.
     *  종전엔 _markDirty() 만 불러 draft 에 pendingOpId 가 없었다 → 오프라인 새로고침 뒤 핀이 사진을 잃고,
     *  큐는 업로드 성공으로 비워져 사진이 고아가 됐다. _saveDraftLocal 은 **로컬 전용**(서버 저장 0) —
     *  자동저장 OFF 정책(서버 반영은 '저장' 버튼)은 그대로다. 세 연결 경로(run·시각매칭 적용·자동연결)의 공유 지점. */
    _markUnsaved() {
      try { App._markDirty && App._markDirty(); } catch (e) {}
      try { if (App._saveDraftLocal) { const p = App._saveDraftLocal(); if (p && p.catch) p.catch(() => {}); } } catch (e) {}
      // 🔴 [WO 20261006-oplog] 로컬 번들 스냅샷도 갱신 — _autoSave 와 같은 공유 지점(persistLocalDeployment)을 지나야
      //   오프라인 사진 연결이 oplog 에 기록된다(OpLog.recordPinDelta). 종전엔 이 경로만 빠져 oplog 0건이었다.
      try { if (typeof persistLocalDeployment === "function") persistLocalDeployment().catch(() => {}); } catch (e) {}
    },
    _rows: [],              // 표시/매칭 순서 그대로 보관 [{file,name,lastModified,exif,excluded,sortKey,timeSource,timeLabel,is360,w,h,bigGapBefore,gapMs}]
    _range: { start: 1, end: 1, series: "content" },
    _busy: false,

    /* ══ 순수 로직 — 회귀 테스트가 직접 호출한다(DOM 무의존) ══════════ */

    /** 파일명 자연정렬(숫자를 숫자로) — build-tools/photo-timesort.mjs 와 동일 */
    _natural(a, b) { return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }); },

    _asciiAt(view, off, n) {
      let s = "";
      for (let k = 0; k < n; k++) s += String.fromCharCode(view.getUint8(off + k));
      return s;
    },

    /** JPEG APP1(EXIF)에서 DateTimeOriginal(0x9003)/DateTimeDigitized(0x9004)/DateTime(0x0132)을 찾는다.
     *  입력: ArrayBuffer(파일 선두 일부, File.slice().arrayBuffer()). 실패해도 예외를 던지지 않고
     *  null 을 반환해 mtime/파일명 폴백으로 자연히 넘어가게 한다(node 버전의 Buffer 판을 DataView 로 포팅). */
    _parseExifDate(buf) {
      try {
        const b = new DataView(buf);
        const len = b.byteLength;
        if (len < 4 || b.getUint8(0) !== 0xFF || b.getUint8(1) !== 0xD8) return null;
        let i = 2;
        while (i < len - 4) {
          if (b.getUint8(i) !== 0xFF) { i++; continue; }
          const marker = b.getUint8(i + 1);
          if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { i += 2; continue; }
          if (i + 4 > len) break;
          const segLen = b.getUint16(i + 2, false);
          const segStart = i + 4;
          if (marker === 0xE1 && segStart + 4 <= len && this._asciiAt(b, segStart, 4) === "Exif") {
            const r = this._parseExifIfd(b, segStart + 6, Math.min(segStart + segLen, len));
            if (r) return r;
          }
          if (marker === 0xDA) break; // SOS 이후는 압축 데이터
          i = segStart + segLen - 2;
          if (segLen <= 0) break;
        }
        return null;
      } catch (e) { return null; }
    },

    /** TIFF 헤더부터 IFD0 + ExifIFD 를 훑어 촬영시각 태그 + [WO 20260929 photo-time-match]
     *  Make(0x010F)/Model(0x0110, 360 카메라 판별 보강신호) / OffsetTimeOriginal(0x9010,
     *  카메라 자체 UTC 오프셋 — 있으면 시각을 정확한 절대시각으로 환산해 시계보정 정밀도를 높인다)
     *  를 함께 읽는다. 반환 형태는 기존 {iso,tag} 를 그대로 포함해 하위호환(테스트①)을 지킨다. */
    _parseExifIfd(b, tiffStart, end) {
      if (tiffStart + 8 > end) return null;
      const le = this._asciiAt(b, tiffStart, 2) === "II";
      const u16 = (o) => b.getUint16(o, le);
      const u32 = (o) => b.getUint32(o, le);
      if (u16(tiffStart + 2) !== 42) return null;
      let best = null, make = null, model = null, offsetOriginal = null;
      const readAscii = (e, type, cnt) => {
        if (type !== 2) return null;
        const valOff = (cnt > 4) ? tiffStart + u32(e + 8) : e + 8;
        if (valOff + cnt > end) return null;
        return this._asciiAt(b, valOff, cnt).replace(/\0+$/, "");
      };
      const walk = (ifdOff, depth) => {
        if (depth > 2 || (best && best.tag === "DateTimeOriginal")) return;
        const at = tiffStart + ifdOff;
        if (at + 2 > end) return;
        const n = u16(at);
        for (let k = 0; k < n; k++) {
          const e = at + 2 + k * 12;
          if (e + 12 > end) return;
          const tag = u16(e), type = u16(e + 2), cnt = u32(e + 4);
          if (tag === 0x010F) make = readAscii(e, type, cnt);            // Make
          if (tag === 0x0110) model = readAscii(e, type, cnt);           // Model
          if (tag === 0x9010) offsetOriginal = readAscii(e, type, cnt);  // OffsetTimeOriginal
          const valOff = (type === 2 && cnt > 4) ? tiffStart + u32(e + 8) : e + 8;
          if (tag === 0x8769) { walk(u32(e + 8), depth + 1); continue; } // ExifIFD 포인터
          if ((tag === 0x9003 || tag === 0x9004 || tag === 0x0132) && type === 2 && valOff + 19 <= end) {
            const s = this._asciiAt(b, valOff, 19); // "YYYY:MM:DD HH:MM:SS"
            const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(s);
            if (m) {
              const iso = m[1] + "-" + m[2] + "-" + m[3] + "T" + m[4] + ":" + m[5] + ":" + m[6];
              if (tag === 0x9003) { best = { iso, tag: "DateTimeOriginal" }; continue; }
              if (!best) best = { iso, tag: tag === 0x9004 ? "DateTimeDigitized" : "DateTime" };
            }
          }
        }
      };
      walk(u32(tiffStart + 4), 0);
      if (!best && !make && !model) return null;
      return Object.assign({}, best, { make: make, model: model, offsetOriginal: offsetOriginal });
    },

    /** [지휘자 발주 보강 2026-09-29] THETA X 실기기 파일명 패턴 — 마스터 실측 스크린샷:
     *  "R0013783_20260929155952.JPG"(경로 /내장 저장공간/Pictures/RICOH THETA, Android).
     *  "R" + 일련번호 + "_" + YYYYMMDDHHMMSS(로컬시각) + 확장자. EXIF 가 없어도(또는 못 읽어도)
     *  이 패턴만으로 촬영시각을 정확히 복원할 수 있다 — 파일명 자연정렬 폴백보다 우선한다. */
    _THETA_NAME_RE: /^R\d+_(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(jpe?g)$/i,
    _parseThetaFilenameDate(name) {
      const m = this._THETA_NAME_RE.exec(String(name || ""));
      if (!m) return null;
      return { iso: m[1] + "-" + m[2] + "-" + m[3] + "T" + m[4] + ":" + m[5] + ":" + m[6] };
    },
    /** 파일명만으로 THETA 촬영분임을 추정하는 보강 신호(360 최종 판정은 App._detect360 비율검사가
     *  정본 — 이 신호는 근접 타이 브레이크용으로만 쓴다. 이름만으로 360 여부를 확정하지 않는다). */
    _isThetaFilename(name) { return this._THETA_NAME_RE.test(String(name || "")); },

    /** 정렬 우선순위(EXIF → 파일명 THETA 타임스탬프 → mtime → 파일명 자연정렬)에 따라
     *  sortKey/timeSource/timeLabel 을 부여하고 정렬한 "새" 배열을 반환한다(원본 불변).
     *  큰 시간 간격(10분↑) 지점엔 bigGapBefore 를 단다. 순수 함수 — 테스트가 직접 호출한다. */
    _sortRows(rows) {
      const withKey = (rows || []).map((r) => {
        let sortKey, timeSource, timeLabel;
        const fnDate = this._parseThetaFilenameDate(r.name);
        if (r.exif && r.exif.iso) {
          // [WO 20260929 photo-time-match] OffsetTimeOriginal(카메라 자체 UTC 오프셋)이 있으면
          // 그걸 붙여 절대시각으로 정확히 환산한다(카메라·휴대폰이 다른 타임존이어도 정확).
          // 없으면 기존과 동일하게 휴대폰(브라우저) 로컬 타임존으로 해석(Date.parse 기본 동작).
          // 🔴 파일명·EXIF 가 다르면 EXIF 가 우선이다(EXIF=카메라가 기록한 진짜 촬영시각).
          const off = r.exif.offsetOriginal;
          sortKey = (off && /^[+-]\d{2}:\d{2}$/.test(off)) ? Date.parse(r.exif.iso + off) : Date.parse(r.exif.iso);
          timeSource = "EXIF " + r.exif.tag;
          timeLabel = r.exif.iso.replace("T", " ");
        } else if (fnDate) {
          sortKey = Date.parse(fnDate.iso);
          timeSource = "파일명(THETA 타임스탬프)";
          timeLabel = fnDate.iso.replace("T", " ");
        } else if (Number.isFinite(r.lastModified)) {
          sortKey = r.lastModified;
          timeSource = "파일 수정시각";
          timeLabel = new Date(r.lastModified).toISOString().slice(0, 19).replace("T", " ");
        } else {
          sortKey = NaN;
          timeSource = "파일명순(시간정보 없음)";
          timeLabel = "-";
        }
        return Object.assign({}, r, { sortKey, timeSource, timeLabel, bigGapBefore: false, gapMs: 0 });
      });
      withKey.sort((a, b) => {
        const ak = Number.isFinite(a.sortKey) ? a.sortKey : Infinity;
        const bk = Number.isFinite(b.sortKey) ? b.sortKey : Infinity;
        if (ak !== bk) return ak - bk;
        return this._natural(a.name, b.name);
      });
      const GAP_MS = 10 * 60 * 1000; // 10분↑ = 구역 이동 경계 추정(실데이터: 중앙값 19초 vs 최대 4948초)
      for (let k = 1; k < withKey.length; k++) {
        const a = withKey[k - 1], c = withKey[k];
        if (Number.isFinite(a.sortKey) && Number.isFinite(c.sortKey) && (c.sortKey - a.sortKey) >= GAP_MS) {
          c.bigGapBefore = true; c.gapMs = c.sortKey - a.sortKey;
        }
      }
      return withKey;
    },

    /** 🔴 번호는 PinSeries 정본에서만 파생(자체 채번 금지). 현재 페이지의 지정 계열
     *  핀만 오름차순으로 나열한다. @param {string} [series="content"] 번호는 계열마다
     *  독립 채번(1부터)이라 계열을 반드시 지정해야 모호성이 없다(미지정 시 기존 단독
     *  진입과 동일하게 "content" 로 폴백 — 하위호환). */
    _pinList(pins, page, series) {
      const ser = series || "content";
      const map = PinSeries.numbers(pins || [], page);
      const list = [];
      (pins || []).forEach((p) => {
        if (!p || (p.page || 1) !== (page || 1)) return;
        const info = map.get(p.id);
        if (!info || info.series !== ser) return;
        list.push({ pin: p, no: info.no });
      });
      list.sort((a, b) => a.no - b.no);
      return list;
    },

    /** 핀 번호 범위 × 표시행 순서(제외 반영) → 1:1 매칭. 순수 함수.
     *  개수가 다르면 남는 쪽을 leftoverPins/leftoverRows 로 알려준다(조용히 자르지 않음). */
    _buildMatches(pinList, rows, range) {
      const pinsInRange = (pinList || []).filter((e) => e.no >= range.start && e.no <= range.end);
      const activeRows = (rows || []).filter((r) => !r.excluded);
      const n = Math.min(pinsInRange.length, activeRows.length);
      const matches = [];
      for (let i = 0; i < n; i++) matches.push({ pin: pinsInRange[i].pin, no: pinsInRange[i].no, row: activeRows[i] });
      return {
        matches,
        leftoverPins: pinsInRange.slice(n),
        leftoverRows: activeRows.slice(n)
      };
    },

    _esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); },

    /** [지휘자 발주 보강§3] PhotoNaming 충돌회피 시드 — 현재 페이지 핀들이 이미 쓰고 있는 저장
     *  이름(확장자 없음, 기존 pin.imageName 관례). 전체 R2 네임스페이스 조회는 하지 않는다(범위 명시). */
    _usedPhotoNames() {
      const used = new Set();
      ((typeof State !== "undefined" && State.pins) || []).forEach((p) => { if (p && p.imageName) used.add(p.imageName); });
      return used;
    },

    /* ══ [WO 20260929 photo-time-match] 핀 생성시각 ↔ 360 사진 촬영시각 최근접 자동매칭 ══
       마스터 요청: "포인트 생성 시간을 기록해 핸드폰에 할 때에는 그 시간에 들어오는 사진을
       반드시 360도 사진을 찾아서 연동 가능하게 해 제일 근사한 시간에 저장된 360 그림을 찾아서
       연동되게" / "THETA X야 … 와이파이에 연결되었을 때는 감지해서 같이 작동 연동해".
       기존 _buildMatches(번호순×표시순서 1:1, 위치 기반)는 그대로 둔다(하위호환·기존 테스트 불변) —
       이 블록은 완전히 새로운 "시각 최근접" 경로다. 순수 함수만 두고, DOM 연결은 아래 별도 섹션. */

    /** THETA/RICOH 360 카메라 신호(EXIF Make/Model) — 최종 360 여부는 App._detect360(비율+폭)이
     *  정본이다. 이 함수는 여러 후보가 동시에 근접할 때 THETA 촬영분을 우선하는 참고신호로만 쓴다. */
    _isThetaSignal(make, model) {
      const s = String(make || "") + " " + String(model || "");
      return /ricoh/i.test(s) || /theta/i.test(s);
    },

    /** 핀 시각(ms) — PinSeries.createdAt() SoT 파생 재사용(자체 추정 금지). 구할 수 없으면 null. */
    _pinTimeMs(pin) {
      return (typeof PinSeries !== "undefined" && PinSeries.createdAt) ? PinSeries.createdAt(pin) : null;
    },

    /** 사진 시각(ms) = _sortRows 가 부여한 sortKey(EXIF/mtime) + 사용자 시계보정(분, ±).
     *  파일명순 폴백(시간정보 없음, sortKey=NaN)은 시간매칭 대상에서 제외한다(조용히 추정 금지). */
    _rowTimeMs(row, offsetMin) {
      if (!row || !Number.isFinite(row.sortKey)) return null;
      return row.sortKey + (Number(offsetMin) || 0) * 60000;
    },

    /** 최근접 1:1 그리디 할당(순수 함수). 모든 (핀,사진) 쌍 중 |Δt| 가 허용오차 이내인 것만
     *  후보로 삼아 Δt 오름차순으로 확정한다 — "번호순×사진순" 위치 매칭과 달리 사진 한 장이
     *  누락/추가돼도 이후 전부 밀리지 않는다(각 쌍이 실제 근접도로 독립 확정되므로). */
    _nearestAssign(pinEntries, rowEntries, toleranceMs) {
      const pairs = [];
      (pinEntries || []).forEach((p, pi) => {
        if (!Number.isFinite(p.t)) return;
        (rowEntries || []).forEach((r, ri) => {
          if (!Number.isFinite(r.t)) return;
          const dt = Math.abs(p.t - r.t);
          if (dt <= toleranceMs) pairs.push({ pi, ri, dt });
        });
      });
      // [지휘자 발주 보강] Δt 가 같은 동률 쌍이면 THETA 파일명/EXIF 신호가 있는 사진을 우선한다
      // (이름만으로 360 여부를 확정하지는 않는다 — 후보 자체는 여전히 row.is360===true 만 진입).
      pairs.sort((a, b) => a.dt - b.dt
        || ((rowEntries[b.ri].row.thetaSignal ? 1 : 0) - (rowEntries[a.ri].row.thetaSignal ? 1 : 0)));
      const usedP = new Set(), usedR = new Set();
      const matches = [];
      pairs.forEach((pr) => {
        if (usedP.has(pr.pi) || usedR.has(pr.ri)) return;
        usedP.add(pr.pi); usedR.add(pr.ri);
        matches.push({ pin: pinEntries[pr.pi].pin, no: pinEntries[pr.pi].no, row: rowEntries[pr.ri].row, dtMs: pr.dt });
      });
      matches.sort((a, b) => (a.row.__idx || 0) - (b.row.__idx || 0));
      const unmatchedPins = (pinEntries || []).filter((_, pi) => !usedP.has(pi)).map((e) => ({ pin: e.pin, no: e.no }));
      const unmatchedRows = (rowEntries || []).filter((_, ri) => !usedR.has(ri)).map((e) => e.row);
      return { matches, unmatchedPins, unmatchedRows };
    },

    /** [핵심 API] 시각 최근접 자동매칭 — 대상 계열의 핀(기본: 아직 360 없는 핀, is360!==true) ×
     *  360 판정된 사진(row.is360===true 만 후보 — 아닌 것은 excluded360 으로 남겨 "360 아님"을
     *  화면에 명시하고 조용히 빠뜨리지 않는다)을 |Δt| 오름차순 그리디로 1:1 확정한다.
     *  @param {{toleranceMs?:number, offsetMin?:number, includeExisting360?:boolean}} [opts] */
    _buildTimeMatches(pinList, rows, opts) {
      const o = opts || {};
      const toleranceMs = Number.isFinite(o.toleranceMs) ? o.toleranceMs : 10 * 60 * 1000;
      const offsetMin = Number(o.offsetMin) || 0;
      const includeExisting = !!o.includeExisting360;

      const skippedExisting = [];
      const pinEntries = [];
      (pinList || []).forEach((e) => {
        if (!includeExisting && e.pin && e.pin.is360 === true) { skippedExisting.push(e); return; }
        pinEntries.push({ pin: e.pin, no: e.no, t: this._pinTimeMs(e.pin) });
      });
      // [지휘자 발주 보강2 §2] 작업 시간대 창 — 대상 핀들의 생성시각 범위 밖 사진은(폴더 전체
      // 선택 시 옛 사진 수백 장이 섞여도) 후보에서 빼고 개수만 표시한다(조용히 빠뜨리지 않되,
      // 목록을 전부 그리지도 않음 — 설계 §2 "개수만 표시").
      const validPinTimes = pinEntries.map((e) => e.t).filter((t) => Number.isFinite(t));
      const winMin = validPinTimes.length ? Math.min(...validPinTimes) - toleranceMs : null;
      const winMax = validPinTimes.length ? Math.max(...validPinTimes) + toleranceMs : null;

      const excluded360 = [];
      const outOfWindow = [];
      const rowEntries = [];
      (rows || []).forEach((row, idx) => {
        row.__idx = idx;
        if (row.excluded) return;
        if (row.is360 !== true) { excluded360.push(row); return; }
        const t = this._rowTimeMs(row, offsetMin);
        if (winMin != null && Number.isFinite(t) && (t < winMin || t > winMax)) { outOfWindow.push(row); return; }
        rowEntries.push({ row, t });
      });

      const { matches, unmatchedPins, unmatchedRows } = this._nearestAssign(pinEntries, rowEntries, toleranceMs);
      return { matches, unmatchedPins, unmatchedRows, excluded360, skippedExisting, outOfWindow };
    },

    /* ══ DOM 연결 ══════════════════════════════════════════════ */

    init() {
      const $ = (id) => document.getElementById(id);
      $("btn-photobatch") && $("btn-photobatch").addEventListener("click", () => this.open());
      $("photobatch-close") && $("photobatch-close").addEventListener("click", () => this.close());
      document.querySelectorAll('.admin-gate-backdrop[data-close="photobatch"]').forEach((bd) => bd.addEventListener("click", () => this.close()));

      const folderInp = $("input-photobatch-folder");
      if (folderInp) folderInp.addEventListener("change", (e) => { const files = Array.from(e.target.files || []); e.target.value = ""; this._onFilesChosen(files); });
      $("btn-photobatch-pick") && $("btn-photobatch-pick").addEventListener("click", () => folderInp && folderInp.click());

      const filesInp = $("input-photobatch-files");
      if (filesInp) filesInp.addEventListener("change", (e) => { const files = Array.from(e.target.files || []); e.target.value = ""; this._onFilesChosen(files); });
      $("btn-photobatch-pick-files") && $("btn-photobatch-pick-files").addEventListener("click", () => filesInp && filesInp.click());

      $("btn-photobatch-run") && $("btn-photobatch-run").addEventListener("click", () => this.run());

      // [WO 20260930-autophoto] 360 자동연결 세션 초기화 버튼(index.html #btn-photo-reselect).
      $("btn-photo-reselect") && $("btn-photo-reselect").addEventListener("click", () => this.resetAutoSession());

      const s = $("photobatch-start");
      if (s) s.addEventListener("change", () => { const v = parseInt(s.value, 10); if (Number.isFinite(v)) this._range.start = v; this._renderTable(); });
      const e2 = $("photobatch-end");
      if (e2) e2.addEventListener("change", () => { const v = parseInt(e2.value, 10); if (Number.isFinite(v)) this._range.end = v; this._renderTable(); });

      const tbody = $("photobatch-table-body");
      if (tbody) {
        tbody.addEventListener("click", (e) => {
          const b = e.target.closest && e.target.closest("[data-act]");
          if (!b) return;
          const idx = parseInt(b.dataset.idx, 10);
          if (b.dataset.act === "up") this._moveRow(idx, -1);
          else if (b.dataset.act === "down") this._moveRow(idx, 1);
        });
        tbody.addEventListener("change", (e) => {
          const b = e.target.closest && e.target.closest('[data-act="excl"]');
          if (!b) return;
          this._toggleExclude(parseInt(b.dataset.idx, 10));
        });
      }
    },

    /* [WO 20260918] 🔴 series 하드코딩 제거 — 단독 진입(#btn-photobatch)이 "콘텐츠 계열"로
     *  고정돼 있어, 체크보드 모드에서 열면 대상 핀이 항상 0건이었다(진입로는 있지만 결과가 없어
     *  조용히 실패). 현재 배치 모드(State.checkboard, 20_App.js SoT)를 그대로 반영한다 —
     *  새 상태를 만들지 않고 기존 SoT 를 재사용. */
    _defaultRange() {
      // [WO 20260930-moderole] 🔴 마스터: "체커는 사진을 등록하지 않을 거야" — 사진 폴더 일괄
      // 매칭의 대상은 항상 360(content) 계열만이다(CHECKER 계열은 절대 대상이 아니다, SoT:
      // PinSeries.seriesOf). 예전엔 State.regMode 로 CHECKER 계열도 골랐으나(WO 20260929 addendum),
      // 이제 CHECKER 핀은 사진을 등록하지 않으므로 그 분기를 제거한다(항상 content).
      const series = "content";
      const list = this._pinList(State.pins, State.pdfPage || 1, series);
      return { start: list.length ? list[0].no : 1, end: list.length ? list[list.length - 1].no : 1, series: series };
    },

    /** @param {{start:number,end:number,series?:string}} [range] — 호출부가 명시 범위를 넘기면
     *  그대로 채운다(range 없이 호출하는 경로는 현재 #btn-photobatch 단독 진입 하나뿐).
     *  🔴 [WO 20260918] series 생략 시 _defaultRange() 가 현재 배치 모드(State.checkboard)를
     *  따라 "content"/"checkboard" 를 자동 선택한다 — 예전엔 "content" 로 고정돼 체크보드
     *  모드에서 열면 대상 핀이 0건이었다(하드코딩 제거). */
    open(range) {
      if (typeof Auth !== "undefined" && Auth.requireDesigner && !Auth.isDesigner) { Auth.requireDesigner(() => {}); return; }
      this._rows = [];
      this._range = (range && Number.isFinite(range.start) && Number.isFinite(range.end))
        ? { start: range.start, end: range.end, series: range.series || "content" }
        : this._defaultRange();
      const modal = document.getElementById("photobatch-modal");
      if (!modal) return;
      modal.classList.remove("hidden");
      requestAnimationFrame(() => modal.classList.add("on"));
      const s = document.getElementById("photobatch-start"); if (s) s.value = this._range.start;
      const e = document.getElementById("photobatch-end"); if (e) e.value = this._range.end;
      const ov = document.getElementById("photobatch-overwrite"); if (ov) ov.checked = false;
      const prog = document.getElementById("photobatch-progress"); if (prog) prog.textContent = "";
      // [마스터 요청 2026-09-03] 계열이 섞여 모호해질 수 있으므로 대상 계열을 화면에 명시한다
      // (조용히 아무거나 고르지 않음 — §10 조용한 실패 금지).
      const title = document.getElementById("photobatch-title");
      if (title) {
        const label = (typeof PinSeries !== "undefined" && PinSeries.LABELS && PinSeries.LABELS[this._range.series]) || this._range.series;
        title.textContent = "사진 폴더 일괄 매칭 — " + label + " 계열";
      }
      this._renderTable();
      // [WO 20260918] 🔴 조용한 실패 금지 — 대상 계열 핀이 0건이면 모달만 열고 아무 말 없던 것을
      // 이유와 함께 알린다(기존 토스트 경로 재사용, 새 UI 없음).
      const targetList = this._pinList(State.pins, State.pdfPage || 1, this._range.series);
      if (!targetList.length && typeof Prompt !== "undefined" && Prompt.toast) {
        const label2 = (typeof PinSeries !== "undefined" && PinSeries.LABELS && PinSeries.LABELS[this._range.series]) || this._range.series;
        Prompt.toast("이 화면(" + label2 + " 계열)에는 대상 핀이 없습니다 — 먼저 번호 핀을 찍어주세요");
      }
    },

    close() {
      const modal = document.getElementById("photobatch-modal");
      if (!modal) return;
      modal.classList.remove("on");
      setTimeout(() => modal.classList.add("hidden"), 180);
    },

    async _onFilesChosen(files) {
      const IMG_RE = /\.(jpe?g|png|webp)$/i;
      const imgFiles = (files || []).filter((f) => IMG_RE.test(f.name));
      if (!imgFiles.length) { if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("이미지 파일을 찾을 수 없습니다"); return; }
      const status = document.getElementById("photobatch-status");
      if (status) status.textContent = imgFiles.length + "장 분석 중...";
      const rows = [];
      for (const f of imgFiles) {
        let exif = null;
        try { exif = this._parseExifDate(await f.slice(0, 262144).arrayBuffer()); } catch (e) { exif = null; }
        rows.push({ file: f, name: f.name, lastModified: f.lastModified, exif, excluded: false, is360: null, w: 0, h: 0, thetaSignal: (exif ? this._isThetaSignal(exif.make, exif.model) : false) || this._isThetaFilename(f.name) });
      }
      this._rows = this._sortRows(rows);
      if (status) status.textContent = imgFiles.length + "장 · 시간순 정렬 완료";
      this._renderTable();
      // 360 판별(비동기, App._detect360 재사용) — 완료되는 대로 표를 다시 그려 채운다
      this._rows.forEach((r) => {
        if (typeof App === "undefined" || !App._detect360) return;
        App._detect360(r.file, (is360, w, h) => { r.is360 = is360; r.w = w; r.h = h; this._renderTable(); });
      });
    },

    _moveRow(idx, dir) {
      const j = idx + dir;
      if (idx < 0 || idx >= this._rows.length || j < 0 || j >= this._rows.length) return;
      const tmp = this._rows[idx]; this._rows[idx] = this._rows[j]; this._rows[j] = tmp;
      this._renderTable();
    },

    _toggleExclude(idx) {
      const r = this._rows[idx];
      if (!r) return;
      r.excluded = !r.excluded;
      this._renderTable();
    },

    _renderTable() {
      const host = document.getElementById("photobatch-table-body");
      if (!host) return;
      const page = State.pdfPage || 1;
      const pinList = this._pinList(State.pins, page, this._range.series);
      const { matches, leftoverPins, leftoverRows } = this._buildMatches(pinList, this._rows, this._range);
      const matchByRow = new Map();
      matches.forEach((m) => matchByRow.set(m.row, m));

      let html = "";
      this._rows.forEach((r, idx) => {
        const m = matchByRow.get(r);
        const pinNo = m ? m.no : (r.excluded ? "제외" : "범위 밖");
        const hasExisting = m ? PinSeries.hasContent(m.pin) : false;
        if (r.bigGapBefore) {
          html += '<tr class="pb-gap-row"><td colspan="7">⏱ 간격 ' + Math.round(r.gapMs / 60000) + '분 — 구역 경계 추정</td></tr>';
        }
        html += '<tr class="pb-row' + (r.excluded ? " pb-excluded" : "") + '" data-idx="' + idx + '">'
          + '<td class="pb-c-no">' + this._esc(pinNo) + '</td>'
          + '<td class="pb-c-file" title="' + this._esc(r.name) + '">' + this._esc(r.name) + '</td>'
          + '<td class="pb-c-time">' + this._esc(r.timeLabel || "-") + '</td>'
          + '<td class="pb-c-src">' + this._esc(r.timeSource || "-") + '</td>'
          + '<td class="pb-c-360">' + (r.is360 === true ? "360°" : (r.is360 === false ? "일반" : "…")) + '</td>'
          + '<td class="pb-c-exist">' + (hasExisting ? "기존있음" : "-") + '</td>'
          + '<td class="pb-c-act">'
            + '<button type="button" class="pb-mini" data-act="up" data-idx="' + idx + '" title="위로" aria-label="위로">↑</button>'
            + '<button type="button" class="pb-mini" data-act="down" data-idx="' + idx + '" title="아래로" aria-label="아래로">↓</button>'
            + '<label class="pb-excl"><input type="checkbox" data-act="excl" data-idx="' + idx + '"' + (r.excluded ? " checked" : "") + ' /> 제외</label>'
            + '<span class="pb-status" id="pb-status-' + idx + '"></span>'
          + '</td>'
          + '</tr>';
      });
      host.innerHTML = html || '<tr><td colspan="7" class="pb-empty">폴더를 선택하세요</td></tr>';

      const warnEl = document.getElementById("photobatch-warn");
      if (warnEl) {
        if (leftoverPins.length || leftoverRows.length) {
          warnEl.classList.remove("hidden");
          warnEl.textContent = "⚠ 개수 불일치 — " + (leftoverPins.length ? "핀 " + leftoverPins.length + "개 남음 " : "") + (leftoverRows.length ? "사진 " + leftoverRows.length + "장 남음" : "");
        } else { warnEl.classList.add("hidden"); warnEl.textContent = ""; }
      }
      const cntEl = document.getElementById("photobatch-count");
      if (cntEl) {
        const serLabel = (typeof PinSeries !== "undefined" && PinSeries.LABELS && PinSeries.LABELS[this._range.series]) || this._range.series;
        cntEl.textContent = matches.length + "건 매칭 예정 · [" + serLabel + " 계열] 핀 범위 " + this._range.start + "~" + this._range.end + " (전체 " + pinList.length + "개)";
      }
    },

    /** [WO 20260929 photo-time-match] run()과 시간매칭 적용(_applyTimeMatch)이 공유하는
     *  업로드 1건 단계(SoT — 두 곳에 복제하지 않는다, §10). 동작은 run()의 기존 인라인 로직과
     *  100% 동일(온라인 직접 업로드 → 실패/오프라인이면 SyncQueue.enqueue 폴백, 오프라인 바이트는
     *  그 안에서 IndexedDB "ops" 스토어에 영속돼 앱 재시작 후에도 남는다 — 05_SyncQueue.js:210-242).
     *  @param {Set<string>} [usedNames] 이 배치가 공유하는 이름 충돌 회피 집합(PhotoNaming).
     *  @returns {Promise<{status:'done'|'skip'|'fail', offline?:boolean, reason?:string}>} */
    async _uploadOneRow(pin, row, overwrite, usedNames, source) {
      if (!overwrite && PinSeries.hasContent(pin)) return { status: "skip" };
      try {
        const { dataURL, width, height } = await Cloud.resizeImage(row.file);
        const shotAt = Number.isFinite(row.sortKey) ? row.sortKey : null;
        const namesSet = usedNames || new Set();
        // [지휘자 발주 보강§3] 저장 이름 = 영역/구역이름_시각(PhotoNaming SoT) — 없으면 원본 파일명.
        const fullName = (typeof PhotoNaming !== "undefined") ? PhotoNaming.name(pin, row.name, shotAt, namesSet) : row.name;
        namesSet.add(fullName);
        const imgName = fullName.replace(/\.[^.]+$/, "");
        let uploaded = false, newImageId = null, newOpId = null;
        if (navigator.onLine) {
          try { newImageId = await Cloud.uploadImage(imgName, dataURL, width, height); uploaded = true; } catch (e) { uploaded = false; }
        }
        if (!uploaded) {
          newOpId = await SyncQueue.enqueue({ kind: "image", name: imgName, image_data: dataURL, width, height });
          if (!newOpId) throw new Error("저장공간 부족");
        }
        // [WO 20261002-gap 묶음A①] 덮어쓰기 직전, 지금 "현재" 사진을 이력에 적립(SoT — pushHistory).
        if (typeof PhotoNaming !== "undefined" && PhotoNaming.pushHistory) PhotoNaming.pushHistory(pin, source || "일괄등록");
        if (uploaded) { pin.imageId = newImageId; Cloud._cache[newImageId] = dataURL; pin.pendingOpId = null; pin.pendingSync = false; }
        else { pin.pendingOpId = newOpId; pin.pendingSync = true; Cloud._cache["op:" + newOpId] = dataURL; }
        pin.origKey = null; // 새 사진의 원본 보관 키는 아래 keepOriginal이 비동기로 채운다
        pin.imageName = imgName;
        if (row.is360) pin.is360 = true;
        // [지휘자 발주 보강§4] 표시용 메타 — 값 없는 건 세팅하지 않는다(있는 것만, 지어내지 않음).
        pin.origName = row.name;
        if (shotAt != null) { pin.shotAt = shotAt; pin.shotSrc = row.timeSource || null; }
        // [WO 20261002-gap 묶음A④] 360 원본(풀해상도) 보관 — 보기용(4096px)과 별도로 R2에 백그라운드 업로드.
        if (row.is360 && typeof SyncQueue !== "undefined" && SyncQueue.keepOriginal) {
          SyncQueue.keepOriginal(pin, row.file, uploaded ? newImageId : null);
        }
        return { status: "done", offline: !uploaded };
      } catch (e) {
        return { status: "fail", reason: (e && e.message) || String(e) };
      }
    },

    _setRowStatus(row, text) {
      const idx = this._rows.indexOf(row);
      if (idx < 0) return;
      const el = document.getElementById("pb-status-" + idx);
      if (el) el.textContent = text;
    },

    _updateProgress(total, done) {
      const el = document.getElementById("photobatch-progress");
      if (el) el.textContent = done + " / " + total;
    },

    /** 실행: 순차 업로드(동시 3), 진행률, 실패 건 표시, 오프라인이면 SyncQueue 폴백.
     *  이미 사진 있는 핀은 기본 건너뛰기(덮어쓰기 체크 시에만 진행).
     *  🔴 자동저장 OFF 정책 — 완료 후 App._markDirty() 로 "미저장" 표시만 한다. */
    async run() {
      if (this._busy) return;
      const page = State.pdfPage || 1;
      const pinList = this._pinList(State.pins, page, this._range.series);
      const { matches, leftoverPins, leftoverRows } = this._buildMatches(pinList, this._rows, this._range);
      if (!matches.length) { if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("매칭할 핀·사진이 없습니다"); return; }
      if (leftoverPins.length || leftoverRows.length) {
        const msg = (leftoverPins.length ? leftoverPins.length + "개 핀 남음 " : "") + (leftoverRows.length ? leftoverRows.length + "장 사진 남음" : "");
        if (!await Prompt.confirm("사진 일괄 매칭", "개수가 일치하지 않습니다 — " + msg + ". " + matches.length + "건만 매칭해 진행할까요?")) return;
      }
      this._busy = true;
      const runBtn = document.getElementById("btn-photobatch-run");
      if (runBtn) runBtn.disabled = true;
      const overwriteEl = document.getElementById("photobatch-overwrite");
      const overwrite = !!(overwriteEl && overwriteEl.checked);

      let done = 0, fail = 0, skip = 0;
      const queue = matches.slice();
      const usedNames = this._usedPhotoNames();
      const worker = async () => {
        while (queue.length) {
          const m = queue.shift();
          const { pin, row } = m;
          this._setRowStatus(row, "업로드 중...");
          const r = await this._uploadOneRow(pin, row, overwrite, usedNames, "일괄등록");
          if (r.status === "skip") { skip++; this._setRowStatus(row, "건너뜀(기존사진)"); }
          else if (r.status === "fail") { fail++; this._setRowStatus(row, "실패: " + r.reason); }
          else { done++; this._setRowStatus(row, r.offline ? "오프라인 저장됨" : "완료"); }
          this._updateProgress(matches.length, done + fail + skip);
        }
      };
      await Promise.all([worker(), worker(), worker()]); // 동시 3

      this._busy = false;
      if (runBtn) runBtn.disabled = false;
      try { UI.renderPinList(); UI.renderPinsOnMap(); if (typeof PinGrid !== "undefined") PinGrid.render(); } catch (e) {}
      try { App._updateSyncBadge && App._updateSyncBadge(); } catch (e) {}
      if (done) this._markUnsaved(); // 서버 자동저장 금지 — 미저장 표시 + 로컬 draft 보존만
      if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("완료 " + done + " · 건너뜀 " + skip + " · 실패 " + fail);
    },

    /* ══ [WO 20260929 photo-time-match] 시각 최근접 매칭 — DOM(미리보기→적용) ══════════
       index.html 은 다른 팀 점유라 수정하지 않는다 — 모달/입력은 이 함수들이 JS로 생성한다
       (기존 toast 호스트 생성 패턴 30_Prompt.js:21-27 과 동일 관례). 진입은 온라인 복귀 안내
       배너(32_Offline.js _showReconnectBanner "연결하기")가 PhotoBatch.openTimeMatch()를 호출한다. */

    /** 공개 진입점 — 파일선택 창을 띄운다(폴더 아님, 갤러리에서 여러 장 선택. capture 강제 금지 —
     *  요구사항 §9). series 미지정 시 현재 배치모드(SoT: State.regMode, _defaultRange()와 동일 판정). */
    openTimeMatch(range) {
      if (typeof Auth !== "undefined" && Auth.requireDesigner && !Auth.isDesigner) { Auth.requireDesigner(() => {}); return; }
      // [WO 20260930-moderole] 🔴 마스터: "체커는 사진을 등록하지 않을 거야" — 시각 자동 매칭 대상도
      // 항상 360(content) 계열만(_defaultRange() 와 동일 SoT, CHECKER 분기 제거).
      const series = (range && range.series) || "content";
      this._tm = { rows: [], series };
      this._ensureTimeMatchModal();
      // [지휘자 발주 보강] 브라우저는 폴더를 자동으로 못 찾는다(showDirectoryPicker 모바일 미지원)
      // — 파일 선택창을 열기 직전에 어디서 고르면 되는지 한 줄로 안내한다(조용히 아무 폴더나 기대 금지).
      if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("RICOH THETA 폴더에서 전체 선택 — 최근 사진부터 자동으로 찾습니다");
      const input = document.getElementById("photobatch-tm-files");
      if (input) input.click();
    },

    /** [설계메모] 인터랙티브 요소(입력/버튼/목록 호스트)는 innerHTML 문자열이 아니라
     *  document.createElement 로 만들어 바로 참조를 쥔다 — innerHTML 로 심으면 실제 브라우저에선
     *  동작하지만 id 기반 재조회에 파싱 단계가 하나 더 끼어 테스트(vm+가짜DOM, jsdom 없음)가
     *  구조를 못 읽는다. 정적 안내문 2줄만 innerHTML 을 쓴다(30_Prompt.js:21-27 과 동일 관례). */
    _ensureTimeMatchModal() {
      if (document.getElementById("photobatch-tm-modal")) return;
      const input = document.createElement("input");
      input.type = "file"; input.multiple = true; input.accept = "image/*";
      input.id = "photobatch-tm-files";
      input.style.display = "none";
      input.addEventListener("change", (e) => {
        const files = Array.from(e.target.files || []);
        e.target.value = "";
        this._onTimeMatchFilesChosen(files);
      });
      document.body.appendChild(input);

      const modal = document.createElement("div");
      modal.id = "photobatch-tm-modal";
      modal.className = "admin-gate-backdrop hidden";
      modal.setAttribute("style", "position:fixed;inset:0;z-index:9998;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;");
      modal.addEventListener("click", (e) => { if (e.target === modal) this._closeTimeMatchModal(); });

      const panel = document.createElement("div");
      panel.className = "pb-tm-panel";
      panel.setAttribute("style", "background:#fff;color:#111;max-width:640px;width:92vw;max-height:82vh;overflow:auto;border-radius:12px;padding:16px;");
      panel.innerHTML =
        '<h3 style="margin:0 0 8px;font-size:16px;">시각 최근접 360 사진 연결</h3>' +
        '<div style="font-size:12px;color:#555;margin-bottom:6px;">RICOH THETA 폴더에서 전체 선택 — 최근 사진부터 자동으로 찾습니다(파일명 R…_YYYYMMDDHHMMSS 자동 인식)</div>';

      const opts = document.createElement("div");
      opts.setAttribute("style", "display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-bottom:8px;font-size:13px;");
      const tolLabel = document.createElement("label"); tolLabel.textContent = "허용오차(분) ";
      const tolInput = document.createElement("input"); tolInput.type = "number"; tolInput.id = "photobatch-tm-tolerance"; tolInput.value = "10"; tolInput.min = "1"; tolInput.setAttribute("style", "width:56px;");
      tolLabel.appendChild(tolInput);
      const offLabel = document.createElement("label"); offLabel.textContent = "시계보정(분,±) ";
      const offInput = document.createElement("input"); offInput.type = "number"; offInput.id = "photobatch-tm-offset"; offInput.value = "0"; offInput.setAttribute("style", "width:56px;");
      offLabel.appendChild(offInput);
      const owLabel = document.createElement("label");
      const owInput = document.createElement("input"); owInput.type = "checkbox"; owInput.id = "photobatch-tm-overwrite";
      owLabel.appendChild(owInput); owLabel.appendChild(document.createTextNode(" 이미 360 있는 핀도 포함"));
      opts.appendChild(tolLabel); opts.appendChild(offLabel); opts.appendChild(owLabel);

      const list = document.createElement("div");
      list.id = "photobatch-tm-list";
      list.setAttribute("style", "font-size:13px;");
      list.textContent = "사진을 선택하세요";

      const btnBar = document.createElement("div");
      btnBar.setAttribute("style", "display:flex;justify-content:flex-end;gap:8px;margin-top:12px;");
      const cancelBtn = document.createElement("button"); cancelBtn.type = "button"; cancelBtn.id = "photobatch-tm-cancel"; cancelBtn.textContent = "취소";
      const applyBtn = document.createElement("button"); applyBtn.type = "button"; applyBtn.id = "photobatch-tm-apply"; applyBtn.textContent = "적용";
      btnBar.appendChild(cancelBtn); btnBar.appendChild(applyBtn);

      panel.appendChild(opts); panel.appendChild(list); panel.appendChild(btnBar);
      modal.appendChild(panel);
      document.body.appendChild(modal);

      cancelBtn.addEventListener("click", () => this._closeTimeMatchModal());
      applyBtn.addEventListener("click", () => this._applyTimeMatch());
      tolInput.addEventListener("input", () => this._recomputeTimeMatch());
      offInput.addEventListener("input", () => this._recomputeTimeMatch());
      owInput.addEventListener("change", () => this._recomputeTimeMatch());
    },

    /** [요구사항 §9] 모바일에서 다수 파일 선택 시 메인스레드 장시간 점유 방지 — EXIF 는 파일당
     *  선두 256KB 만 읽고(기존 _onFilesChosen 과 동일 상수, 262144B), for..of + await 로 파일마다
     *  한 번씩 이벤트 루프에 양보한다(전부 동기로 묶어 돌리지 않음 — 30장 기준 파일당 ~5~15ms 면
     *  체감 버벅임 없음, 실측치는 보고서 참조). */
    async _onTimeMatchFilesChosen(files) {
      const IMG_RE = /\.(jpe?g|png|webp)$/i;
      const imgFiles = (files || []).filter((f) => IMG_RE.test(f.name));
      if (!imgFiles.length) { if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("이미지 파일을 찾을 수 없습니다"); return; }
      // [지휘자 발주 보강2 §1] "가장 최근 파일부터 찾게 해" — EXIF 를 읽기 전에도 알 수 있는
      // 값(파일명 THETA 타임스탬프 우선, 없으면 lastModified)으로 먼저 최신순 정렬한 뒤 처리한다.
      const quickTime = (f) => {
        const fn = this._parseThetaFilenameDate(f.name);
        if (fn) return Date.parse(fn.iso);
        return Number.isFinite(f.lastModified) ? f.lastModified : -Infinity;
      };
      const ordered = imgFiles.slice().sort((a, b) => quickTime(b) - quickTime(a));
      const rows = [];
      for (const f of ordered) {
        let exif = null;
        try { exif = this._parseExifDate(await f.slice(0, 262144).arrayBuffer()); } catch (e) { exif = null; }
        rows.push({
          file: f, name: f.name, lastModified: f.lastModified, exif, excluded: false, is360: null, w: 0, h: 0,
          thetaSignal: (exif ? this._isThetaSignal(exif.make, exif.model) : false) || this._isThetaFilename(f.name)
        });
      }
      this._tm.rows = this._sortRows(rows);
      const modal = document.getElementById("photobatch-tm-modal");
      if (modal) modal.classList.remove("hidden");
      this._recomputeTimeMatch();
      this._tm.rows.forEach((r) => {
        if (typeof App === "undefined" || !App._detect360) return;
        App._detect360(r.file, (is360, w, h) => { r.is360 = is360; r.w = w; r.h = h; this._recomputeTimeMatch(); });
      });
    },

    _recomputeTimeMatch() {
      if (!this._tm) return null;
      const tolEl = document.getElementById("photobatch-tm-tolerance");
      const offEl = document.getElementById("photobatch-tm-offset");
      const owEl = document.getElementById("photobatch-tm-overwrite");
      const toleranceMin = tolEl ? (parseFloat(tolEl.value) || 10) : 10;
      const offsetMin = offEl ? (parseFloat(offEl.value) || 0) : 0;
      const includeExisting360 = !!(owEl && owEl.checked);
      const page = State.pdfPage || 1;
      const pinList = this._pinList(State.pins, page, this._tm.series);
      const result = this._buildTimeMatches(pinList, this._tm.rows, { toleranceMs: toleranceMin * 60000, offsetMin, includeExisting360 });
      this._tm.result = result;
      this._renderTimeMatchList(result);
      return result;
    },

    _renderTimeMatchList(result) {
      const host = document.getElementById("photobatch-tm-list");
      if (!host) return;
      const esc = (s) => this._esc(s);
      let html = '<table style="width:100%;border-collapse:collapse;"><thead><tr>'
        + '<th style="text-align:left;">핀</th><th style="text-align:left;">파일</th><th>Δt</th><th>상태</th>'
        + '</tr></thead><tbody>';
      (result.matches || []).forEach((m) => {
        // [지휘자 발주 보강§4-3] 미리보기도 "영역/구역 · 시각 · 원본파일명" 형식(SoT: PhotoNaming.scopeOf).
        const scope = (typeof PhotoNaming !== "undefined") ? PhotoNaming.scopeOf(m.pin) : { area: null, zone: null };
        const label = scope.area || scope.zone;
        const descParts = [];
        if (label) descParts.push(label);
        if (m.row.timeLabel) descParts.push(m.row.timeLabel);
        descParts.push("원본 " + m.row.name);
        html += '<tr><td>#' + m.no + '</td><td>' + esc(descParts.join(" · ")) + '</td><td>' + Math.round(m.dtMs / 1000) + '초</td><td>연결</td></tr>';
      });
      (result.skippedExisting || []).forEach((e) => {
        html += '<tr style="opacity:.6"><td>#' + e.no + '</td><td>-</td><td>-</td><td>기존 유지</td></tr>';
      });
      (result.unmatchedPins || []).forEach((e) => {
        html += '<tr style="opacity:.6"><td>#' + e.no + '</td><td>-</td><td>-</td><td>미연결(사진 없음/오차초과)</td></tr>';
      });
      (result.unmatchedRows || []).forEach((r) => {
        html += '<tr style="opacity:.6"><td>-</td><td>' + esc(r.name) + '</td><td>-</td><td>미연결(오차초과)</td></tr>';
      });
      (result.excluded360 || []).forEach((r) => {
        html += '<tr style="opacity:.5;color:#b91c1c;"><td>-</td><td>' + esc(r.name) + '</td><td>-</td><td>360 아님</td></tr>';
      });
      html += '</tbody></table>';
      host.innerHTML = html || "사진을 선택하세요";
    },

    /** 적용 = 기존 360 등록 경로(_uploadOneRow → resizeImage/uploadImage/SyncQueue.enqueue) 재사용. */
    async _applyTimeMatch() {
      if (!this._tm || !this._tm.result) return;
      const overwriteEl = document.getElementById("photobatch-tm-overwrite");
      const overwrite = !!(overwriteEl && overwriteEl.checked);
      const matches = this._tm.result.matches || [];
      if (!matches.length) { if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("연결할 사진이 없습니다"); return; }
      let done = 0, fail = 0, skip = 0;
      const usedNames = this._usedPhotoNames();
      for (const m of matches) {
        const r = await this._uploadOneRow(m.pin, m.row, overwrite, usedNames, "시각매칭");
        if (r.status === "skip") skip++; else if (r.status === "fail") fail++; else done++;
      }
      try { UI.renderPinList(); UI.renderPinsOnMap(); if (typeof PinGrid !== "undefined") PinGrid.render(); } catch (e) {}
      try { App._updateSyncBadge && App._updateSyncBadge(); } catch (e) {}
      if (done) this._markUnsaved();
      if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("360 사진 연결 완료 " + done + " · 건너뜀 " + skip + " · 실패 " + fail);
      this._closeTimeMatchModal();
    },

    _closeTimeMatchModal() {
      const modal = document.getElementById("photobatch-tm-modal");
      if (modal) modal.classList.add("hidden");
    },

    /* ══ [WO 20261001-autophoto2] 360 핀 생성 즉시 자동 사진연결(마스터 재지시) ══════════
       마스터: "클릭하고 포인트가 생기면 바로 사진을 등록하게 해야지. 모바일에서는 360
       모드에서는 해당 경로의 사진이 가장 근래에 생성된 걸 추천 등록하라고." — 라이브 재현
       (지휘자 b8cd1f2a, 2026-10-01)에서 ±10분 허용오차 기반 자동매칭(WO 20260930-autophoto)이
       실사용 핀 8개 전부 미연결로 FAIL. 설계를 바꾼다:
       ① 클릭마다 **매번** 선택창을 연다(세션 후보 재사용·스킵 금지 — "새로 찍은 사진이 있다").
       ② 허용오차로 탈락시키지 않는다 — 고른 파일 중 "가장 최근 생성"(이미 다른 핀에 쓴 파일은
          건너뜀) 1장을 그대로 등록한다. 핀 생성시각과 크게(≥30분) 다르면 등록은 하되 사실만
          토스트로 알린다.
       기존 시각매칭 정본(_sortRows/_uploadOneRow/PhotoNaming)은 그대로 재사용 — 새 파싱/정렬
       로직은 만들지 않는다(§10 SoT). _tm(수동 openTimeMatch)/_buildTimeMatches(허용오차 그리디
       매칭)는 이 자동연결 경로가 더는 쓰지 않지만, 수동 시각매칭 모달(openTimeMatch/run)은
       그대로 둔다(건드리지 않음). */
    _autoRows: [],          // [레거시] 더는 채워지지 않음 — _autoRowsRemaining()이 항상 0을 반환해 기존 "대기 N장" 힌트가 자연히 꺼진다(UI 변경 없음).
    _pendingAutoPin: null,  // 파일선택창이 열려 있는 동안 기다리는 핀(선택 완료 후 매칭)

    /** 세션 기억 초기화 — [사진 다시 선택] 버튼(index.html #btn-photo-reselect). */
    resetAutoSession() {
      this._autoRows = [];
      this._pendingAutoPin = null;
      if (typeof App !== "undefined" && App._updateCheckboardQuickStatus) App._updateCheckboardQuickStatus(State.pdfPage || 1);
      if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("사진 목록을 비웠습니다 — 다음 360 핀을 찍으면 다시 선택합니다");
    },

    /** 남아있는(아직 연결 안 된) 360 후보 사진 수 — place-hint 안내문에만 쓴다(부작용 없음). */
    _autoRowsRemaining() {
      return (this._autoRows || []).filter((r) => !r.excluded && r.is360 === true).length;
    },

    _ensureAutoInput() {
      if (document.getElementById("photobatch-auto-files")) return;
      const input = document.createElement("input");
      input.type = "file"; input.multiple = true; input.accept = "image/*";
      input.id = "photobatch-auto-files";
      input.style.display = "none";
      input.addEventListener("change", (e) => {
        const files = Array.from(e.target.files || []);
        e.target.value = "";
        this._onAutoFilesChosen(files);
      });
      document.body.appendChild(input);
    },

    /** [핵심 API] 360(photo) 모드 핀 생성 직후 호출(_handlePlaceClick, 같은 동기 구간).
     *  CHECKER 계열은 대상이 아니다(00c18fd 차단 유지, SoT: PinSeries.seriesOf). [WO
     *  20261001-autophoto2] 마스터: "매번 연다" — 세션 후보가 있어도 다시 묻지 않고 건너뛰는
     *  옛 동작을 버리고, 클릭마다 항상 다중 파일선택창을 연다(새로 찍은 사진을 매번 반영하려면
     *  재사용에 의존할 수 없다). 호출부(_placeCheckboardPin)가 동기이므로 여기도 동기 호출만
     *  한다(모바일 user-activation 유지 — await 금지, 기존 _openPinMediaPicker와 동일 관례). */
    autoConnectPin(pin) {
      if (!pin) return;
      if (typeof PinSeries !== "undefined" && PinSeries.seriesOf && PinSeries.seriesOf(pin) === "checkboard") return;
      this._pendingAutoPin = pin;
      this._ensureAutoInput();
      if (typeof Prompt !== "undefined" && Prompt.toast)
        Prompt.toast("RICOH THETA 폴더(/내장 저장공간/Pictures/RICOH THETA)에서 360 사진을 선택하세요 — 최근 파일부터");
      const input = document.getElementById("photobatch-auto-files");
      if (input) input.click();
    },

    /** 선택된 파일들을 시각순 정렬 + 360 판정까지 마친 뒤, 기다리던 핀에 바로 최신 1장을
     *  등록한다(_autoPickAndConnect). 취소(파일 0개)하면 대기 핀은 그대로 번호만 가진 채
     *  남는다(조용히 삭제 금지, 기존 _openPinMediaPicker 관례와 동일). [WO 20261001-autophoto2]
     *  더는 세션(_autoRows)에 누적하지 않는다 — 이번 선택 안에서만 최신·미사용 1장을 고른다. */
    async _onAutoFilesChosen(files) {
      const pin = this._pendingAutoPin;
      this._pendingAutoPin = null;
      const sorted = await this.buildAutoRows(files);
      if (!sorted.length) {
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("이미지 파일을 찾을 수 없습니다");
        return;
      }
      if (pin) await this._autoPickAndConnect(pin, sorted);
    },

    /** [WO 20261002-allmenu §8] 🔴 SoT — "최근 360 사진 추천" 의 행 만들기(EXIF 촬영시각 → THETA 파일명 → mtime 정렬 +
     *  360 판정)를 한 곳으로 뽑았다. 자동연결(_onAutoFilesChosen)과 THETA 공유/복귀 흐름(ThetaIntake)이 같은 함수를 쓴다.
     *  @returns {Promise<Array>} 시각 오름차순 행(_sortRows 정본). 최신 = recentFirst360(rows)[0]. */
    async buildAutoRows(files) {
      const IMG_RE = /\.(jpe?g|png|webp)$/i;
      const imgFiles = (files || []).filter((f) => IMG_RE.test(f.name));
      if (!imgFiles.length) return [];
      const rows = [];
      for (const f of imgFiles) {
        let exif = null;
        try { exif = this._parseExifDate(await f.slice(0, 262144).arrayBuffer()); } catch (e) { exif = null; }
        rows.push({
          file: f, name: f.name, lastModified: f.lastModified, exif, excluded: false, is360: null, w: 0, h: 0,
          thetaSignal: (exif ? this._isThetaSignal(exif.make, exif.model) : false) || this._isThetaFilename(f.name)
        });
      }
      const sorted = this._sortRows(rows); // 시각 오름차순(기존 정본 재사용) — 최신 선택은 _autoPickAndConnect 가 sortKey 최댓값으로 고른다.
      await Promise.all(sorted.map((r) => new Promise((resolve) => {
        if (typeof App === "undefined" || !App._detect360) { resolve(); return; }
        App._detect360(r.file, (is360, w, h) => { r.is360 = is360; r.w = w; r.h = h; resolve(); });
      })));
      return sorted;
    },

    /** 360 판정 행만, 촬영시각 최신순(_autoPickAndConnect 의 "최신 = sortKey 최댓값" 규칙과 동일). */
    recentFirst360(rows) {
      const key = (r) => (Number.isFinite(r.sortKey) ? r.sortKey : -Infinity);
      return (rows || []).filter((r) => r && !r.excluded && r.is360 === true).slice().sort((a, b) => key(b) - key(a));
    },

    /** 핀이 이미 가진 사진의 원본 파일명 집합(pin.origName, _uploadOneRow 가 등록 시 남김) —
     *  "이미 다른 핀에 연결된 사진은 건너뛴다"의 SoT(새 상태를 만들지 않고 기존 필드 재사용). */
    _usedOrigNames() {
      const used = new Set();
      ((typeof State !== "undefined" && State.pins) || []).forEach((p) => { if (p && p.origName) used.add(p.origName); });
      return used;
    },

    /** [WO 20261001-autophoto2 핵심] 마스터: "허용오차로 탈락시키지 않는다 — 가장 최근 생성된
     *  사진을 추천 등록". 이번에 고른 파일들 중 360 판정(is360===true, App._detect360 정본) +
     *  아직 다른 핀에 안 쓰인 것(_usedOrigNames) 중 촬영시각(sortKey, _sortRows 정본)이 가장
     *  큰 1장을 그 핀에 바로 등록한다. 후보가 없으면(전부 360 아님 또는 전부 이미 사용) 조용히
     *  넘어가지 않고 토스트로 사실을 알린다(가짜 연결 금지). 핀 생성시각과 ≥30분 차이나도
     *  등록 자체는 거부하지 않는다 — 토스트에 사실만 덧붙인다. */
    async _autoPickAndConnect(pin, rows) {
      const BIG_GAP_WARN_MS = 30 * 60 * 1000;
      const used = this._usedOrigNames();
      const candidates = (rows || []).filter((r) => !r.excluded && r.is360 === true && !used.has(r.name));
      if (!candidates.length) {
        const anyNon360 = (rows || []).some((r) => r.is360 !== true);
        if (typeof Prompt !== "undefined" && Prompt.toast)
          Prompt.toast(anyNon360 ? "선택한 사진 중 360 사진이 없습니다 — [다른 사진]" : "선택한 사진이 모두 이미 다른 핀에 연결돼 있습니다 — [다른 사진]",
            2200, { action: { label: "다른 사진", onClick: () => this.autoConnectPin(pin) } });
        return;
      }
      let best = candidates[0];
      candidates.forEach((r) => { if ((Number.isFinite(r.sortKey) ? r.sortKey : -Infinity) > (Number.isFinite(best.sortKey) ? best.sortKey : -Infinity)) best = r; });
      const usedNames = this._usedPhotoNames();
      const r = await this._uploadOneRow(pin, best, false, usedNames, "자동연결");
      if (r.status === "done") {
        try { UI.renderPinList(); UI.renderPinsOnMap(); if (typeof PinGrid !== "undefined") PinGrid.render(); } catch (e) {}
        try { App._updateSyncBadge && App._updateSyncBadge(); } catch (e) {}
        this._markUnsaved();
        if (typeof App !== "undefined" && App._updateCheckboardQuickStatus) App._updateCheckboardQuickStatus(State.pdfPage || 1);
        const pinT = this._pinTimeMs(pin);
        const dtMs = (Number.isFinite(pinT) && Number.isFinite(best.sortKey)) ? Math.abs(pinT - best.sortKey) : null;
        const hhmm = best.timeLabel && best.timeLabel.length >= 16 ? best.timeLabel.slice(11, 16) : "";
        let msg = "P" + (pin.label || "") + " ← " + best.name + (hhmm ? (" (" + hhmm + " 촬영)") : "") + " 등록" + (r.offline ? "(오프라인 저장됨)" : "");
        if (dtMs != null && dtMs >= BIG_GAP_WARN_MS) msg += " · 핀 생성 " + Math.round(dtMs / 60000) + "분 전 사진";
        msg += " · [다른 사진]";
        if (typeof Prompt !== "undefined" && Prompt.toast)
          Prompt.toast(msg, 4000, { action: { label: "다른 사진", onClick: () => this.autoConnectPin(pin) } });
      } else if (r.status === "fail") {
        if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("360 사진 연결 실패: " + r.reason);
      }
    }
  };
