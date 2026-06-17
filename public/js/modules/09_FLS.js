  const FLS = {
    MAX_POINTS: 1_800_000,     // 렌더 안정 상한 (초과 시 균등 다운샘플)
    renderer: null, scene: null, camera: null, points: null,
    _raf: null, _drag: null, _rot: { theta: 0.6, phi: 1.1, r: 3 },
    _target: { x: 0, y: 0, z: 0 }, _inited: false, _ro: null,

    SUPPORTED: ["ply", "pcd", "xyz", "pts", "asc", "txt", "las", "laz", "fls", "e57"],

    extOf(name) { return (name || "").split(".").pop().toLowerCase(); },
    isSupported(name) { return this.SUPPORTED.includes(this.extOf(name)); },

    _el(id) { return document.getElementById(id); },
    _show(which) {
      ["fls-loading", "fls-empty", "fls-error", "fls-stats"].forEach(id => {
        const e = this._el(id); if (e) e.classList.add("hidden");
      });
      const t = this._el(which); if (t) t.classList.remove("hidden");
    },

    /** 3D 패널 표시/숨김 */
    showPane(show) {
      const p = this._el("fls-pane");
      if (!p) return;
      p.classList.toggle("hidden", !show);
      if (show) {
        // 샘플 버튼 바인딩(렌더러 초기화 실패/지연 시에도 동작 보장)
        const sb = this._el("btn-fls-sample");
        if (sb && !sb._bound) { sb._bound = true; sb.addEventListener("click", () => this.loadSample()); }
        this._ensureRenderer();
        setTimeout(() => this._resize(), 30);
      }
    },

    /** 핀에 연결된 포인트클라우드가 있으면 로드. 없으면 empty 패널. */
    async openForPin(pin) {
      this.showPane(true);
      const src = pin && (pin.flsUrl || pin.fls);
      const name = pin && (pin.flsName || pin.flsUrl || "");
      const localData = pin && pin.flsLocalId ? Cloud._cache && Cloud._cache["fls:" + pin.flsLocalId] : null;
      if (!src && !localData) { this._show("fls-empty"); return; }
      try {
        this._show("fls-loading");
        let buf;
        if (localData) { buf = localData; }
        else {
          const res = await fetch(src);
          if (!res.ok) throw new Error("HTTP " + res.status);
          buf = await res.arrayBuffer();
        }
        await this.loadBuffer(buf, name || src);
      } catch (e) {
        this._showError("로드 실패", e.message || String(e));
      }
    },

    /** 내장 샘플 포인트클라우드(SEASTAR FSRU)를 불러와 3D 표시 — 기능 즉시 체험용 */
    async loadSample() {
      this.showPane(true);
      const btn = this._el("btn-fls-sample");
      if (btn) { btn.disabled = true; }
      try {
        if (typeof THREE === "undefined") {
          this._showError("3D 엔진 미로딩", "Three.js 가 로드되지 않았습니다(오프라인 등). 온라인 상태에서 다시 시도하세요.");
          return;
        }
        this._show("fls-loading");
        const lm = this._el("fls-loading-msg");
        if (lm) lm.textContent = "SEASTAR FSRU 샘플 로드 중…";
        const url = "/samples/seastar-fsru.ply";
        let buf = Cloud && Cloud._cache ? Cloud._cache["fls:sample"] : null;
        if (!buf) {
          const res = await fetch(url);
          if (!res.ok) throw new Error("샘플 다운로드 실패 (HTTP " + res.status + ")");
          buf = await res.arrayBuffer();
          if (Cloud && Cloud._cache) Cloud._cache["fls:sample"] = buf; // 재사용 캐시
        }
        await this.loadBuffer(buf, "seastar-fsru.ply");
      } catch (e) {
        this._showError("샘플 로드 실패", (e && e.message) || String(e));
      } finally {
        if (btn) { btn.disabled = false; }
      }
    },

    _showError(t, h) {
      this._show("fls-error");
      const et = this._el("fls-error-t"), eh = this._el("fls-error-h");
      if (et) et.textContent = t;
      if (eh) eh.textContent = h || "";
    },

    /** ArrayBuffer + 파일명 → 파싱 후 렌더 */
    async loadBuffer(buf, name) {
      const ext = this.extOf(name);
      const badge = this._el("fls-fmt-badge");
      if (badge) badge.textContent = ext ? ("." + ext) : "";
      let parsed = null;
      try {
        if (ext === "ply") parsed = this._parsePLY(buf);
        else if (ext === "pcd") parsed = this._parsePCD(buf);
        else if (["xyz", "pts", "asc", "txt"].includes(ext)) parsed = this._parseXYZ(buf);
        else if (ext === "las" || ext === "laz") parsed = this._parseLAS(buf, ext);
        else if (ext === "fls" || ext === "e57") parsed = this._parseFLS(buf, ext);
        else parsed = this._sniff(buf);
      } catch (e) {
        return this._showError("파싱 실패", (e && e.message) || "지원되지 않는 형식일 수 있습니다.");
      }
      if (!parsed || !parsed.count) {
        if (ext === "fls" || (parsed && parsed.faroRaw)) {
          // ── FARO .fls(iQLib 원시 압축) 직접 로드 불가 → 메타 기반 정밀 변환 안내 ──
          const m = this._flsMeta || {};
          let metaLine = "";
          if (m.rows && m.cols) {
            const vfov = (m.rStart != null && m.rEnd != null)
              ? Math.round((m.rStart - m.rEnd) * 180 / Math.PI) + "°" : "—";
            const hfov = (m.cEnd != null) ? Math.round(m.cEnd * 180 / Math.PI) + "°" : "360°";
            metaLine = `[스캔 정보 인식됨] 그리드 ${m.cols.toLocaleString()}×${m.rows.toLocaleString()} · `
              + `약 ${(m.cols * m.rows).toLocaleString()}점 · 수평 ${hfov} / 수직 ${vfov}`
              + (m.lib ? ` · iQLib ${m.lib}` : "") + ". ";
          }
          return this._showError(
            ".fls(FARO 원시) 직접 표시 불가 — E57/LAS로 변환 필요",
            metaLine +
            "FARO .fls 의 스캔 스트림은 독점 압축($ENC$·$NES$·$GRV$)이라 SDK 없이는 좌표 디코딩이 불가합니다. " +
            "FARO SCENE에서 [내보내기 → E57(또는 LAS/LAZ/PLY)]로 변환해 다시 첨부하면 즉시 3D로 표시됩니다. " +
            "(SCENE이 없으면 CloudCompare + FARO LS 플러그인으로도 변환 가능합니다.) " +
            "지금 기능을 바로 보시려면 아래 ‘샘플 FLS 불러오기’를 누르세요."
          );
        }
        if (ext === "e57") {
          // ── 요청 #9: E57 도 실패 → 둘 다 안 되면 포기(추가 변환 안내) ──
          return this._showError(
            "2단계: .e57 로드 실패 — 추가 변환이 필요합니다",
            "이 .e57 컨테이너는 직접 파싱이 어렵습니다. CloudCompare 등에서 .las/.laz/.ply/.pcd 로 다시 내보내 첨부해 주세요. " +
            "변환본도 열리지 않으면 해당 스캔의 3D 표시는 지원되지 않습니다(포기)."
          );
        }
        return this._showError("표시할 점이 없습니다", "파일이 비었거나 좌표 데이터를 찾지 못했습니다.");
      }
      this._render(parsed);
    },

    /* ── 파서들 (positions: Float32Array[xyz*n], colors: Float32Array|null) ── */

    _decim(posArr, colArr) {
      // 점 개수 상한 초과 시 균등 다운샘플 (안정성)
      const n = posArr.length / 3;
      if (n <= this.MAX_POINTS) return { positions: posArr, colors: colArr, count: n };
      const step = n / this.MAX_POINTS;
      const outN = Math.floor(this.MAX_POINTS);
      const pos = new Float32Array(outN * 3);
      const col = colArr ? new Float32Array(outN * 3) : null;
      for (let i = 0; i < outN; i++) {
        const si = Math.floor(i * step);
        pos[i * 3] = posArr[si * 3]; pos[i * 3 + 1] = posArr[si * 3 + 1]; pos[i * 3 + 2] = posArr[si * 3 + 2];
        if (col) { col[i * 3] = colArr[si * 3]; col[i * 3 + 1] = colArr[si * 3 + 1]; col[i * 3 + 2] = colArr[si * 3 + 2]; }
      }
      return { positions: pos, colors: col, count: outN };
    },

    _parseXYZ(buf) {
      const txt = new TextDecoder().decode(buf);
      const lines = txt.split(/\r?\n/);
      const pos = [], col = [];
      let hasColor = false;
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i].trim();
        if (!l || l[0] === "#" || /[a-df-zA-DF-Z]/.test(l[0])) continue; // 헤더/주석 스킵 (e는 지수표기 허용)
        const t = l.split(/[\s,;]+/).map(Number);
        if (t.length < 3 || !isFinite(t[0]) || !isFinite(t[1]) || !isFinite(t[2])) continue;
        pos.push(t[0], t[1], t[2]);
        if (t.length >= 6) {
          hasColor = true;
          // 색이 0~255 면 정규화
          const r = t[3] > 1 ? t[3] / 255 : t[3], g = t[4] > 1 ? t[4] / 255 : t[4], b = t[5] > 1 ? t[5] / 255 : t[5];
          col.push(r, g, b);
        } else col.push(0.7, 0.8, 0.95);
      }
      return this._decim(new Float32Array(pos), hasColor ? new Float32Array(col) : null);
    },

    _parsePCD(buf) {
      // ASCII PCD 우선 지원 (binary 는 best-effort)
      const head = new TextDecoder().decode(buf.slice(0, 2048));
      const fieldsM = head.match(/FIELDS (.+)/i);
      const dataM = head.match(/DATA (\w+)/i);
      const pointsM = head.match(/POINTS (\d+)/i);
      const fields = fieldsM ? fieldsM[1].trim().split(/\s+/) : ["x", "y", "z"];
      const xi = fields.indexOf("x"), yi = fields.indexOf("y"), zi = fields.indexOf("z");
      const rgbi = fields.findIndex(f => /rgb/i.test(f));
      const dataType = dataM ? dataM[1].toLowerCase() : "ascii";
      const headerEnd = head.indexOf("DATA");
      const bodyStart = buf.bytelength ? 0 : 0;
      if (dataType === "ascii") {
        const fullTxt = new TextDecoder().decode(buf);
        const after = fullTxt.slice(fullTxt.indexOf("DATA ascii") + 10);
        const lines = after.split(/\r?\n/);
        const pos = [], col = [];
        for (const ln of lines) {
          const l = ln.trim(); if (!l) continue;
          const t = l.split(/\s+/).map(Number);
          if (t.length <= Math.max(xi, yi, zi)) continue;
          if (!isFinite(t[xi])) continue;
          pos.push(t[xi], t[yi], t[zi]);
          if (rgbi >= 0 && isFinite(t[rgbi])) {
            const v = t[rgbi] >>> 0;
            col.push(((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255);
          } else col.push(0.7, 0.8, 0.95);
        }
        return this._decim(new Float32Array(pos), rgbi >= 0 ? new Float32Array(col) : null);
      }
      // binary PCD: best-effort — 안내로 폴백
      throw new Error("바이너리 PCD는 ASCII PCD로 변환 후 사용하세요.");
    },

    _parsePLY(buf) {
      const bytes = new Uint8Array(buf);
      // 헤더 끝(end_header) 찾기
      const headTxt = new TextDecoder().decode(buf.slice(0, 4096));
      const endIdx = headTxt.indexOf("end_header");
      if (endIdx < 0) throw new Error("PLY 헤더 없음");
      const headerStr = headTxt.slice(0, endIdx);
      const isAscii = /format\s+ascii/i.test(headerStr);
      const isLE = /format\s+binary_little_endian/i.test(headerStr);
      const vMatch = headerStr.match(/element vertex (\d+)/i);
      const vCount = vMatch ? parseInt(vMatch[1], 10) : 0;
      // 속성 파싱
      const props = [];
      headerStr.split(/\r?\n/).forEach(l => {
        const m = l.trim().match(/^property\s+(\w+)\s+(\w+)/i);
        if (m) props.push({ type: m[1].toLowerCase(), name: m[2].toLowerCase() });
      });
      const dataOffset = (new TextEncoder().encode(headTxt.slice(0, endIdx + "end_header".length))).length
        + (headTxt[endIdx + 10] === "\r" ? 2 : 1);
      const pos = new Float32Array(vCount * 3);
      const hasColor = props.some(p => /red|green|blue/.test(p.name));
      const col = hasColor ? new Float32Array(vCount * 3) : null;
      if (isAscii) {
        const fullTxt = new TextDecoder().decode(buf);
        const after = fullTxt.slice(fullTxt.indexOf("end_header") + 10).replace(/^\s+/, "");
        const lines = after.split(/\r?\n/);
        const xi = props.findIndex(p => p.name === "x"), yi = props.findIndex(p => p.name === "y"), zi = props.findIndex(p => p.name === "z");
        const ri = props.findIndex(p => p.name === "red"), gi = props.findIndex(p => p.name === "green"), bi = props.findIndex(p => p.name === "blue");
        let k = 0;
        for (let i = 0; i < lines.length && k < vCount; i++) {
          const t = lines[i].trim().split(/\s+/).map(Number);
          if (t.length < props.length) continue;
          pos[k * 3] = t[xi]; pos[k * 3 + 1] = t[yi]; pos[k * 3 + 2] = t[zi];
          if (col) { col[k * 3] = (t[ri] || 0) / 255; col[k * 3 + 1] = (t[gi] || 0) / 255; col[k * 3 + 2] = (t[bi] || 0) / 255; }
          k++;
        }
        return this._decim(pos.subarray(0, k * 3), col ? col.subarray(0, k * 3) : null);
      }
      // binary_little_endian
      const dv = new DataView(buf);
      const sizeOf = { char: 1, uchar: 1, int8: 1, uint8: 1, short: 2, ushort: 2, int16: 2, uint16: 2, int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8 };
      const readers = props.map(p => ({ name: p.name, size: sizeOf[p.type] || 4, type: p.type }));
      const stride = readers.reduce((s, r) => s + r.size, 0);
      let off = dataOffset;
      const le = isLE !== false;
      const readVal = (o, r) => {
        switch (r.type) {
          case "float": case "float32": return dv.getFloat32(o, le);
          case "double": case "float64": return dv.getFloat64(o, le);
          case "uchar": case "uint8": return dv.getUint8(o);
          case "char": case "int8": return dv.getInt8(o);
          case "ushort": case "uint16": return dv.getUint16(o, le);
          case "short": case "int16": return dv.getInt16(o, le);
          case "uint": case "uint32": return dv.getUint32(o, le);
          default: return dv.getInt32(o, le);
        }
      };
      for (let i = 0; i < vCount && off + stride <= buf.byteLength; i++) {
        let o = off;
        for (const r of readers) {
          const v = readVal(o, r);
          if (r.name === "x") pos[i * 3] = v;
          else if (r.name === "y") pos[i * 3 + 1] = v;
          else if (r.name === "z") pos[i * 3 + 2] = v;
          else if (col && r.name === "red") col[i * 3] = v / 255;
          else if (col && r.name === "green") col[i * 3 + 1] = v / 255;
          else if (col && r.name === "blue") col[i * 3 + 2] = v / 255;
          o += r.size;
        }
        off += stride;
      }
      return this._decim(pos, col);
    },

    _parseLAS(buf, ext) {
      if (ext === "laz") throw new Error("LAZ(압축)는 LAS로 풀어 첨부하거나 e57/ply를 사용하세요.");
      const dv = new DataView(buf);
      // LAS 헤더: signature 'LASF'
      const sig = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
      if (sig !== "LASF") throw new Error("유효한 LAS 파일이 아닙니다.");
      const pointDataOffset = dv.getUint32(96, true);
      const pointFormat = dv.getUint8(104);
      const pointLength = dv.getUint16(105, true);
      let numPoints = dv.getUint32(107, true);
      if (!numPoints) { // LAS 1.4 legacy 0 → extended
        try { numPoints = Number(dv.getBigUint64(247, true)); } catch (e) {}
      }
      const sx = dv.getFloat64(131, true), sy = dv.getFloat64(139, true), sz = dv.getFloat64(147, true);
      const ox = dv.getFloat64(155, true), oy = dv.getFloat64(163, true), oz = dv.getFloat64(171, true);
      const hasColor = pointFormat === 2 || pointFormat === 3 || pointFormat === 5 || pointFormat === 7 || pointFormat === 8 || pointFormat === 10;
      const colorOffsetMap = { 2: 20, 3: 28, 5: 28, 7: 30, 8: 30, 10: 30 };
      const n = Math.min(numPoints, this.MAX_POINTS * 2);
      const pos = new Float32Array(n * 3);
      const col = hasColor ? new Float32Array(n * 3) : null;
      let off = pointDataOffset, k = 0;
      for (let i = 0; i < numPoints && off + pointLength <= buf.byteLength && k < n; i++, off += pointLength) {
        const X = dv.getInt32(off, true), Y = dv.getInt32(off + 4, true), Z = dv.getInt32(off + 8, true);
        pos[k * 3] = X * sx + ox; pos[k * 3 + 1] = Y * sy + oy; pos[k * 3 + 2] = Z * sz + oz;
        if (col) {
          const co = off + (colorOffsetMap[pointFormat] || 20);
          col[k * 3] = dv.getUint16(co, true) / 65535;
          col[k * 3 + 1] = dv.getUint16(co + 2, true) / 65535;
          col[k * 3 + 2] = dv.getUint16(co + 4, true) / 65535;
        }
        k++;
      }
      return this._decim(pos.subarray(0, k * 3), col ? col.subarray(0, k * 3) : null);
    },

    _parseFLS(buf, ext) {
      // FARO .fls 는 독점 포맷(iQLib). 내부 ScanDataStream 은 가변 델타 압축($ENC$/$NES$/$GRV$ 토큰)
      // 이라 FARO LS SDK 없이는 XYZ 디코딩 불가(공식 문서·CloudCompare 포럼 확인).
      // → 시그니처를 감지해 "정확한 변환 안내"를 제공하고, 가능하면 메타데이터(그리드/FOV)를 보여준다.
      try {
        const head = new TextDecoder("latin1").decode(buf.slice(0, Math.min(buf.byteLength, 262144)));
        // iQLib / 폴더형 원시(.fls) 시그니처
        const sig = /iQscene|iQLib|Scan2DataBase|ScanParameter|DataMode\s+\d+|ScannerParam/i.test(head);
        // 압축 스캔 스트림 토큰
        const u8 = new Uint8Array(buf.slice(0, Math.min(buf.byteLength, 4096)));
        let dollar = 0; for (let i = 0; i < u8.length; i++) if (u8[i] === 0x24) dollar++;
        const streamy = dollar > 20; // $ENC$ 등 토큰 다발
        if (sig || streamy) {
          const meta = this._parseFLSMeta(head);
          this._flsMeta = meta; // loadBuffer 에서 안내에 활용
          // 직접 디코딩은 불가 → count 0 반환(loadBuffer 가 변환 안내 표시)
          return { positions: new Float32Array(0), colors: null, count: 0, faroRaw: true };
        }
      } catch (e) {}
      // 텍스트형(드물게 ASCII 좌표가 들어있는 변형) → sniff
      return this._sniff(buf);
    },

    /** FARO Params/Main 텍스트에서 스캔 메타(그리드·FOV·거리계수) 추출 */
    _parseFLSMeta(head) {
      const num = (re) => { const m = head.match(re); return m ? parseFloat(m[1]) : null; };
      const rows = num(/Name\s+"NumRows"\s*\}?\s*Value\s+(\d+)/i) || num(/NumRows[^0-9]+(\d+)/i);
      const cols = num(/Name\s+"NumCols"\s*\}?\s*Value\s+(\d+)/i) || num(/NumCols[^0-9]+(\d+)/i);
      const rStart = num(/RowStartAngle[^0-9\-]+(-?[\d.]+)/i);
      const rEnd = num(/RowEndAngle[^0-9\-]+(-?[\d.]+)/i);
      const cEnd = num(/ColEndAngle[^0-9\-]+(-?[\d.]+)/i);
      const distFact = num(/DistFactor[^0-9\-]+(-?[\d.]+)/i);
      const distOff = num(/DistOffset[^0-9\-]+(-?[\d.]+)/i);
      const lib = (head.match(/"iQLib"\s+([\d.]+)/i) || [])[1] || null;
      const pts = (rows && cols) ? rows * cols : null;
      return { rows, cols, rStart, rEnd, cEnd, distFact, distOff, lib, pts };
    },

    _sniff(buf) {
      // 텍스트면 XYZ 시도
      try {
        const head = new TextDecoder().decode(buf.slice(0, 256));
        if (/^[\s\d.\-eE,;]+$/.test(head.replace(/\r?\n/g, " ").slice(0, 80))) {
          return this._parseXYZ(buf);
        }
      } catch (e) {}
      return { positions: new Float32Array(0), colors: null, count: 0 };
    },

    /* ── Three.js 렌더링 ── */
    _ensureRenderer() {
      if (this._inited) return;
      const canvas = this._el("fls-canvas");
      if (!canvas || typeof THREE === "undefined") return;
      this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      this.scene = new THREE.Scene();
      this.scene.background = new THREE.Color(0x0a1422);
      this.camera = new THREE.PerspectiveCamera(60, 1, 0.01, 100000);
      const grid = new THREE.GridHelper(10, 20, 0x1b75bb, 0x16324d);
      grid.material.opacity = 0.25; grid.material.transparent = true;
      this.scene.add(grid);
      this._bindControls(canvas);
      this._inited = true;
      // 반응형 리사이즈
      try {
        this._ro = new ResizeObserver(() => this._resize());
        this._ro.observe(this._el("fls-stage"));
      } catch (e) {}
      this._loop();
    },

    _render(parsed) {
      this._ensureRenderer();
      if (!this.scene) { this._showError("WebGL 미지원", "이 브라우저에서 3D 렌더링을 사용할 수 없습니다."); return; }
      // 기존 points 제거
      if (this.points) { this.scene.remove(this.points); this.points.geometry.dispose(); this.points.material.dispose(); this.points = null; }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(parsed.positions, 3));
      let mat;
      if (parsed.colors) {
        geo.setAttribute("color", new THREE.BufferAttribute(parsed.colors, 3));
        mat = new THREE.PointsMaterial({ size: 0.02, vertexColors: true, sizeAttenuation: true });
      } else {
        mat = new THREE.PointsMaterial({ size: 0.02, color: 0x8ec5ff, sizeAttenuation: true });
      }
      geo.computeBoundingBox();
      const bb = geo.boundingBox;
      const cx = (bb.min.x + bb.max.x) / 2, cy = (bb.min.y + bb.max.y) / 2, cz = (bb.min.z + bb.max.z) / 2;
      const size = Math.max(bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z) || 1;
      // 점 크기를 모델 스케일에 맞춤
      mat.size = size / 600;
      this.points = new THREE.Points(geo, mat);
      this.scene.add(this.points);
      this._target = { x: cx, y: cy, z: cz };
      this._rot = { theta: 0.7, phi: 1.05, r: size * 1.6 };
      this._show("fls-stats");
      const stats = this._el("fls-stats");
      if (stats) stats.textContent = parsed.count.toLocaleString() + " pts";
      this._resize();
    },

    _bindControls(canvas) {
      const down = e => {
        const p = e.touches ? e.touches[0] : e;
        this._drag = { x: p.clientX, y: p.clientY, theta: this._rot.theta, phi: this._rot.phi };
      };
      const move = e => {
        if (!this._drag) return;
        const p = e.touches ? e.touches[0] : e;
        const dx = p.clientX - this._drag.x, dy = p.clientY - this._drag.y;
        this._rot.theta = this._drag.theta - dx * 0.005;
        this._rot.phi = Math.max(0.05, Math.min(Math.PI - 0.05, this._drag.phi - dy * 0.005));
      };
      const up = () => { this._drag = null; };
      canvas.addEventListener("mousedown", down);
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
      canvas.addEventListener("touchstart", down, { passive: true });
      canvas.addEventListener("touchmove", e => { move(e); }, { passive: true });
      canvas.addEventListener("touchend", up);
      canvas.addEventListener("wheel", e => {
        e.preventDefault();
        this._rot.r *= (1 + (e.deltaY > 0 ? 0.1 : -0.1));
        this._rot.r = Math.max(0.01, this._rot.r);
      }, { passive: false });
      const rb = this._el("btn-fls-reset");
      if (rb) rb.addEventListener("click", () => {
        if (this.points) { const bb = this.points.geometry.boundingBox; const s = Math.max(bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z) || 1; this._rot = { theta: 0.7, phi: 1.05, r: s * 1.6 }; }
      });
      const cb = this._el("btn-fls-collapse");
      if (cb) cb.addEventListener("click", () => {
        const pane = this._el("fls-pane");
        if (pane) { pane.classList.toggle("fls-collapsed"); setTimeout(() => this._resize(), 260); }
      });
      const sb = this._el("btn-fls-sample");
      if (sb && !sb._bound) { sb._bound = true; sb.addEventListener("click", () => this.loadSample()); }
    },

    _resize() {
      if (!this.renderer) return;
      const stage = this._el("fls-stage");
      if (!stage) return;
      const w = stage.clientWidth || 1, h = stage.clientHeight || 1;
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    },

    _loop() {
      const tick = () => {
        this._raf = requestAnimationFrame(tick);
        if (!this.renderer || !this.scene) return;
        const pane = this._el("fls-pane");
        if (!pane || pane.classList.contains("hidden")) return;
        const { theta, phi, r } = this._rot;
        this.camera.position.set(
          this._target.x + r * Math.sin(phi) * Math.cos(theta),
          this._target.y + r * Math.cos(phi),
          this._target.z + r * Math.sin(phi) * Math.sin(theta)
        );
        this.camera.lookAt(this._target.x, this._target.y, this._target.z);
        this.renderer.render(this.scene, this.camera);
      };
      this._raf = requestAnimationFrame(tick);
    },

    close() { this.showPane(false); }
  };

  /* ══════════════════════════════════════════
     MAP CTRL  — 줌/패닝 + 좌표 변환 + 플라이투
  ══════════════════════════════════════════ */