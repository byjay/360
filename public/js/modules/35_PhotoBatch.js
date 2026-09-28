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
  const PhotoBatch = {
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

    /** TIFF 헤더부터 IFD0 + ExifIFD 를 훑어 촬영시각 태그를 찾는다 */
    _parseExifIfd(b, tiffStart, end) {
      if (tiffStart + 8 > end) return null;
      const le = this._asciiAt(b, tiffStart, 2) === "II";
      const u16 = (o) => b.getUint16(o, le);
      const u32 = (o) => b.getUint32(o, le);
      if (u16(tiffStart + 2) !== 42) return null;
      let best = null;
      const walk = (ifdOff, depth) => {
        if (depth > 2 || (best && best.tag === "DateTimeOriginal")) return;
        const at = tiffStart + ifdOff;
        if (at + 2 > end) return;
        const n = u16(at);
        for (let k = 0; k < n; k++) {
          const e = at + 2 + k * 12;
          if (e + 12 > end) return;
          const tag = u16(e), type = u16(e + 2), cnt = u32(e + 4);
          const valOff = (type === 2 && cnt > 4) ? tiffStart + u32(e + 8) : e + 8;
          if (tag === 0x8769) { walk(u32(e + 8), depth + 1); continue; } // ExifIFD 포인터
          if ((tag === 0x9003 || tag === 0x9004 || tag === 0x0132) && type === 2 && valOff + 19 <= end) {
            const s = this._asciiAt(b, valOff, 19); // "YYYY:MM:DD HH:MM:SS"
            const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(s);
            if (m) {
              const iso = m[1] + "-" + m[2] + "-" + m[3] + "T" + m[4] + ":" + m[5] + ":" + m[6];
              if (tag === 0x9003) { best = { iso, tag: "DateTimeOriginal" }; return; }
              if (!best) best = { iso, tag: tag === 0x9004 ? "DateTimeDigitized" : "DateTime" };
            }
          }
        }
      };
      walk(u32(tiffStart + 4), 0);
      return best;
    },

    /** 정렬 우선순위(EXIF→mtime→파일명)에 따라 sortKey/timeSource/timeLabel 을 부여하고
     *  정렬한 "새" 배열을 반환한다(원본 불변). 큰 시간 간격(10분↑) 지점엔 bigGapBefore 를 단다.
     *  순수 함수 — 테스트가 직접 호출한다. */
    _sortRows(rows) {
      const withKey = (rows || []).map((r) => {
        let sortKey, timeSource, timeLabel;
        if (r.exif && r.exif.iso) {
          sortKey = Date.parse(r.exif.iso);
          timeSource = "EXIF " + r.exif.tag;
          timeLabel = r.exif.iso.replace("T", " ");
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
      const series = (typeof State !== "undefined" && State.checkboard) ? "checkboard" : "content";
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
        rows.push({ file: f, name: f.name, lastModified: f.lastModified, exif, excluded: false, is360: null, w: 0, h: 0 });
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
      const worker = async () => {
        while (queue.length) {
          const m = queue.shift();
          const { pin, row } = m;
          if (!overwrite && PinSeries.hasContent(pin)) { skip++; this._setRowStatus(row, "건너뜀(기존사진)"); this._updateProgress(matches.length, done + fail + skip); continue; }
          try {
            this._setRowStatus(row, "업로드 중...");
            const { dataURL, width, height } = await Cloud.resizeImage(row.file);
            const imgName = row.name.replace(/\.[^.]+$/, "");
            let uploaded = false;
            if (navigator.onLine) {
              try { const imageId = await Cloud.uploadImage(imgName, dataURL, width, height); pin.imageId = imageId; Cloud._cache[imageId] = dataURL; uploaded = true; } catch (e) { uploaded = false; }
            }
            if (!uploaded) {
              const opId = await SyncQueue.enqueue({ kind: "image", name: imgName, image_data: dataURL, width, height });
              if (opId) { pin.pendingOpId = opId; pin.pendingSync = true; Cloud._cache["op:" + opId] = dataURL; }
              else throw new Error("저장공간 부족");
            }
            pin.imageName = imgName;
            if (row.is360) pin.is360 = true;
            done++; this._setRowStatus(row, uploaded ? "완료" : "오프라인 저장됨");
          } catch (e) {
            fail++; this._setRowStatus(row, "실패: " + (e.message || e));
          }
          this._updateProgress(matches.length, done + fail + skip);
        }
      };
      await Promise.all([worker(), worker(), worker()]); // 동시 3

      this._busy = false;
      if (runBtn) runBtn.disabled = false;
      try { UI.renderPinList(); UI.renderPinsOnMap(); if (typeof PinGrid !== "undefined") PinGrid.render(); } catch (e) {}
      try { App._updateSyncBadge && App._updateSyncBadge(); } catch (e) {}
      if (done) { try { App._markDirty && App._markDirty(); } catch (e) {} } // 자동저장 호출 금지 — 미저장 표시만
      if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast("완료 " + done + " · 건너뜀 " + skip + " · 실패 " + fail);
    }
  };
