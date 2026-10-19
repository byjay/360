  const FLS = {
    MAX_POINTS: 1_800_000,     // 렌더 안정 상한 (초과 시 균등 다운샘플)
    // [정본] E57 대용량 메모리 가드 — 실측(커밋 017e532, build-tools/e57-realfile-check.mjs):
    //   PANOPI_Panopi301.e57  51.9MB → 파싱 중 rss 178MB (3.43배)
    //   PANOPI_scan101.e57   219.2MB → 파싱 중 rss 604MB (2.76배)
    // 모바일 브라우저는 탭 메모리가 수백MB~1GB대에서 강제 종료된다(현장 폰에서 쓰는 PWA).
    // 배율은 실측 상한(3.43배)을 반올림해 보수적으로 잡는다 — 추정치임을 문구에도 명시한다.
    E57_LARGE_FILE_BYTES: 100 * 1024 * 1024,   // 100MB 초과 시 경고(추정 메모리 ≈350MB)
    E57_MEM_MULTIPLIER: 3.5,
    renderer: null, scene: null, camera: null, points: null,
    _raf: null, _drag: null, _rot: { theta: 0.6, phi: 1.1, r: 3 },
    _target: { x: 0, y: 0, z: 0 }, _inited: false, _ro: null,
    _mode: "orbit",            // [Navisworks 동작 모방] orbit | pan | section | measure
    _section: null,            // 단면 평면 클리핑 상태
    _measure: null,            // 측정 2점 + 라인/라벨

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
        this._ensureRenderer();
        setTimeout(() => this._resize(), 30);
        // [WO flspano] 패널이 열릴 때마다 360 사진 추출 버튼이 있는지 보장(E57 로드 전에도 SCENE 이미지 버튼은 상시 노출)
        if (typeof FlsPano !== "undefined" && FlsPano._ensureButton) { try { FlsPano._ensureButton(); } catch (e) {} }
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

    _showError(t, h) {
      this._show("fls-error");
      const et = this._el("fls-error-t"), eh = this._el("fls-error-h");
      if (et) et.textContent = t;
      if (eh) eh.textContent = h || "";
    },

    /** 저사양 기기면 임계값을 낮춘다(navigator.deviceMemory 없는 브라우저도 정상 동작 — 그때는 기본값 그대로) */
    _e57Threshold() {
      const dm = (typeof navigator !== "undefined" && typeof navigator.deviceMemory === "number")
        ? navigator.deviceMemory : null;
      // deviceMemory(GB) 4 이하 = 저사양(주로 모바일) — 임계값 절반으로
      return (dm != null && dm <= 4) ? this.E57_LARGE_FILE_BYTES / 2 : this.E57_LARGE_FILE_BYTES;
    },

    /** 파일 크기 → 경고 필요 여부 + 안내 문구(순수 함수, DOM 의존 없음 — 테스트 가능) */
    _e57SizeWarning(byteLength) {
      const threshold = this._e57Threshold();
      if (byteLength <= threshold) return null;
      const mb = (n) => (n / (1024 * 1024)).toFixed(1);
      const estMb = mb(byteLength * this.E57_MEM_MULTIPLIER);
      return "대용량 E57 파일입니다 (" + mb(byteLength) + "MB) — 파싱 중 메모리 사용량이 약 " + estMb
        + "MB 까지 늘어날 수 있습니다(실측 배율 기반 추정치, 실제 값은 파일 내용에 따라 다를 수 있음). "
        + "모바일/저사양 기기에서는 브라우저 탭이 강제 종료될 수 있습니다. 계속하시겠습니까?";
    },

    /** 대용량 확인 다이얼로그(PWA 독립실행모드에서 window.confirm()이 무음 false를
     *  반환하는 문제 때문에 Prompt.confirm — SoT: 30_Prompt.js — 로 통일) */
    async _confirmLargeE57(msg) {
      return await Prompt.confirm("대용량 파일", msg);
    },

    /** ArrayBuffer + 파일명 → 파싱 후 렌더 */
    async loadBuffer(buf, name) {
      const ext = this.extOf(name);
      const badge = this._el("fls-fmt-badge");
      if (badge) badge.textContent = ext ? ("." + ext) : "";
      if (ext === "e57") {
        const warn = this._e57SizeWarning(buf.byteLength);
        if (warn && !(await this._confirmLargeE57(warn))) { this._show("fls-empty"); return; }
      }
      let parsed = null;
      try {
        if (ext === "ply") parsed = this._parsePLY(buf);
        else if (ext === "pcd") parsed = this._parsePCD(buf);
        else if (["xyz", "pts", "asc", "txt"].includes(ext)) parsed = this._parseXYZ(buf);
        else if (ext === "las" || ext === "laz") parsed = this._parseLAS(buf, ext);
        else if (ext === "e57") parsed = this._parseE57(buf);
        else if (ext === "fls") parsed = this._parseFLS(buf, ext);
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
            ".fls(FARO 스캔 폴더) 직접 표시 불가 — E57로 내보내면 바로 열립니다",
            metaLine +
            "FARO .fls 는 단일 파일이 아니라 폴더 컨테이너입니다(실측: Scans/<n>/ScanDataStream0 = 원시 스캔 스트림, " +
            "Params·Calib = 텍스트 설정, ReferencePicture = JPEG 미리보기). 스캔 스트림은 독점 압축($ENC$·$NES$·$GRV$)이라 " +
            "FARO LS SDK 없이는 좌표 디코딩이 불가하고, 폴더 전체를 브라우저로 올릴 수도 없습니다. " +
            "FARO SCENE에서 [내보내기 → E57]로 변환해 첨부하세요 — E57은 이 뷰어가 직접 지원합니다(LAS/PLY도 가능). " +
            "(SCENE이 없으면 CloudCompare + FARO LS 플러그인으로도 변환 가능합니다.) " +
            "지금 기능을 바로 보시려면 아래 ‘샘플 FLS 불러오기’를 누르세요."
          );
        }
        return this._showError("표시할 점이 없습니다", "파일이 비었거나 좌표 데이터를 찾지 못했습니다.");
      }
      this._render(parsed);
      // [WO flspano] E57 로드 후 360 사진 추출 버튼 노출 여부 결정 — 실제 격자 디코딩은 버튼 클릭 시점에만
      // 수행한다(자동 전해상도 재디코딩으로 인한 성능 저하 방지). buf/name 을 그대로 넘겨 재사용(이중 다운로드 없음).
      if (ext === "e57" && typeof FlsPano !== "undefined" && FlsPano.onE57Loaded) {
        try { FlsPano.onE57Loaded(buf, name); } catch (e) {}
      }
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

    /* ══ E57 (ASTM E2807) ══════════════════════════════════════════════════
       [정본] 포맷 상수·주소 변환·논리바이트 읽기는 아래 E57 / _e57* 한 곳에만 둔다(손목록 복제 금지).
       ① 파일 전체가 pageSize 바이트 페이지로 나뉘고 **각 페이지 끝 4B 는 CRC** — 논리 데이터가 아니다.
          물리 오프셋에서 읽으려면 페이지마다 CRC 를 건너뛰며 이어붙여야 한다(_e57Usable / _e57ReadLogical).
          빠뜨리면 XML 도 좌표도 "조용히" 깨진다.
       ② XML 안에 <prototype> 이 여러 개다(색인용 CompressedVector 가 앞에 온다).
          반드시 <points type="CompressedVector"> **뒤에 오는** prototype 을 써야 한다(_e57Prototype).
       ③ 각 바이트스트림 = 그 필드 값들을 LSB 우선으로 비트팩한 것. 값이 패킷 경계를 걸칠 수 있다
          (실측: 2bit 필드 2139개 = 534.75B → 534B 만 실리고 남은 비트는 다음 패킷으로 넘어감).
          → 스트림별 잔여 비트를 이어붙이고, 모든 스트림이 공급 가능한 개수(min)만큼만 레코드를 푼다.
       ④ 대용량(224MB+) 대비: 앞에서부터 순차로 읽으며 MAX_POINTS 에 닿으면 즉시 중단하고,
          recordCount > MAX_POINTS 면 stride 로 균등 다운샘플한다. 버려질 레코드는 값을 풀지 않고
          비트 위치만 건너뛴다(디코딩 비용 O(필드수), 메모리는 항상 상한 이하).
    */
    E57: {
      SIG: "ASTM-E57",
      HEADER_BYTES: 48,              // sig(8) major(4) minor(4) fileLength(8) xmlPhys(8) xmlLen(8) pageSize(8)
      CRC_BYTES: 4,                  // 페이지 끝 CRC
      DEFAULT_PAGE: 1024,
      SECTION_HEADER_BYTES: 32,      // id(1) 예약(7) 논리길이(8) dataPhys(8) indexPhys(8)
      SECTION_ID_CV: 1,              // COMPRESSED_VECTOR_SECTION
      PACKET_HEADER_BYTES: 6,        // type(1) flags(1) len-1(2) bytestreamCount(2)
      PACKET_DATA: 1,                // 0=index, 1=data, 2=empty
      // prototype 필드명 → 역할(숫자). 모르는 필드는 0(비트만 소비하고 버림).
      ROLE: {
        cartesianX: 1, cartesianY: 2, cartesianZ: 3,
        colorRed: 4, colorGreen: 5, colorBlue: 6,
        cartesianInvalidState: 7, sphericalInvalidState: 7,
        sphericalRange: 8, sphericalAzimuth: 9, sphericalElevation: 10,
        // [WO flspano] 격자(스캔 raster) 복원용 — 39_FlsPano.js 가 360 사진 추출에 사용.
        rowIndex: 11, columnIndex: 12, intensity: 13
      }
    },
    // [WO flspano] 격자 추출 시 전체 레코드를 손실 없이 보관(point-cloud 뷰용 MAX_POINTS 와는
    // 별개 상한 — 파노라마 1장 분량은 보통 rows*cols ≈ 수백만이라 그보다 커야 함).
    GRID_MAX_POINTS: 30_000_000,

    /** 한 페이지에서 실제 데이터가 담기는 바이트 수(끝 4B 는 CRC) — CRC 처리의 정본 */
    _e57Usable(pageSize) { return pageSize - this.E57.CRC_BYTES; },
    /** 논리 주소 → 물리 주소 */
    _e57PhysOf(logical, pageSize) {
      const u = this._e57Usable(pageSize);
      return Math.floor(logical / u) * pageSize + (logical % u);
    },
    /** 물리 주소 → 논리 주소 */
    _e57LogicalOf(phys, pageSize) {
      const u = this._e57Usable(pageSize);
      return Math.floor(phys / pageSize) * u + Math.min(phys % pageSize, u);
    },
    /** 물리 오프셋 phys 에서 논리 바이트 len 개를 읽는다(페이지 CRC 건너뜀). 파일 끝이면 짧게 반환. */
    _e57ReadLogical(u8, phys, len, pageSize) {
      const out = new Uint8Array(len);
      const u = this._e57Usable(pageSize);
      let got = 0, p = phys;
      while (got < len) {
        const ps = Math.floor(p / pageSize) * pageSize, ip = p - ps;
        const want = Math.min(u - ip, len - got);
        if (want <= 0) break;
        const end = Math.min(p + want, u8.length);
        if (end <= p) break;
        out.set(u8.subarray(p, end), got);
        got += end - p;
        if (end < p + want) break;          // 파일 끝(잘림)
        p = ps + pageSize;
      }
      return got === len ? out : out.subarray(0, got);
    },

    /** E57 헤더(48B) 판독 */
    _e57Header(buf) {
      const E = this.E57;
      if (buf.byteLength < E.HEADER_BYTES) throw new Error("E57 헤더(48B)보다 파일이 작습니다.");
      const head = new Uint8Array(buf, 0, 8);
      let sig = "";
      for (let i = 0; i < 8; i++) sig += String.fromCharCode(head[i]);
      if (sig !== E.SIG) throw new Error('E57 서명("' + E.SIG + '")이 없습니다 — 확장자만 .e57 인 다른 파일일 수 있습니다.');
      const dv = new DataView(buf);
      const u64 = (o) => dv.getUint32(o, true) + dv.getUint32(o + 4, true) * 4294967296;
      const pageSize = u64(40) || E.DEFAULT_PAGE;
      if (pageSize <= E.CRC_BYTES) throw new Error("E57 pageSize 값이 비정상입니다: " + pageSize);
      return {
        major: dv.getUint32(8, true), minor: dv.getUint32(12, true),
        fileLength: u64(16), xmlPhysOffset: u64(24), xmlLength: u64(32), pageSize
      };
    },

    /** points 태그 **뒤**의 prototype 에서 필드 정의를 뽑는다(손목록 금지 — 파일이 정본) */
    _e57Prototype(xml, tagIndex) {
      const from = tagIndex >= 0 ? tagIndex : 0;
      const s0 = xml.indexOf("<prototype", from);     // ← 반드시 points 태그 뒤에서 찾는다(앞엣것은 색인용)
      const s1 = s0 < 0 ? -1 : xml.indexOf("</prototype>", s0);
      if (s0 < 0 || s1 < 0) throw new Error("E57 prototype 을 찾지 못했습니다.");
      const block = xml.slice(s0, s1);
      const ROLE = this.E57.ROLE;
      const fields = [];
      const re = /<(\w+)\s+type="(Float|Integer|ScaledInteger)"([^>]*?)\/?>/g;
      let m;
      while ((m = re.exec(block))) {
        const name = m[1], type = m[2], at = m[3];
        const attr = (k) => {
          const a = at.match(new RegExp(k + '="(-?[0-9.eE+-]+)"'));
          return a ? Number(a[1]) : null;
        };
        let f;
        if (type === "Float") {
          f = { name, type, bits: /precision="single"/.test(at) ? 32 : 64 };
        } else {
          const min = attr("minimum"), max = attr("maximum");
          if (min === null || max === null || !isFinite(min) || !isFinite(max) || max < min)
            throw new Error("E57 prototype 필드 " + name + " 에 minimum/maximum 이 없어 비트폭을 알 수 없습니다.");
          const range = max - min;
          const bits = range <= 0 ? 0 : Math.ceil(Math.log2(range + 1));
          if (bits > 53) throw new Error("E57 필드 " + name + " 의 비트폭(" + bits + ")이 너무 큽니다.");
          f = { name, type, bits, min, max };
          if (type === "ScaledInteger") { f.scale = attr("scale") || 1; f.offset = attr("offset") || 0; }
        }
        f.role = ROLE[name] || 0;
        // 색 정규화 기준도 파일에서 파생(0~255 가 아닌 0~65535 스캐너가 있다)
        if (f.role >= 4 && f.role <= 6) f.cnorm = (f.type === "Float") ? 1 : (f.max || 255);
        fields.push(f);
      }
      if (!fields.length) throw new Error("E57 prototype 에 필드가 없습니다.");
      return fields;
    },

    /** vectorChild 블록(start~end) 안의 <pose> — 회전(쿼터니언 w,x,y,z) + 이동(x,y,z). 없으면 null.
     *  [WO flspano] 39_FlsPano.js 가 스캔 raster(row/col)를 방위각/고도각으로 바꿀 때 로컬 방향을 구하는 데 쓴다. */
    _e57PoseOf(xml, start, end) {
      const s = xml.indexOf("<pose", start >= 0 ? start : 0);
      if (s < 0 || (end >= 0 && s > end)) return null;
      const e = xml.indexOf("</pose>", s);
      if (e < 0) return null;
      const block = xml.slice(s, e);
      const num = (b, tag) => { const m = b.match(new RegExp("<" + tag + "[^>]*>([^<]*)<")); return m && m[1] !== "" ? parseFloat(m[1]) : null; };
      const rs = block.indexOf("<rotation"), re2 = block.indexOf("</rotation>");
      const ts = block.indexOf("<translation");
      const rBlock = rs >= 0 ? block.slice(rs, re2 >= 0 ? re2 : block.length) : "";
      const tBlock = ts >= 0 ? block.slice(ts) : "";
      const rot = { w: num(rBlock, "w"), x: num(rBlock, "x"), y: num(rBlock, "y"), z: num(rBlock, "z") };
      const tr = { x: num(tBlock, "x"), y: num(tBlock, "y"), z: num(tBlock, "z") };
      if (rot.w == null || !isFinite(rot.w)) return null;
      return { rotation: rot, translation: tr };
    },

    /** vectorChild 블록(start~end) 안의 <indexBounds> — rowMaximum/columnMaximum(스캔 raster 크기). 없으면 null. */
    _e57IndexBoundsOf(xml, start, end) {
      const s = xml.indexOf("<indexBounds", start >= 0 ? start : 0);
      if (s < 0 || (end >= 0 && s > end)) return null;
      const e = xml.indexOf("</indexBounds>", s);
      if (e < 0) return null;
      const block = xml.slice(s, e);
      const num = (tag) => { const m = block.match(new RegExp("<" + tag + "[^>]*>([^<]*)<")); return m && m[1] !== "" ? parseInt(m[1], 10) : null; };
      const rowMax = num("rowMaximum"), colMax = num("columnMaximum");
      if (rowMax == null || colMax == null) return null;
      return { rowMin: num("rowMinimum") || 0, rowMax, colMin: num("columnMinimum") || 0, colMax };
    },

    /** 한 스트림에 새 바이트를 이어붙인다(이미 소비한 바이트는 버리고 잔여 비트는 유지) */
    _e57Feed(st, add) {
      const keep = st.bit >> 3;
      const rem = st.bytes.length - keep;
      const nb = new Uint8Array(rem + add.length);
      nb.set(st.bytes.subarray(keep), 0);
      nb.set(add, rem);
      st.bytes = nb;
      st.bit = st.bit & 7;
    },

    /** LSB 우선 비트 읽기(n ≤ 32). 바이트 정렬이면 바이트 단위 고속 경로. */
    _e57Bits(st, n) {
      if (n === 0) return 0;
      const b = st.bytes;
      if ((st.bit & 7) === 0 && (n & 7) === 0) {
        let o = st.bit >> 3, v = 0, mul = 1;
        for (let i = 0; i < n; i += 8) { v += b[o++] * mul; mul *= 256; }
        st.bit += n;
        return v;
      }
      let v = 0, mul = 1;
      for (let i = 0; i < n; i++) {
        v += ((b[st.bit >> 3] >> (st.bit & 7)) & 1) * mul;
        mul *= 2; st.bit++;
      }
      return v;
    },

    /** 필드 1개 값 디코딩 */
    _e57Value(f, st, scratch) {
      if (f.type === "Float") {
        if (f.bits === 32) { scratch.setUint32(0, this._e57Bits(st, 32), true); return scratch.getFloat32(0, true); }
        const lo = this._e57Bits(st, 32), hi = this._e57Bits(st, 32);
        scratch.setUint32(0, lo, true); scratch.setUint32(4, hi, true);
        return scratch.getFloat64(0, true);
      }
      const raw = f.bits <= 32
        ? this._e57Bits(st, f.bits)
        : this._e57Bits(st, 32) + this._e57Bits(st, f.bits - 32) * 4294967296;
      const v = f.min + raw;
      return f.type === "ScaledInteger" ? v * f.scale + f.offset : v;
    },

    /** ArrayBuffer(.e57) → { positions, colors, count[, grid] } — _parsePLY/_parseLAS 와 동일 계약.
     *  opts.grid=true 면 rowIndex/columnIndex 격자가 있는 섹션을 전해상도(무손실)로 추가 디코딩해
     *  grid:{rows,cols,n,row,col,localXYZ,rgb,intensity,pose} 를 덧붙인다(39_FlsPano.js 360 사진 추출용).
     *  grid 생성 비용은 요청 시에만 발생 — 기존 3D 뷰 경로(opts 없음)는 동작·성능 변화 없음. */
    _parseE57(buf, opts) {
      const u8 = new Uint8Array(buf);
      const h = this._e57Header(buf);
      const xmlBytes = this._e57ReadLogical(u8, h.xmlPhysOffset, h.xmlLength, h.pageSize);
      if (!xmlBytes.length) throw new Error("E57 XML 섹션을 읽지 못했습니다(물리오프셋 " + h.xmlPhysOffset + ").");
      const xml = new TextDecoder("utf-8").decode(xmlBytes);

      // 스캔이 여러 개면 points CompressedVector 도 여러 개 → 순서대로 이어 읽는다
      const secs = [];
      const re = /<points\s[^>]*type="CompressedVector"[^>]*>/g;
      let m;
      while ((m = re.exec(xml))) {
        const fo = m[0].match(/fileOffset="(\d+)"/);
        if (!fo) continue;
        const rc = m[0].match(/recordCount="(\d+)"/);
        const vcStart = xml.lastIndexOf("<vectorChild", m.index);
        secs.push({
          at: m.index, fileOffset: Number(fo[1]), recordCount: rc ? Number(rc[1]) : 0,
          pose: this._e57PoseOf(xml, vcStart >= 0 ? vcStart : 0, m.index),
          indexBounds: this._e57IndexBoundsOf(xml, vcStart >= 0 ? vcStart : 0, m.index)
        });
      }
      if (!secs.length) throw new Error("E57 안에 점 데이터(<points type=\"CompressedVector\">)가 없습니다.");
      secs.forEach(s => { s.fields = this._e57Prototype(xml, s.at); });

      const total = secs.reduce((s, x) => s + x.recordCount, 0);
      const cap = Math.min(this.MAX_POINTS, total || this.MAX_POINTS);
      const hasColor = secs.some(s => s.fields.some(f => f.role >= 4 && f.role <= 6));
      const sink = {
        pos: new Float32Array(cap * 3),
        col: hasColor ? new Float32Array(cap * 3) : null,
        cap, kept: 0, invalid: 0,
        stride: (total > this.MAX_POINTS) ? Math.ceil(total / this.MAX_POINTS) : 1
      };
      for (const s of secs) {
        if (sink.kept >= cap) break;
        this._e57ReadSection(u8, s, h.pageSize, sink);
      }
      if (!sink.kept) {
        throw new Error("유효한 점을 찾지 못했습니다 (recordCount=" + total + ", 무효점 " + sink.invalid + "). "
          + "좌표 필드(cartesianX/Y/Z 또는 sphericalRange)가 없거나 모두 무효 측정값일 수 있습니다.");
      }
      const result = this._decim(sink.pos.subarray(0, sink.kept * 3), sink.col ? sink.col.subarray(0, sink.kept * 3) : null);
      if (opts && opts.grid) {
        const gsec = secs.find(s => s.fields.some(f => f.role === 11) && s.fields.some(f => f.role === 12));
        if (gsec) {
          const g = this._e57ReadGridSection(u8, gsec, h.pageSize, this.GRID_MAX_POINTS);
          if (g.n) {
            let rowMax = gsec.indexBounds ? gsec.indexBounds.rowMax : null;
            let colMax = gsec.indexBounds ? gsec.indexBounds.colMax : null;
            if (rowMax == null) { rowMax = 0; for (let i = 0; i < g.n; i++) if (g.row[i] > rowMax) rowMax = g.row[i]; }
            if (colMax == null) { colMax = 0; for (let i = 0; i < g.n; i++) if (g.col[i] > colMax) colMax = g.col[i]; }
            result.grid = {
              rows: rowMax + 1, cols: colMax + 1, n: g.n,
              row: g.row, col: g.col, localXYZ: g.xyz, rgb: g.rgb, intensity: g.intensity,
              pose: gsec.pose
            };
          }
        }
      }
      return result;
    },

    /** CompressedVector 섹션 1개를 앞에서부터 스트리밍 디코딩해 sink 에 채운다 */
    _e57ReadSection(u8, sec, pageSize, sink) {
      const E = this.E57, fields = sec.fields, nf = fields.length;
      const sh = this._e57ReadLogical(u8, sec.fileOffset, E.SECTION_HEADER_BYTES, pageSize);
      if (sh.length < E.SECTION_HEADER_BYTES) throw new Error("E57 CompressedVector 섹션 헤더를 읽지 못했습니다.");
      if (sh[0] !== E.SECTION_ID_CV) throw new Error("E57 섹션 id 가 CompressedVector(1)가 아닙니다: " + sh[0]);
      const sdv = new DataView(sh.buffer, sh.byteOffset, sh.byteLength);
      const dataPhys = sdv.getUint32(16, true) + sdv.getUint32(20, true) * 4294967296;

      const cartesian = fields.some(f => f.role >= 1 && f.role <= 3);
      const scratch = new DataView(new ArrayBuffer(8));
      const streams = [];
      for (let i = 0; i < nf; i++) streams.push({ bytes: new Uint8Array(0), bit: 0 });
      const nRec = sec.recordCount;
      let phys = dataPhys, done = 0;

      while (sink.kept < sink.cap) {
        if (nRec && done >= nRec) break;
        if (phys >= u8.length) break;
        const ph = this._e57ReadLogical(u8, phys, E.PACKET_HEADER_BYTES, pageSize);
        if (ph.length < E.PACKET_HEADER_BYTES) break;
        const packetLen = (ph[2] | (ph[3] << 8)) + 1;
        if (packetLen < E.PACKET_HEADER_BYTES) throw new Error("E57 패킷 길이가 비정상입니다: " + packetLen);
        const next = this._e57PhysOf(this._e57LogicalOf(phys, pageSize) + packetLen, pageSize);
        if (ph[0] !== E.PACKET_DATA) { phys = next; continue; }   // index/empty 패킷은 건너뜀
        const nStreams = ph[4] | (ph[5] << 8);
        if (nStreams !== nf)
          throw new Error("E57 바이트스트림 수(" + nStreams + ")가 prototype 필드 수(" + nf + ")와 다릅니다.");
        const full = this._e57ReadLogical(u8, phys, packetLen, pageSize);
        if (full.length < packetLen) break;                       // 잘린 파일 — 여기까지만
        let cur = E.PACKET_HEADER_BYTES + nStreams * 2;
        for (let i = 0; i < nStreams; i++) {
          const o = E.PACKET_HEADER_BYTES + i * 2;
          const len = full[o] | (full[o + 1] << 8);
          this._e57Feed(streams[i], full.subarray(cur, cur + len));
          cur += len;
        }
        // 모든 스트림이 공급 가능한 만큼만 푼다(값이 패킷 경계를 걸치므로 min)
        let avail = Infinity;
        for (let i = 0; i < nf; i++) {
          const bits = fields[i].bits;
          if (!bits) continue;
          const a = Math.floor((streams[i].bytes.length * 8 - streams[i].bit) / bits);
          if (a < avail) avail = a;
        }
        if (avail === Infinity) avail = nRec ? nRec - done : 0;
        if (nRec) avail = Math.min(avail, nRec - done);
        if (avail <= 0) { phys = next; continue; }

        for (let n = 0; n < avail && sink.kept < sink.cap; n++) {
          if (done % sink.stride !== 0) {          // 균등 다운샘플: 비트만 건너뛰고 값은 풀지 않는다
            for (let i = 0; i < nf; i++) streams[i].bit += fields[i].bits;
            done++;
            continue;
          }
          let x = 0, y = 0, z = 0, r = 1, g = 1, b = 1, bad = 0, rng = 0, az = 0, el = 0;
          for (let i = 0; i < nf; i++) {
            const f = fields[i], v = this._e57Value(f, streams[i], scratch);
            switch (f.role) {
              case 1: x = v; break;
              case 2: y = v; break;
              case 3: z = v; break;
              case 4: r = v / f.cnorm; break;
              case 5: g = v / f.cnorm; break;
              case 6: b = v / f.cnorm; break;
              case 7: if (v !== 0) bad = 1; break;
              case 8: rng = v; break;
              case 9: az = v; break;
              case 10: el = v; break;
              default: break;                      // 모르는 필드 — 비트만 소비
            }
          }
          done++;
          if (bad) { sink.invalid++; continue; }
          if (!cartesian) {                        // 구면좌표 스캔 → 직교로 변환(E57 규격)
            const c = Math.cos(el);
            x = rng * c * Math.cos(az); y = rng * c * Math.sin(az); z = rng * Math.sin(el);
          }
          if (!isFinite(x) || !isFinite(y) || !isFinite(z)) { sink.invalid++; continue; }
          const k = sink.kept;
          sink.pos[k * 3] = x; sink.pos[k * 3 + 1] = y; sink.pos[k * 3 + 2] = z;
          if (sink.col) { sink.col[k * 3] = r; sink.col[k * 3 + 1] = g; sink.col[k * 3 + 2] = b; }
          sink.kept++;
        }
        phys = next;
      }
    },

    /** [WO flspano] CompressedVector 섹션 1개를 rowIndex/columnIndex 와 함께 **전해상도**(디시메이션 없음)로
     *  디코딩한다 — point-cloud 뷰용 _e57ReadSection(stride 다운샘플)과 다른 용도이므로 별도 함수로 둔다.
     *  바이트/비트 읽기 원시함수(_e57ReadLogical/_e57Feed/_e57Bits/_e57Value 등)는 그대로 재사용(SoT 유지). */
    _e57ReadGridSection(u8, sec, pageSize, capN) {
      const E = this.E57, fields = sec.fields, nf = fields.length;
      const sh = this._e57ReadLogical(u8, sec.fileOffset, E.SECTION_HEADER_BYTES, pageSize);
      if (sh.length < E.SECTION_HEADER_BYTES) throw new Error("E57 CompressedVector 섹션 헤더를 읽지 못했습니다.");
      if (sh[0] !== E.SECTION_ID_CV) throw new Error("E57 섹션 id 가 CompressedVector(1)가 아닙니다: " + sh[0]);
      const sdv = new DataView(sh.buffer, sh.byteOffset, sh.byteLength);
      const dataPhys = sdv.getUint32(16, true) + sdv.getUint32(20, true) * 4294967296;

      const cartesian = fields.some(f => f.role >= 1 && f.role <= 3);
      const hasColor = fields.some(f => f.role >= 4 && f.role <= 6);
      const hasIntensity = fields.some(f => f.role === 13);
      const scratch = new DataView(new ArrayBuffer(8));
      const streams = [];
      for (let i = 0; i < nf; i++) streams.push({ bytes: new Uint8Array(0), bit: 0 });
      const cap = Math.min(sec.recordCount || capN, capN);
      const row = new Int32Array(cap), col = new Int32Array(cap);
      const xyz = cartesian ? new Float32Array(cap * 3) : null;
      const rgb = hasColor ? new Uint8Array(cap * 3) : null;
      const inten = hasIntensity ? new Float32Array(cap) : null;
      let kept = 0, phys = dataPhys, done = 0;

      while (kept < cap) {
        if (sec.recordCount && done >= sec.recordCount) break;
        if (phys >= u8.length) break;
        const ph = this._e57ReadLogical(u8, phys, E.PACKET_HEADER_BYTES, pageSize);
        if (ph.length < E.PACKET_HEADER_BYTES) break;
        const packetLen = (ph[2] | (ph[3] << 8)) + 1;
        if (packetLen < E.PACKET_HEADER_BYTES) throw new Error("E57 패킷 길이가 비정상입니다: " + packetLen);
        const next = this._e57PhysOf(this._e57LogicalOf(phys, pageSize) + packetLen, pageSize);
        if (ph[0] !== E.PACKET_DATA) { phys = next; continue; }
        const nStreams = ph[4] | (ph[5] << 8);
        if (nStreams !== nf)
          throw new Error("E57 바이트스트림 수(" + nStreams + ")가 prototype 필드 수(" + nf + ")와 다릅니다.");
        const full = this._e57ReadLogical(u8, phys, packetLen, pageSize);
        if (full.length < packetLen) break;
        let cur = E.PACKET_HEADER_BYTES + nStreams * 2;
        for (let i = 0; i < nStreams; i++) {
          const o = E.PACKET_HEADER_BYTES + i * 2;
          const len = full[o] | (full[o + 1] << 8);
          this._e57Feed(streams[i], full.subarray(cur, cur + len));
          cur += len;
        }
        let avail = Infinity;
        for (let i = 0; i < nf; i++) {
          const bits = fields[i].bits;
          if (!bits) continue;
          const a = Math.floor((streams[i].bytes.length * 8 - streams[i].bit) / bits);
          if (a < avail) avail = a;
        }
        if (avail === Infinity) avail = sec.recordCount ? sec.recordCount - done : 0;
        if (sec.recordCount) avail = Math.min(avail, sec.recordCount - done);
        if (avail <= 0) { phys = next; continue; }

        for (let n = 0; n < avail && kept < cap; n++) {           // ← 디시메이션 없음: 매 레코드 디코딩(전해상도)
          let x = 0, y = 0, z = 0, r = 1, g = 1, b = 1, it = 0, rIdx = 0, cIdx = 0, bad = 0, rng = 0, az = 0, el = 0;
          for (let i = 0; i < nf; i++) {
            const f = fields[i], v = this._e57Value(f, streams[i], scratch);
            switch (f.role) {
              case 1: x = v; break;
              case 2: y = v; break;
              case 3: z = v; break;
              case 4: r = v / f.cnorm; break;
              case 5: g = v / f.cnorm; break;
              case 6: b = v / f.cnorm; break;
              case 7: if (v !== 0) bad = 1; break;
              case 8: rng = v; break;
              case 9: az = v; break;
              case 10: el = v; break;
              case 11: rIdx = v; break;
              case 12: cIdx = v; break;
              case 13: it = v; break;
              default: break;
            }
          }
          done++;
          if (bad) continue;
          if (!cartesian) {
            const c = Math.cos(el);
            x = rng * c * Math.cos(az); y = rng * c * Math.sin(az); z = rng * Math.sin(el);
          }
          if (xyz && (!isFinite(x) || !isFinite(y) || !isFinite(z))) continue;
          const k = kept;
          row[k] = rIdx; col[k] = cIdx;
          if (xyz) { xyz[k * 3] = x; xyz[k * 3 + 1] = y; xyz[k * 3 + 2] = z; }
          if (rgb) { rgb[k * 3] = Math.round(r * 255); rgb[k * 3 + 1] = Math.round(g * 255); rgb[k * 3 + 2] = Math.round(b * 255); }
          if (inten) inten[k] = it;
          kept++;
        }
        phys = next;
      }
      return {
        n: kept,
        row: row.subarray(0, kept), col: col.subarray(0, kept),
        xyz: xyz ? xyz.subarray(0, kept * 3) : null,
        rgb: rgb ? rgb.subarray(0, kept * 3) : null,
        intensity: inten ? inten.subarray(0, kept) : null
      };
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
      // ── [마스터 요청] 업라이트 핀(퀸) 그룹: 어떤 각도에서 봐도 '서있는' 마커 ──
      this._markers = new THREE.Group();
      this.scene.add(this._markers);
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
      // ── [마스터 요청] 모델 중심 위에 '서있는 지도 핀'을 1개 배치(예시/기준점) ──
      this._placeUprightPin(cx, bb.max.y, cz, size);
      this._resize();
    },

    /* ── [마스터 요청 정정] 지도 '핀(Pin)' 3D 마커 만들기 ────────────────────
       · 지도에 꽂는 물방울(teardrop) 위치 핀 — 체스 퀸 X.
       · 구조: (아래)뾰족한 끝 → (위)둥근 머리, 끝점이 표면을 가리킴.
       · 어느 각도에서 봐도 항상 '서있다' → _loop에서 yaw만 빌보드, 절대 눕지않음.
       · 표면에 닿는 그림자 디스크로 '꽂혀있는' 인지 강화.                       */
    _makeUprightPin(color) {
      const g = new THREE.Group();
      const col = color || 0x2f6df0;
      // 바닥 그림자 디스크(표면에 평평하게 누움) — 핀이 '꽂혀있다'는 인지
      const shadow = new THREE.Mesh(
        new THREE.CircleGeometry(0.42, 24),
        new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false })
      );
      shadow.rotation.x = -Math.PI / 2;
      shadow.position.y = 0.002;
      g.add(shadow);
      // 핀 꼬리(뾰족한 끝) — 끝점이 바닥(표면)을 향함. 위로 갈수록 넓어짐
      const tail = new THREE.Mesh(
        new THREE.ConeGeometry(0.52, 1.35, 24),
        new THREE.MeshBasicMaterial({ color: col })
      );
      tail.position.y = 0.675;          // 끝(y=0)이 표면, 넓은쪽(y=1.35)이 머리쪽
      g.add(tail);
      // 핀 머리(둥근 물방울 머리) — 위쪽 구
      const head = new THREE.Mesh(
        new THREE.SphereGeometry(0.62, 24, 18),
        new THREE.MeshBasicMaterial({ color: col })
      );
      head.position.y = 1.62;
      g.add(head);
      // 머리 안 흰색 도넛(지도 핀의 구멍 느낌) — 카메라쪽 면에 항상 보이도록 빌보드 자식
      const hole = new THREE.Mesh(
        new THREE.SphereGeometry(0.30, 20, 14),
        new THREE.MeshBasicMaterial({ color: 0xffffff })
      );
      hole.position.y = 1.62;
      g.add(hole);
      g.userData.upright = true;        // 루프에서 빌보드 처리 대상 표시
      g.userData.pinHeight = 2.24;      // 끝~머리 전체 높이(배치 보정용)
      return g;
    },

    /** 모델 중심 위에 업라이트 핀 1개 배치(scale 자동) */
    _placeUprightPin(x, topY, z, modelSize) {
      if (!this._markers || typeof THREE === "undefined") return;
      // 기존 마커 제거
      while (this._markers.children.length) {
        const m = this._markers.children.pop();
        m.traverse && m.traverse(o => { o.geometry && o.geometry.dispose && o.geometry.dispose(); o.material && o.material.dispose && o.material.dispose(); });
        this._markers.remove(m);
      }
      const pin = this._makeUprightPin(0x2f6df0);
      const s = (modelSize || 1) * 0.06;   // 모델 크기의 6% 정도 높이
      pin.scale.setScalar(s);
      // 핀의 뾰족한 끝(local y=0)이 표면(topY)에 정확히 닿도록 배치
      pin.position.set(x, topY + (modelSize || 1) * 0.004, z);
      this._markers.add(pin);
    },

    /* ── [Navisworks 동작 모방] 검토 모드 전환 ──────────────────────────────
       orbit  : 드래그=3D 회전(스피어 카메라)
       pan    : 드래그=화면 평행이동(타깃 이동)
       section : 드래그=수직 단면 클리핑 평면 이동(잘라보기)
       measure : 클릭 2점 = 거리 측정(라인+라벨)                              */
    setMode(mode) {
      const ok = ["orbit", "pan", "section", "measure"];
      if (!ok.includes(mode)) return;
      this._mode = mode;
      // 단면 모드 해제 시 클리핑 평면 제거
      if (mode !== "section") this._clearSection();
      // 측정 모드 해제 시 측정 마커 제거
      if (mode !== "measure") this._clearMeasure();
      // 버튼 active 토글
      ["orbit", "pan", "section", "measure"].forEach(m => {
        const b = this._el("btn-cad-" + m);
        if (b) b.classList.toggle("active", m === mode);
      });
      // 커서 힌트
      const cv = this._el("fls-canvas");
      if (cv) cv.style.cursor = (mode === "measure") ? "crosshair" : (mode === "pan" ? "move" : "grab");
    },

    _clearSection() {
      if (this.renderer) this.renderer.clippingPlanes = [];
      this._section = null;
    },
    /** 수직(Y) 클리핑 평면 적용 — offset 위쪽만 보이게 잘라보기 */
    _applySection(offset) {
      if (!this.renderer || typeof THREE === "undefined") return;
      this.renderer.localClippingEnabled = true;
      // 평면 법선 (0,1,0): y >= -constant 영역만 표시
      const plane = (this._section && this._section.plane) || new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
      const base = this._target ? this._target.y : 0;
      plane.constant = -(base + offset);
      this.renderer.clippingPlanes = [plane];
      this._section = { plane, offset };
    },
    _clearMeasure() {
      if (this._measure && this.scene) {
        if (this._measure.line) { this.scene.remove(this._measure.line); this._measure.line.geometry.dispose(); this._measure.line.material.dispose(); }
        (this._measure.dots || []).forEach(d => { this.scene.remove(d); d.geometry.dispose(); d.material.dispose(); });
      }
      this._measure = null;
      const lab = this._el("fls-measure-label");
      if (lab) lab.classList.add("hidden");
    },

    /** 화면 좌표 → 포인트 클라우드 표면의 3D 좌표(레이캐스트) */
    _pick(clientX, clientY) {
      if (!this.points || typeof THREE === "undefined") return null;
      const stage = this._el("fls-stage");
      const rect = (this._el("fls-canvas") || stage).getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1
      );
      const rc = new THREE.Raycaster();
      // 포인트 클라우드용 임계값(모델 스케일 비례)
      const s = this._rot.r || 1;
      rc.params.Points = { threshold: s * 0.02 };
      rc.setFromCamera(ndc, this.camera);
      const hit = rc.intersectObject(this.points, false);
      return hit && hit.length ? hit[0].point.clone() : null;
    },

    _addMeasurePoint(pt) {
      if (!this._measure) this._measure = { pts: [], dots: [], line: null };
      // 이미 2점이면 리셋하고 새로 시작
      if (this._measure.pts.length >= 2) this._clearMeasure(), this._measure = { pts: [], dots: [], line: null };
      const dot = new THREE.Mesh(
        new THREE.SphereGeometry((this._rot.r || 1) * 0.01, 12, 10),
        new THREE.MeshBasicMaterial({ color: 0xffd54a })
      );
      dot.position.copy(pt);
      this.scene.add(dot);
      this._measure.dots.push(dot);
      this._measure.pts.push(pt);
      if (this._measure.pts.length === 2) {
        const [a, b] = this._measure.pts;
        const g = new THREE.BufferGeometry().setFromPoints([a, b]);
        const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xffd54a }));
        this.scene.add(line);
        this._measure.line = line;
        const dist = a.distanceTo(b);
        const lab = this._el("fls-measure-label");
        if (lab) { lab.textContent = "" + dist.toFixed(3) + " m"; lab.classList.remove("hidden"); }
      }
    },

    _bindControls(canvas) {
      const down = e => {
        const p = e.touches ? e.touches[0] : e;
        if (this._mode === "measure") {
          const pt = this._pick(p.clientX, p.clientY);
          if (pt) this._addMeasurePoint(pt);
          return; // 측정은 드래그 회전 안함
        }
        this._drag = {
          x: p.clientX, y: p.clientY,
          theta: this._rot.theta, phi: this._rot.phi,
          tx: this._target.x, ty: this._target.y, tz: this._target.z,
          sec: this._section ? this._section.offset : 0
        };
      };
      const move = e => {
        if (!this._drag) return;
        const p = e.touches ? e.touches[0] : e;
        const dx = p.clientX - this._drag.x, dy = p.clientY - this._drag.y;
        if (this._mode === "pan") {
          // 화면 평행 이동: 카메라 right/up 벡터 기준 타깃 이동
          const r = this._rot.r || 1;
          const sp = r * 0.0016;
          const right = new THREE.Vector3(), up = new THREE.Vector3(), fwd = new THREE.Vector3();
          this.camera.getWorldDirection(fwd);
          right.crossVectors(fwd, this.camera.up).normalize();
          up.copy(this.camera.up).normalize();
          this._target.x = this._drag.tx - right.x * dx * sp + up.x * dy * sp;
          this._target.y = this._drag.ty - right.y * dx * sp + up.y * dy * sp;
          this._target.z = this._drag.tz - right.z * dx * sp + up.z * dy * sp;
        } else if (this._mode === "section") {
          // 수직(Y) 단면 평면을 드래그로 위아래 이동
          this._applySection(this._drag.sec - dy * (this._rot.r || 1) * 0.002);
        } else {
          // orbit (기본)
          this._rot.theta = this._drag.theta - dx * 0.005;
          this._rot.phi = Math.max(0.05, Math.min(Math.PI - 0.05, this._drag.phi - dy * 0.005));
        }
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
      // ── [Navisworks 동작 모방] CAD 툴바 모드 버튼 바인딩 ──
      ["orbit", "pan", "section", "measure"].forEach(m => {
        const b = this._el("btn-cad-" + m);
        if (b && !b._bound) { b._bound = true; b.addEventListener("click", () => this.setMode(m)); }
      });
      this.setMode("orbit");
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
        // ── [마스터 요청] 업라이트 핀 빌보드: 카메라 쪽으로 yaw 만 회전 → 항상 '서있음' ──
        if (this._markers && this._markers.children.length) {
          const cam = this.camera.position;
          for (const m of this._markers.children) {
            if (!m.userData || !m.userData.upright) continue;
            const dx = cam.x - m.position.x;
            const dz = cam.z - m.position.z;
            m.rotation.set(0, Math.atan2(dx, dz), 0); // Y축 회전만(절대 눕지 않음)
          }
        }
        this.renderer.render(this.scene, this.camera);
      };
      this._raf = requestAnimationFrame(tick);
    },

    close() { this.showPane(false); }
  };

  /* ══════════════════════════════════════════
     MAP CTRL  — 줌/패닝 + 좌표 변환 + 플라이투
  ══════════════════════════════════════════ */