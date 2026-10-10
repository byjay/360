  /* ══════════════════════════════════════════════════════════════
     DELIVERY — 선주·감독관 납품 보고서 + 오프라인 묶음 (WO 20261010-delivery 요구 A · 경쟁조사 후보 6)
     ────────────────────────────────────────────────────────────────
     출력 2종(새 라이브러리 0):
       ① 인쇄 보고서 — 새 창 HTML + @page(A4·머리말·쪽번호) → 브라우저 "PDF로 저장"
       ② 묶음 zip   — 같은 HTML(사진은 상대경로) + 축소 사진/위치도 JPEG (55_ZipStore, STORE)
     구성: 표지(프로젝트·선명/호선·방선 회차·작성자·범위) → 요약(구역별 핀·촬영 현황·결함 상태·지난 기한)
           → 구역별 핀 위치도(도면 축소 + 번호 겹쳐 그림, 360=원형 P번호 / CHECKER=사각 번호) → 핀별 칸.
     🔴 SoT 재사용(새 판정 0):
        번호 = PinSeries.numbers/formatNo(도면 표시와 같은 번호) · 구역 범위 = Projects.pinsForDeck(crop 창)
        촬영 현황 = Coverage.classify/summarize/staleDays · 사진 이력 = TimeLapse._normalize(EXIF shotAt SoT)
        결함 상태·심각도·종류 문구/색 = Requests.STATUS/KIND/*_STYLE · 미완/기한 지남 = Requests._isOpen/_isOverdue
        프로젝트 정보 = ProjectInfo._normalize(선명·호선·일정) · 사진 = Cloud.fetchImage → Auth.r2(토큰 규칙)
     🔴 권한: 데이터는 전부 서버 읽기 라우트(/tables/deployments/:id · /api/notes · /tables/pano_images/:id)로만
        받는다 — 서버 canReadDepRow/maskFor 가 판정(SoT). 403 구역은 지어내지 않고 표지에 "권한 밖 제외"로 명시.
        열람자 역할이면 클라이언트도 작성자·담당자 이메일을 한 번 더 가린다(서버 maskEmailsIn 과 같은 규칙).
     🔴 메모리: 사진은 정면(가로 중앙 120°×세로 90°) 크롭 640×480 JPEG, 위치도는 긴 변 1600px 상한.
        Cloud._cache 에 원본이 새로 쌓이지 않게 보고서가 불러온 원본은 끝나면 캐시에서 뺀다.
     순수 함수(테스트 대상): visitOf · sections · buildModel · placeLabels · html · maskEmails.
  ══════════════════════════════════════════════════════════════ */
  const Delivery = {
    THUMB_W: 640,
    THUMB_H: 480,
    MAP_MAX: 1600,
    JPEG_Q: 0.82,
    CONC: 3,
    MARK: {
      content:    { fill: "#1d4ed8", text: "#ffffff", shape: "circle", label: "360 사진 위치 — 원형·P번호" },   // 6.7:1
      checkboard: { fill: "#7c2d12", text: "#ffffff", shape: "square", label: "CHECKER 점검 번호 — 사각형" }    // 10.9:1
    },
    EMAIL_RE: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,

    /* ─────────────── 순수 함수 ─────────────── */

    /** 서버 maskEmailsIn 과 같은 규칙(첫 글자 + ***) */
    maskEmails(v) { return typeof v === "string" ? v.replace(this.EMAIL_RE, (m) => m.charAt(0) + "***") : v; },

    _pad(n) { return String(n).padStart(2, "0"); },
    localDate(ms) {
      if (!Number.isFinite(ms)) return "";
      const d = new Date(ms);
      return d.getFullYear() + "-" + this._pad(d.getMonth() + 1) + "-" + this._pad(d.getDate());
    },
    localDateTime(ms) {
      if (!Number.isFinite(ms)) return "";
      const d = new Date(ms);
      return this.localDate(ms) + " " + this._pad(d.getHours()) + ":" + this._pad(d.getMinutes());
    },

    /** 방선 회차 — 프로젝트 일정 중 구분에 "방선"이 든 항목(날짜순). 오늘까지 지난 것 중 마지막 = 이번 회차.
     *  아직 하나도 안 지났으면 다음 예정 1회차(upcoming:true). 없으면 null(지어내지 않음). */
    visitOf(schedule, todayKey) {
      const items = (Array.isArray(schedule) ? schedule : [])
        .filter((s) => s && typeof s.date === "string" && s.date && /방선/.test(String(s.kind || "")))
        .slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      if (!items.length) return null;
      const past = items.filter((s) => s.date <= todayKey);
      const it = past.length ? past[past.length - 1] : items[0];
      return { no: past.length ? past.length : 1, total: items.length, date: it.date, kind: it.kind || "방선", content: it.content || "", upcoming: !past.length };
    },

    _live(arr) { return (Array.isArray(arr) ? arr : []).filter((o) => o && !o._deleted); },
    _hasCrop(d) { return !!(d && d.crop && d.crop.w > 0 && d.crop.h > 0); },
    _inDeck(pin, deck) {
      if (!this._hasCrop(deck)) return true;
      return Projects.pinsForDeck([pin], deck).length === 1;   // SoT — crop 창 판정 한 곳
    },

    /** 구역(deck) 단위 묶음 — 핀 하나는 한 구역에만 들어간다(중복 집계 금지).
     *  같은 배포본을 여러 구역이 공유하면(창 방식 crop) 가장 좁은 crop 구역이 우선, crop 없는 구역이 나머지를 받는다.
     *  같은 배포본의 하위 구역(영역)은 "영역" 이름으로만 붙는다. 어떤 구역에도 안 드는 핀은 "구역 밖"으로 정직하게 남긴다.
     *  decks: 이 배포본들을 가리키는 구역 목록 · deps: { depId: { pins, zones, title } } · allDecks: 부모 이름 조회용 */
    sections(decks, deps, allDecks) {
      const all = Array.isArray(allDecks) ? allDecks : (decks || []);
      const list = (decks || []).filter((d) => d && d.deployment_id != null && deps[String(d.deployment_id)]);
      const depIds = [];
      list.forEach((d) => { const k = String(d.deployment_id); if (depIds.indexOf(k) < 0) depIds.push(k); });
      Object.keys(deps || {}).forEach((k) => { if (depIds.indexOf(k) < 0) depIds.push(k); });
      const area = (d) => (this._hasCrop(d) ? d.crop.w * d.crop.h : Infinity);
      const byArea = (arr) => arr.map((d, i) => ({ d, i })).sort((a, b) => (area(a.d) - area(b.d)) || (a.i - b.i)).map((o) => o.d);
      const nameOf = (d) => {
        if (!d) return "";
        const p = d.parent_id != null ? all.find((x) => x && String(x.id) === String(d.parent_id)) : null;
        return p ? (p.name || "") + " › " + (d.name || "") : (d.name || "");
      };
      const out = [];
      depIds.forEach((depId) => {
        const dep = deps[depId];
        const pins = this._live(dep.pins);
        const zones = this._live(dep.zones);
        const ds = list.filter((d) => String(d.deployment_id) === depId);
        const isChild = (d) => d.parent_id != null && ds.some((x) => String(x.id) === String(d.parent_id));
        const owners = byArea(ds.filter((d) => !isChild(d)));
        const children = byArea(ds.filter(isChild));
        const groups = new Map();
        const groupOf = (owner) => {
          const key = depId + "|" + (owner ? String(owner.id) : "-");
          if (!groups.has(key)) {
            groups.set(key, {
              key, depId, deck: owner || null,
              title: owner ? nameOf(owner) : ((dep.title || "도면") + (ds.length ? " — 구역 밖" : "")),
              crop: owner && this._hasCrop(owner) ? owner.crop : null,
              cropPage: owner && this._hasCrop(owner) ? (owner.page || 1) : null,
              order: owner ? list.indexOf(owner) : 1e9,
              items: [], allPins: pins
            });
          }
          return groups.get(key);
        };
        owners.forEach((o) => groupOf(o));   // 핀 0개 구역도 요약에 0으로 나온다(누락 탐지)
        pins.forEach((pin) => {
          const owner = owners.find((d) => this._inDeck(pin, d)) || null;
          const sub = children.find((d) => (!owner || String(d.parent_id) === String(owner.id)) && this._inDeck(pin, d)) || null;
          const zone = zones.find((z) => z && Array.isArray(z.pinIds) && z.pinIds.indexOf(pin.id) !== -1) || null;
          groupOf(owner).items.push({ pin, area: sub ? (sub.name || "") : (zone && zone.label ? String(zone.label) : "") });
        });
        groups.forEach((g) => out.push(g));
      });
      return out.sort((a, b) => a.order - b.order);
    },

    _sortShots(shots) {
      const arr = (shots || []).slice();
      if (arr.length > 1 && arr.every((s) => Number.isFinite(Number(s.capturedAt)) && Number(s.capturedAt) > 0)) {
        return arr.map((s, i) => ({ s, i })).sort((a, b) => (Number(a.s.capturedAt) - Number(b.s.capturedAt)) || (a.i - b.i)).map((o) => o.s);
      }
      return arr;   // 시각이 빠진 시점이 있으면 기록 순서(이력 → 현재)를 그대로 — 지어내지 않음
    },

    /** 보고서 모델(순수). input = { project, info, scope, scopeLabel, author, role, now, staleDays, sections, notes, skipped } */
    buildModel(input) {
      const I = input || {};
      const now = Number.isFinite(I.now) ? I.now : 0;
      const viewer = I.role === "viewer";
      const mask = (v) => (viewer ? this.maskEmails(v) : v);
      const info = I.info || {};
      const days = Number.isFinite(I.staleDays) ? I.staleDays : Coverage.DEFAULT_DAYS;
      const notes = (I.notes || []).filter((n) => n && n.kind !== "reply");
      const pinsOut = [];
      const sections = (I.sections || []).map((sec, si) => {
        const pageNos = new Map();
        const numOf = (pin) => {
          const pg = pin.page || 1;
          if (!pageNos.has(pg)) pageNos.set(pg, PinSeries.numbers(sec.allPins, pg));
          return pageNos.get(pg).get(pin.id) || { no: null, series: PinSeries.seriesOf(pin) };
        };
        const pagesMap = new Map();
        const secPins = [];
        sec.items.forEach((it) => {
          const pin = it.pin;
          const n = numOf(pin);
          const series = n.series || PinSeries.seriesOf(pin);
          const noText = n.no != null ? PinSeries.formatNo(n.no, series) : "?";
          const key = "s" + si + "-" + pinsOut.length;
          const pg = pin.page || 1;
          if (!pagesMap.has(pg)) pagesMap.set(pg, []);
          pagesMap.get(pg).push({ key, noText, series, x: Number(pin.x), y: Number(pin.y) });
          let photos = [];
          if (series === "content") {
            const shots = this._sortShots(TimeLapse._normalize(pin) || []);
            const pick = shots.length >= 2 ? [["before", shots[0]], ["after", shots[shots.length - 1]]] : (shots.length ? [["current", shots[0]]] : []);
            photos = pick.map(([role, s]) => ({
              key: key + "-" + role, role, imageId: s.imageId || null, imageUrl: s.imageUrl || null,
              pending: !s.imageId && !s.imageUrl && !!s.pendingOpId, video: !!s.isVideo,
              at: Number.isFinite(Number(s.capturedAt)) && Number(s.capturedAt) > 0 ? Number(s.capturedAt) : null,
              label: s.label || ""
            }));
          }
          const pinNotes = notes.filter((nn) => String(nn.pin_id) === String(pin.id) && (nn.deployment_id == null || String(nn.deployment_id) === String(sec.depId)))
            .map((nn) => ({
              kind: nn.kind || "note", kindLabel: Requests.KIND[nn.kind || "note"] || String(nn.kind || ""),
              body: String(nn.body || ""), status: nn.status || "", statusLabel: Requests.STATUS[nn.status] || String(nn.status || ""),
              severity: nn.severity || "", due: Number.isFinite(Number(nn.due_at)) && nn.due_at ? Number(nn.due_at) : null,
              overdue: !!Requests._isOverdue(nn, now), open: !!Requests._isOpen(nn),
              assignee: mask(nn.assignee || ""), author: mask(nn.author || ""), created: nn.created_at || null
            }));
          const gps = pin.gps && pin.gps.lat != null && pin.gps.lng != null ? { lat: pin.gps.lat, lng: pin.gps.lng, acc: pin.gps.acc != null ? pin.gps.acc : null } : null;
          const entry = {
            key, section: sec.title, sectionKey: sec.key, area: it.area || "", noText, series,
            seriesLabel: series === "checkboard" ? "CHECKER" : "360", label: pin.label != null ? String(pin.label) : "",
            page: pg, x: Number(pin.x), y: Number(pin.y),
            shotAt: Number.isFinite(pin.shotAt) ? pin.shotAt : null, shotSrc: pin.shotSrc || "",
            cov: Coverage.isTarget(pin) ? Coverage.classify(pin, now, days) : null,
            gps, photos, notes: pinNotes, author: mask(pin.author || "")
          };
          pinsOut.push(entry); secPins.push(entry);
        });
        const cov = Coverage.summarize(sec.items.map((it) => it.pin), now, days);
        const pages = Array.from(pagesMap.keys()).sort((a, b) => a - b).map((pg) => ({ page: pg, key: "m" + si + "-p" + pg, marks: pagesMap.get(pg) }));
        return {
          key: sec.key, title: sec.title, depId: sec.depId, crop: sec.crop, cropPage: sec.cropPage, pages,
          counts: {
            total: secPins.length,
            content: secPins.filter((p) => p.series === "content").length,
            checker: secPins.filter((p) => p.series === "checkboard").length,
            cov, openNotes: secPins.reduce((a, p) => a + p.notes.filter((x) => x.open).length, 0)
          }
        };
      });
      const allNotes = [];
      pinsOut.forEach((p) => p.notes.forEach((n) => allNotes.push({ pin: p, n })));
      const defects = { open: 0, progress: 0, done: 0, verified: 0, other: 0 };
      allNotes.filter((o) => o.n.kind === "note").forEach((o) => { if (defects[o.n.status] != null && o.n.status !== "other") defects[o.n.status]++; else defects.other++; });
      const requestsOpen = allNotes.filter((o) => o.n.kind !== "note" && o.n.open).length;
      const overdue = allNotes.filter((o) => o.n.overdue).sort((a, b) => a.n.due - b.n.due).map((o) => ({
        noText: o.pin.noText, section: o.pin.section, kindLabel: o.n.kindLabel, body: o.n.body, due: o.n.due,
        statusLabel: o.n.statusLabel, assignee: o.n.assignee, severity: o.n.severity
      }));
      const todayKey = this.localDate(now);
      const cov = { none: 0, stale: 0, fresh: 0, unknown: 0, total: 0 };
      sections.forEach((s) => Object.keys(cov).forEach((k) => { cov[k] += s.counts.cov[k] || 0; }));
      return {
        cover: {
          project: (I.project && I.project.name) || "", vessel: info.vessel || "", hull: info.hull || "",
          visit: this.visitOf(info.schedule, todayKey), author: I.author || "", createdAt: this.localDateTime(now), date: todayKey,
          scopeLabel: I.scopeLabel || "", sectionCount: sections.length, pinCount: pinsOut.length,
          content: pinsOut.filter((p) => p.series === "content").length, checker: pinsOut.filter((p) => p.series === "checkboard").length,
          skipped: (I.skipped || []).slice(), staleDays: days, masked: viewer
        },
        sections, pins: pinsOut,
        summary: { defects, requestsOpen, overdue, cov }
      };
    },

    /** 번호표 겹침 재배치(순수) — 원래 점을 지키되 겹치면 링 위로 밀고 지시선을 단다.
     *  pts: [{x,y}] (px) · r: 반지름 · 반환: [{x,y,moved}] (같은 순서) */
    placeLabels(pts, r, w, h) {
      const placed = [];
      const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
      const hit = (x, y) => placed.some((p) => Math.hypot(p.x - x, p.y - y) < r * 2.1);
      return (pts || []).map((pt) => {
        let best = { x: clamp(pt.x, r, w - r), y: clamp(pt.y, r, h - r), moved: false };
        if (hit(best.x, best.y)) {
          let found = null;
          for (let ring = 1; ring <= 6 && !found; ring++) {
            const dist = r * 2.4 * ring;
            for (let k = 0; k < 12 && !found; k++) {
              const a = (Math.PI * 2 * k) / 12 - Math.PI / 2;
              const x = clamp(pt.x + Math.cos(a) * dist, r, w - r), y = clamp(pt.y + Math.sin(a) * dist, r, h - r);
              if (!hit(x, y)) found = { x, y, moved: true };
            }
          }
          if (found) best = found;
        }
        placed.push(best);
        return best;
      });
    },

    _e(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"); },
    /** CSS 문자열 리터럴 안에 넣을 값(따옴표·역슬래시·꺾쇠·줄바꿈 이스케이프 — </style> 탈출 차단) */
    _cssStr(s) { return '"' + String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/</g, "\\3c ").replace(/>/g, "\\3e ").replace(/[\r\n]+/g, " ") + '"'; },
    _fmtGps(g) { return g ? (Number(g.lat).toFixed(6) + ", " + Number(g.lng).toFixed(6) + (g.acc != null ? " (±" + Math.round(g.acc) + "m)" : "")) : ""; },

    /** 보고서 HTML(순수). src(key) → 이미지 주소 또는 null(없으면 "사진 없음" 칸). opts.mode = "print" | "bundle" */
    html(model, src, opts) {
      const e = this._e.bind(this);
      const o = opts || {};
      const m = model;
      const c = m.cover;
      const get = (k) => (typeof src === "function" ? src(k) : null);
      const covSt = Coverage.STYLE;
      const chip = (style, text) => '<span class="chip" style="' + e(style) + '">' + e(text) + "</span>";
      const css =
        "@page{size:A4 portrait;margin:16mm 12mm 16mm 12mm;" +
        "@top-left{content:" + this._cssStr("SEASTAR 납품 보고서") + ";font:8pt sans-serif;color:#374151}" +
        "@top-right{content:" + this._cssStr((c.project || "") + " · " + c.date) + ";font:8pt sans-serif;color:#374151}" +
        "@bottom-center{content:counter(page) \" / \" counter(pages);font:8pt sans-serif;color:#374151}}" +
        "@page:first{@top-left{content:none}@top-right{content:none}}" +
        "*{box-sizing:border-box}" +
        "html,body{margin:0;background:#ffffff;color:#111827;font:10pt/1.45 'Malgun Gothic','Apple SD Gothic Neo','Noto Sans KR',sans-serif}" +
        ".rpt{width:186mm;margin:0 auto;padding:0}" +
        ".rpt *{max-width:100%}" +                        // 창고 16-report-fix: A4 폭 밖으로 못 나가게
        "h1{font-size:22pt;margin:0 0 6mm;color:#0f172a}h2{font-size:13pt;margin:0 0 3mm;padding-bottom:1.5mm;border-bottom:.6mm solid #1e3a8a;color:#0f172a}" +
        "h3{font-size:10.5pt;margin:0 0 2mm;color:#0f172a}" +
        ".cover{height:240mm;display:flex;flex-direction:column;justify-content:center;break-after:page;page-break-after:always}" +
        ".cover table td{font-size:11pt;padding:2mm 3mm}.cover table td:first-child{width:38mm;background:#f1f5f9;font-weight:700}" +
        ".sec{break-before:page;page-break-before:always}" +
        ".blk{break-inside:avoid;page-break-inside:avoid}" +
        "table{width:100%;border-collapse:collapse;table-layout:fixed;margin:0 0 3mm}" +
        "th,td{border:.25mm solid #9ca3af;padding:1mm 1.5mm;font-size:8.5pt;vertical-align:top;text-align:left;overflow-wrap:anywhere;word-break:break-word}" +
        "th{background:#e2e8f0;color:#0f172a}thead{display:table-header-group}tr{break-inside:avoid;page-break-inside:avoid}" +
        ".chip{display:inline-block;padding:0 1.5mm;border-radius:1mm;font-size:8pt;font-weight:700;white-space:nowrap}" +
        ".map{margin:0 0 5mm}.map img{display:block;max-width:100%;max-height:200mm;margin:0 auto;border:.3mm solid #9ca3af}" +
        ".legend{font-size:8.5pt;color:#1f2937;margin:2mm 0 0}.legend span{margin-right:5mm}" +
        ".pin{border:.3mm solid #cbd5e1;border-radius:2mm;padding:3mm;margin:0 0 4mm}" +
        ".pin-top{break-inside:avoid;page-break-inside:avoid}" +
        ".photos{display:flex;gap:3mm;margin:0 0 2mm}.ph{width:88mm;font-size:8pt;color:#1f2937}" +
        ".ph img,.ph .noimg{display:block;width:88mm;height:66mm;object-fit:cover;border:.25mm solid #9ca3af}" +
        ".ph.one,.ph.one img,.ph.one .noimg{width:112mm}.ph.one img,.ph.one .noimg{height:84mm}" +
        ".noimg{display:flex!important;align-items:center;justify-content:center;background:#f1f5f9;color:#374151;font-size:9pt;text-align:center;padding:2mm}" +
        ".muted{color:#374151;font-size:8.5pt}" +
        ".bar{position:sticky;top:0;z-index:5;background:#0f172a;color:#ffffff;padding:8px 12px;font:13px sans-serif;display:flex;gap:10px;align-items:center}" +
        ".bar button{background:#facc15;color:#0f172a;border:0;border-radius:6px;padding:6px 12px;font-weight:700;cursor:pointer}" +
        "@media screen{body{background:#e5e7eb}.rpt{background:#ffffff;padding:12mm;margin:12px auto;width:210mm}}" +
        "@media print{.bar{display:none}}";
      const out = [];
      out.push("<!doctype html><html lang=\"ko\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">");
      out.push("<title>" + e("납품 보고서 — " + (c.project || "") + " — " + c.date) + "</title><style>" + css + "</style></head><body>");
      if (o.mode === "print") {
        out.push('<div class="bar"><button type="button" onclick="window.print()">인쇄 / PDF 저장</button><span>A4 세로 · 배율 100% · 머리글/바닥글은 끄고 저장하세요(보고서에 쪽번호가 들어 있습니다)</span></div>');
      }
      out.push('<main class="rpt">');
      // ── 표지 ──
      const v = c.visit;
      const visitTxt = v ? ((v.upcoming ? "예정 " : "") + v.no + "회차 / 총 " + v.total + "회 · " + v.date + (v.content ? " · " + v.content : "")) : "기록 없음(프로젝트 정보 → 일정에 '방선' 구분으로 등록)";
      const row = (k, val) => "<tr><td>" + e(k) + "</td><td>" + e(val) + "</td></tr>";
      out.push('<section class="cover" data-rpt="cover"><div class="muted">SEASTAR 360° Location Viewer</div><h1>납품 보고서</h1><table>' +
        row("프로젝트", c.project || "—") +
        row("선명", c.vessel || "미입력") + row("호선", c.hull || "미입력") +
        row("방선", visitTxt) + row("작성자", c.author || "—") + row("작성일시", c.createdAt) +
        row("범위", c.scopeLabel) +
        row("구성", "구역 " + c.sectionCount + " · 포인트 " + c.pinCount + " (360 " + c.content + " · CHECKER " + c.checker + ")") +
        (c.skipped.length ? row("제외", c.skipped.map((s) => s.name + "(" + s.reason + ")").join(", ")) : "") +
        "</table>" + (c.masked ? '<p class="muted">열람자 보고서 — 다른 사람의 이메일은 가려져 있습니다.</p>' : "") + "</section>");
      // ── 요약 ──
      const covCell = (cv, k) => String(cv[k] || 0);
      out.push('<section class="sec" data-rpt="summary"><h2>요약</h2><div class="blk"><h3>구역별 현황</h3><table><thead><tr><th style="width:30%">구역</th><th>포인트</th><th>360</th><th>CHECKER</th><th>' +
        e(covSt.none.label) + "</th><th>" + e(covSt.stale.label) + "</th><th>" + e(covSt.unknown.label) + "</th><th>미완 노트</th></tr></thead><tbody>");
      m.sections.forEach((s) => {
        out.push("<tr><td>" + e(s.title) + "</td><td>" + s.counts.total + "</td><td>" + s.counts.content + "</td><td>" + s.counts.checker + "</td><td>" +
          covCell(s.counts.cov, "none") + "</td><td>" + covCell(s.counts.cov, "stale") + "</td><td>" + covCell(s.counts.cov, "unknown") + "</td><td>" + s.counts.openNotes + "</td></tr>");
      });
      out.push("</tbody></table><p class=\"muted\">촬영 현황은 360 포인트만 집계 · 오래됨 = 마지막 촬영 " + c.staleDays + "일 초과(프로젝트 정보 기준)</p></div>");
      const d = m.summary.defects;
      out.push('<div class="blk"><h3>결함 상태</h3><table><thead><tr>' + ["open", "progress", "done", "verified"].map((k) => "<th>" + chip(Requests.STATUS_STYLE[k], Requests.STATUS[k]) + "</th>").join("") +
        "<th>요청·질문 미처리</th></tr></thead><tbody><tr><td>" + d.open + "</td><td>" + d.progress + "</td><td>" + d.done + "</td><td>" + d.verified + "</td><td>" + m.summary.requestsOpen + "</td></tr></tbody></table></div>");
      out.push('<div class="blk"><h3>기한 지난 항목 (' + m.summary.overdue.length + ")</h3>");
      if (m.summary.overdue.length) {
        out.push('<table><thead><tr><th style="width:12%">번호</th><th style="width:20%">구역</th><th style="width:30%">내용</th><th>기한</th><th>상태</th><th>담당</th></tr></thead><tbody>');
        m.summary.overdue.forEach((x) => out.push("<tr><td>" + e(x.noText) + "</td><td>" + e(x.section) + "</td><td>" + e("[" + x.kindLabel + "] " + x.body) + "</td><td>" + e(this.localDate(x.due)) + "</td><td>" + e(x.statusLabel) + "</td><td>" + e(x.assignee || "—") + "</td></tr>"));
        out.push("</tbody></table>");
      } else out.push('<p class="muted">없음</p>');
      out.push("</div></section>");
      // ── 위치도 ──
      out.push('<section class="sec" data-rpt="maps"><h2>포인트 위치도</h2>');
      const legend = '<div class="legend"><span>' + chip("background:" + this.MARK.content.fill + ";color:" + this.MARK.content.text, "P1") + " " + e(this.MARK.content.label) + "</span><span>" +
        chip("background:" + this.MARK.checkboard.fill + ";color:" + this.MARK.checkboard.text, "1") + " " + e(this.MARK.checkboard.label) + "</span></div>";
      let anyMap = false;
      m.sections.forEach((s) => s.pages.forEach((pg) => {
        anyMap = true;
        const u = get(pg.key);
        out.push('<figure class="map blk" data-rpt="map"><h3>' + e(s.title) + (s.pages.length > 1 || pg.page > 1 ? " · " + pg.page + "쪽" : "") + " — 포인트 " + pg.marks.length + "</h3>" +
          (u ? '<img alt="' + e(s.title + " 위치도") + '" src="' + e(u) + '">' : '<div class="noimg" style="height:40mm">도면 이미지를 불러오지 못했습니다(권한·네트워크) — 번호 목록은 아래 핀별 칸을 보세요</div>') +
          legend + "</figure>");
      }));
      if (!anyMap) out.push('<p class="muted">위치도에 그릴 포인트가 없습니다.</p>');
      out.push("</section>");
      // ── 핀별 ──
      out.push('<section class="sec" data-rpt="pins"><h2>포인트 상세</h2>');
      m.pins.forEach((p) => {
        const head = e(p.noText) + (p.label && p.label !== p.noText.replace(/^P/, "") ? " · " + e(p.label) : "") +
          ' <span class="muted">' + e(p.section + (p.area ? " › " + p.area : "") + " · " + p.seriesLabel) + "</span>";
        let photos = "";
        if (p.series === "content") {
          const one = p.photos.length === 1;
          photos = '<div class="photos">' + (p.photos.length ? p.photos.map((ph) => {
            const u = get(ph.key);
            const roleTxt = ph.role === "before" ? "이전" : ph.role === "after" ? "최신" : "사진";
            const why = ph.video ? "동영상(보고서에는 미포함)" : ph.pending ? "업로드 대기 중인 사진" : "사진을 불러오지 못했습니다";
            return '<div class="ph' + (one ? " one" : "") + '">' + (u ? '<img alt="' + e(p.noText + " " + roleTxt) + '" src="' + e(u) + '">' : '<div class="noimg">' + e(why) + "</div>") +
              "<div>" + e(roleTxt + " · " + (ph.at ? this.localDateTime(ph.at) : "촬영시각 기록 없음")) + "</div></div>";
          }).join("") : '<div class="ph one"><div class="noimg">미촬영 — 등록된 360 사진 없음</div></div>') + "</div>";
        }
        const cov = p.cov ? chip("background:" + covSt[p.cov].color + ";color:#ffffff", covSt[p.cov].label) : "";
        const meta = '<table><tbody><tr><th style="width:22%">촬영시각</th><td>' + e(p.shotAt ? this.localDateTime(p.shotAt) + (p.shotSrc ? " (" + p.shotSrc + ")" : "") : "기록 없음") + " " + cov + "</td></tr>" +
          "<tr><th>도면 위치</th><td>" + e(p.page + "쪽 · X " + (Number.isFinite(p.x) ? p.x.toFixed(1) : "?") + "% · Y " + (Number.isFinite(p.y) ? p.y.toFixed(1) : "?") + "%") + "</td></tr>" +
          (p.gps ? "<tr><th>GPS</th><td>" + e(this._fmtGps(p.gps)) + "</td></tr>" : "") + "</tbody></table>";
        let notesTbl = "";
        if (p.notes.length) {
          notesTbl = '<table><thead><tr><th style="width:10%">종류</th><th style="width:40%">내용</th><th>상태</th><th>심각도</th><th>기한</th><th>담당</th><th>작성</th></tr></thead><tbody>' +
            p.notes.map((n) => "<tr><td>" + chip(Requests.KIND_STYLE[n.kind] || "background:#e5e7eb;color:#1f2937", n.kindLabel) + "</td><td>" + e(n.body) + "</td><td>" +
              (n.status ? chip(Requests.STATUS_STYLE[n.status] || "background:#e5e7eb;color:#1f2937", n.statusLabel) : "") + "</td><td>" +
              (n.severity ? chip(Requests.SEVERITY_STYLE[n.severity] || "background:#e5e7eb;color:#1f2937", n.severity) : "—") + "</td><td>" +
              e(n.due ? this.localDate(n.due) : "—") + (n.overdue ? " " + chip("background:#b91c1c;color:#ffffff", "지남") : "") + "</td><td>" + e(n.assignee || "—") + "</td><td>" + e(n.author || "—") + "</td></tr>").join("") +
            "</tbody></table>";
        } else notesTbl = '<p class="muted">노트·결함 없음</p>';
        out.push('<article class="pin" data-rpt="pin" data-no="' + e(p.noText) + '"><div class="pin-top"><h3>' + head + "</h3>" + photos + meta + "</div>" + notesTbl + "</article>");
      });
      if (!m.pins.length) out.push('<p class="muted">포인트가 없습니다.</p>');
      out.push("</section></main></body></html>");
      return out.join("");
    },

    /* ─────────────── 비순수(DOM·fetch) ─────────────── */

    _scopeLabel(scope) {
      if (scope === "project") return "프로젝트 전체";
      const deck = (typeof Projects !== "undefined" && Projects.currentDeck && Projects.currentDeck.name) || "";
      return scope === "deck" ? ("구역 전체" + (deck ? " — " + deck : "")) : ("현재 페이지 " + ((typeof State !== "undefined" && State.pdfPage) || 1) + (deck ? " — " + deck : ""));
    },
    _parse(s, fb) { if (Array.isArray(s)) return s; try { const v = JSON.parse(s || "null"); return v == null ? fb : v; } catch (e) { return fb; } },
    _pagesOf(dep) {
      let pages = this._parse(dep && dep.pages_data, []);
      if (!Array.isArray(pages) || !pages.length) pages = dep && dep.drawing_data ? [dep.drawing_data] : [];
      return pages;
    },

    /** 데이터 수집 — 서버 읽기 라우트만(권한 SoT). 반환 = buildModel 입력 + deps(위치도용) */
    async gather(scope) {
      const role = (typeof Auth !== "undefined" && Auth.role) || "viewer";
      // 열람자 진입(App.openApp("viewer",{project}))은 Projects.currentProject 를 두지 않고 State.currentProjectId 만 둔다 —
      //   그때는 서버가 준 목록(Projects.list, 이미 권한·마스킹 적용)에서 같은 id 를 찾는다(없으면 이름만).
      const pidFallback = (typeof State !== "undefined" && State.currentProjectId) || null;
      const proj = (typeof Projects !== "undefined" && Projects.currentProject) ||
        (pidFallback ? (((typeof Projects !== "undefined" && Projects.list) || []).find((p) => p && String(p.id) === String(pidFallback)) || { id: pidFallback, name: State.currentProjectName || "" }) : null);
      const info = (typeof ProjectInfo !== "undefined" && ProjectInfo._normalize) ? ProjectInfo._normalize(proj && proj.info_json) : {};
      const author = (typeof Auth !== "undefined" && Auth.user && (Auth.user.name || Auth.user.email)) || "";
      const now = Date.now();
      const staleDays = Coverage.staleDays(proj);
      const deps = {}, skipped = [];
      let notes = [], sections = [];
      if (scope === "project") {
        const decks = (typeof Projects !== "undefined" && Array.isArray(Projects.decks)) ? Projects.decks.filter((d) => d && !d.deleted) : [];
        const ids = [];
        decks.forEach((d) => { if (d.deployment_id && ids.indexOf(String(d.deployment_id)) < 0) ids.push(String(d.deployment_id)); });
        if (proj && proj.original_deployment_id && ids.indexOf(String(proj.original_deployment_id)) < 0) ids.push(String(proj.original_deployment_id));
        for (const id of ids) {
          let status = 0, dep = null;
          try {
            const r = await fetch("/tables/deployments/" + encodeURIComponent(id), { headers: Auth.headers() });
            status = r.status;
            if (r.ok) dep = await r.json();
          } catch (e) { status = -1; }
          const names = decks.filter((d) => String(d.deployment_id) === id).map((d) => d.name).filter(Boolean).join("·") || "원본 도면";
          if (!dep || dep.deleted) { skipped.push({ name: names, reason: status === 403 ? "읽기 권한 없음" : status === -1 ? "네트워크 오류" : "불러오기 실패 " + status }); continue; }
          deps[id] = { pins: this._parse(dep.pins, []), zones: this._parse(dep.zones, []), pages: this._pagesOf(dep), title: dep.title || dep.file_name || "원본 도면" };
          const ns = await Report._fetchNotes(id);
          ns.forEach((n) => { if (n && n.deployment_id == null) n.deployment_id = id; });
          notes = notes.concat(ns);
        }
        sections = this.sections(decks, deps, decks);
      } else {
        const depId = (State.currentDeploymentId || State.autoSaveDepId) ? String(State.currentDeploymentId || State.autoSaveDepId) : "local";
        const deck = (typeof Projects !== "undefined" && Projects.currentDeck) || null;
        let pins = this._live(State.pins);
        if (deck) pins = Projects.pinsForDeck(pins, deck);   // 창 방식(crop) 구역이면 그 창 안의 핀만 — 트리·AllPins 와 같은 SoT
        if (scope === "page") pins = pins.filter((p) => (p.page || 1) === (State.pdfPage || 1));
        let pages = null;
        if (depId !== "local") {
          try { const r = await fetch("/tables/deployments/" + encodeURIComponent(depId), { headers: Auth.headers() }); if (r.ok) pages = this._pagesOf(await r.json()); } catch (e) { pages = null; }
        }
        deps[depId] = { pins, zones: State.zones || [], pages: pages && pages.length ? pages : null, local: true, title: State.fileName || "현재 도면", allPins: this._live(State.pins) };
        const entry = deck ? Object.assign({}, deck, { deployment_id: depId }) : { id: "local", name: State.fileName || "현재 도면", deployment_id: depId, page: null, crop: null, parent_id: null };
        sections = this.sections([entry], deps, (typeof Projects !== "undefined" && Projects.decks) || []);
        // 번호는 페이지의 **모든** 핀 기준(도면 표시와 같은 번호) — 페이지 범위로 잘라도 번호가 바뀌면 안 된다
        sections.forEach((s) => { s.allPins = deps[depId].allPins; });
        if (depId !== "local") notes = await Report._fetchNotes(depId);
      }
      return { project: proj ? { id: proj.id, name: proj.name } : { name: (State && State.fileName) || "" }, info, scope, scopeLabel: this._scopeLabel(scope),
        author, role, now, staleDays, sections, notes, skipped, deps };
    },

    _loadImg(src) {
      return new Promise((res, rej) => {
        const img = new Image();
        const t = setTimeout(() => { img.src = ""; rej(new Error("이미지 시간 초과")); }, 30000);
        img.onload = () => { clearTimeout(t); res(img); };
        img.onerror = () => { clearTimeout(t); rej(new Error("이미지 로드 실패")); };
        img.decoding = "async";
        img.src = src;
      });
    },
    _toBlob(cv, q) {
      return new Promise((res, rej) => {
        try { cv.toBlob((b) => (b ? res(b) : rej(new Error("toBlob 실패"))), "image/jpeg", q); } catch (e) { rej(e); }
      });
    },

    /** 정면 크롭 — equirect(≈2:1)이면 가로 중앙 120°·세로 중앙 90°(=4:3), 아니면 4:3 cover. 상한 640×480. */
    _frontCanvas(img) {
      const W = img.naturalWidth || img.width, H = img.naturalHeight || img.height;
      let sx, sy, sw, sh;
      const ratio = W / H;
      if (ratio > 1.9 && ratio < 2.1) { sw = W / 3; sh = H / 2; }
      else if (ratio > 4 / 3) { sh = H; sw = H * 4 / 3; }
      else { sw = W; sh = W * 3 / 4; }
      sx = (W - sw) / 2; sy = (H - sh) / 2;
      const scale = Math.min(1, this.THUMB_W / sw);
      const cv = document.createElement("canvas");
      cv.width = Math.max(1, Math.round(sw * scale)); cv.height = Math.max(1, Math.round(sh * scale));
      const ctx = cv.getContext("2d", { alpha: false });
      ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
      return cv;
    },

    async _photoBlob(ph) {
      if (ph.video || ph.pending) return null;
      let src = null, fetchedId = null;
      if (ph.imageId) {
        const had = !!(Cloud._cache && Cloud._cache[ph.imageId]);
        src = await Cloud.fetchImage(ph.imageId);
        if (!had) fetchedId = ph.imageId;
      } else src = ph.imageUrl;
      if (!src) return null;
      try {
        const img = await this._loadImg((typeof Auth !== "undefined" && Auth.r2) ? Auth.r2(src) : src);
        const cv = this._frontCanvas(img);
        img.src = "";
        return await this._toBlob(cv, this.JPEG_Q);
      } finally {
        if (fetchedId && Cloud._cache) delete Cloud._cache[fetchedId];   // 보고서 때문에 원본이 캐시에 쌓이지 않게
      }
    },

    async _localPageSrc(page) {
      if (State.viewerPages && State.viewerPages[page - 1]) return State.viewerPages[page - 1];
      const mapImg = document.getElementById("map-image");
      if ((State.pdfPage || 1) === page && mapImg && !mapImg.classList.contains("hidden") && mapImg.src) return mapImg.src;
      if (State.pdfDoc) {   // Radar._buildHiResSnapshot 과 같은 오프스크린 렌더(화면 캔버스 미변경)
        const pg = await State.pdfDoc.getPage(page);
        const rot = ((pg.rotate || 0) + (State.pdfRotation || 0)) % 360;
        const base = pg.getViewport({ scale: 1, rotation: rot });
        const vp = pg.getViewport({ scale: Math.min(this.MAP_MAX / Math.max(base.width, base.height), 3), rotation: rot });
        const cv = document.createElement("canvas");
        cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
        const ctx = cv.getContext("2d", { alpha: false });
        ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, cv.width, cv.height);
        await pg.render({ canvasContext: ctx, viewport: vp }).promise;
        return cv;
      }
      return null;
    },

    /** 위치도 — 도면(구역 crop 반영) 축소 + 번호 겹쳐 그림. 긴 변 ≤ MAP_MAX. */
    async _mapBlob(sec, pg, dep) {
      let srcEl = null;
      const raw = dep.pages && dep.pages[pg.page - 1];
      if (raw) srcEl = await this._loadImg(Auth.r2 ? Auth.r2(raw) : raw);
      else if (dep.local) {
        const s = await this._localPageSrc(pg.page);
        if (s) srcEl = (typeof s === "string") ? await this._loadImg(Auth.r2 ? Auth.r2(s) : s) : s;
      }
      if (!srcEl) return null;
      const W = srcEl.naturalWidth || srcEl.width, H = srcEl.naturalHeight || srcEl.height;
      const crop = (sec.crop && sec.cropPage === pg.page) ? sec.crop : { x: 0, y: 0, w: 100, h: 100 };
      const sx = W * crop.x / 100, sy = H * crop.y / 100, sw = W * crop.w / 100, sh = H * crop.h / 100;
      const scale = Math.min(1, this.MAP_MAX / Math.max(sw, sh));
      const cv = document.createElement("canvas");
      cv.width = Math.max(1, Math.round(sw * scale)); cv.height = Math.max(1, Math.round(sh * scale));
      const ctx = cv.getContext("2d", { alpha: false });
      ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.drawImage(srcEl, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
      if (srcEl.src !== undefined && srcEl instanceof HTMLImageElement) srcEl.src = "";
      // 번호표 반지름 = 긴 변의 1.6%(A4 폭 186mm 인쇄 시 지름 ≈ 6mm — 번호 글자 ≈ 2.5mm 로 읽힘)
      const r = Math.max(12, Math.round(Math.max(cv.width, cv.height) * 0.016));
      const pts = pg.marks.map((mk) => ({ x: (mk.x - crop.x) / crop.w * cv.width, y: (mk.y - crop.y) / crop.h * cv.height }));
      const pos = this.placeLabels(pts, r, cv.width, cv.height);
      pg.marks.forEach((mk, i) => {
        const st = this.MARK[mk.series === "checkboard" ? "checkboard" : "content"];
        const p = pos[i], o = pts[i];
        if (p.moved) {   // 지시선 + 실제 위치 점
          ctx.strokeStyle = "#111827"; ctx.lineWidth = Math.max(1.5, r * 0.15);
          ctx.beginPath(); ctx.moveTo(o.x, o.y); ctx.lineTo(p.x, p.y); ctx.stroke();
          ctx.fillStyle = st.fill; ctx.beginPath(); ctx.arc(o.x, o.y, Math.max(2.5, r * 0.28), 0, Math.PI * 2); ctx.fill();
        }
        ctx.fillStyle = st.fill; ctx.strokeStyle = "#ffffff"; ctx.lineWidth = Math.max(2, r * 0.18);
        ctx.beginPath();
        if (st.shape === "circle") ctx.arc(p.x, p.y, r, 0, Math.PI * 2); else ctx.rect(p.x - r, p.y - r, r * 2, r * 2);
        ctx.fill(); ctx.stroke();
        ctx.fillStyle = st.text;
        const txt = String(mk.noText);
        ctx.font = "700 " + Math.round(r * (txt.length > 3 ? 0.78 : 0.95)) + "px sans-serif";
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(txt, p.x, p.y + 0.5, r * 1.9);
      });
      return await this._toBlob(cv, 0.85);
    },

    async _pool(jobs, n, onEach) {
      let i = 0, done = 0;
      const run = async () => { while (i < jobs.length) { const j = jobs[i++]; try { await j(); } catch (e) { /* 개별 실패 = 그 칸만 "불러오지 못함" */ } done++; if (onEach) onEach(done, jobs.length); } };
      await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, run));
    },

    /** 모델 + 이미지 자산(Map key → {blob, path, name}) */
    async prepare(scope, onProgress) {
      const input = await this.gather(scope);
      const model = this.buildModel(input);
      const assets = new Map();
      const jobs = [];
      model.sections.forEach((s) => s.pages.forEach((pg) => jobs.push(async () => {
        const dep = input.deps[s.depId];
        if (!dep) return;
        const b = await this._mapBlob(s, pg, dep);
        if (b) assets.set(pg.key, { blob: b, path: "maps/" + pg.key + ".jpg" });
      })));
      model.pins.forEach((p) => p.photos.forEach((ph) => jobs.push(async () => {
        const b = await this._photoBlob(ph);
        if (b) assets.set(ph.key, { blob: b, path: "photos/" + ph.key + ".jpg" });
      })));
      await this._pool(jobs, this.CONC, (d, t) => { if (onProgress) onProgress("이미지 " + d + " / " + t); });
      return { input, model, assets };
    },

    _fileTag(model) {
      const name = String((model && model.cover.project) || "report").replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 60);
      return name + "_" + ((model && model.cover.date) || "");
    },

    /** ① 인쇄 보고서 — 창은 클릭 즉시 연다(팝업 차단 회피), 준비되면 내용을 쓴다. */
    async open(scope) {
      scope = scope || (Report.currentScope ? Report.currentScope() : "page");
      const w = Report.openPrintWindow();
      if (!w) return null;
      Report.writePrint(w, "<!doctype html><meta charset=\"utf-8\"><title>보고서 준비 중</title><body style=\"font:15px sans-serif;color:#111827;background:#ffffff;padding:24px\"><b>납품 보고서 준비 중…</b><div id=\"rpt-progress\" style=\"margin-top:8px;color:#374151\">데이터 불러오는 중</div></body>");
      const urls = [];
      try {
        const pack = await this.prepare(scope, (msg) => { try { const el = w.document.getElementById("rpt-progress"); if (el) el.textContent = msg; } catch (e) {} });
        if (!pack.model.pins.length) {
          Report.writePrint(w, "<!doctype html><meta charset=\"utf-8\"><body style=\"font:15px sans-serif;color:#111827;background:#ffffff;padding:24px\">보고서에 넣을 포인트가 없습니다." +
            (pack.model.cover.skipped.length ? "<br>제외: " + this._e(pack.model.cover.skipped.map((s) => s.name + "(" + s.reason + ")").join(", ")) : "") + "</body>");
          return pack;
        }
        const urlOf = new Map();
        pack.assets.forEach((a, k) => { const u = URL.createObjectURL(a.blob); urls.push(u); urlOf.set(k, u); });
        Report.writePrint(w, this.html(pack.model, (k) => urlOf.get(k) || null, { mode: "print" }));
        const iv = setInterval(() => { if (w.closed) { clearInterval(iv); urls.forEach((u) => URL.revokeObjectURL(u)); } }, 5000);
        return pack;
      } catch (e) {
        urls.forEach((u) => URL.revokeObjectURL(u));
        Report.writePrint(w, "<!doctype html><meta charset=\"utf-8\"><body style=\"font:15px sans-serif;color:#7f1d1d;background:#ffffff;padding:24px\">보고서를 만들지 못했습니다: " + this._e(e && e.message || e) + "</body>");
        return null;
      }
    },

    /** ② 묶음 zip 바이트(테스트·다운로드 공용) */
    async bundleBlob(scope, onProgress) {
      const pack = await this.prepare(scope, onProgress);
      const files = [{ name: "report.html", data: this.html(pack.model, (k) => (pack.assets.get(k) ? pack.assets.get(k).path : null), { mode: "bundle" }) }];
      for (const [, a] of pack.assets) files.push({ name: a.path, data: new Uint8Array(await a.blob.arrayBuffer()) });
      return { blob: ZipStore.blob(files), name: "seastar_납품_" + this._fileTag(pack.model) + ".zip", pack, count: files.length };
    },

    async bundle(scope) {
      scope = scope || (Report.currentScope ? Report.currentScope() : "page");
      const toast = (m, ms) => { if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast(m, ms); };
      if (typeof navigator !== "undefined" && navigator.onLine === false) toast("오프라인 — 저장된 데이터만으로 묶음을 만듭니다(못 받은 사진은 '불러오지 못함'으로 표시)", 4000);
      toast("묶음 파일 준비 중…", 2500);
      try {
        const r = await this.bundleBlob(scope);
        if (!r.pack.model.pins.length) { toast("묶음에 넣을 포인트가 없습니다."); return null; }
        const url = URL.createObjectURL(r.blob);
        const a = document.createElement("a");
        a.href = url; a.download = r.name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        toast("묶음 다운로드: 파일 " + r.count + "개 · " + Math.round(r.blob.size / 1024) + "KB");
        return r;
      } catch (e) {
        toast("묶음을 만들지 못했습니다: " + (e && e.message || e), 5000);
        return null;
      }
    }
  };
