  /* ══════════════════════════════════════════════════════════════
     ZIP STORE — 표준 zip(무압축 STORE) 작성기 (WO 20261010-delivery 요구 A-6)
     ────────────────────────────────────────────────────────────────
     납품 묶음(보고서 HTML + 축소 사진)을 하나의 파일로 내려받기 위한 최소 구현. 새 의존성 0.
     - 압축 0(STORE, method 0): 사진은 이미 JPEG 라 deflate 이득이 거의 없다 → 구현·검증 비용이 가장 낮은 쪽.
     - 구조(PKWARE APPNOTE 4.3): [로컬 헤더 + 이름 + 데이터]×N → [중앙 디렉터리]×N → EOCD.
     - 이름 = UTF-8, 범용 플래그 bit 11(0x0800) 세팅(한글 파일명 깨짐 방지).
     - 🔴 ZIP64 미지원 — 4 GiB·65535개를 넘으면 조용히 깨진 파일을 만들지 않고 예외를 던진다.
     순수(입력 바이트 → 출력 바이트). DOM 은 blob() 하나만(있으면) 쓴다.
  ══════════════════════════════════════════════════════════════ */
  const ZipStore = {
    _table: null,
    _crcTable() {
      if (this._table) return this._table;
      const t = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c >>> 0;
      }
      this._table = t;
      return t;
    },
    /** CRC-32(IEEE 802.3, zip 과 같은 다항식) — Uint8Array → 부호 없는 32비트 정수 */
    crc32(bytes) {
      const t = this._crcTable();
      let c = 0xFFFFFFFF;
      for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
      return (c ^ 0xFFFFFFFF) >>> 0;
    },
    _utf8(s) {
      if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(String(s));
      const bin = unescape(encodeURIComponent(String(s)));
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    },
    /** MS-DOS 날짜/시각(로컬) — 1980 이전은 1980-01-01 로 고정(형식 한계). */
    _dos(d) {
      const y = Math.max(1980, d.getFullYear());
      return {
        time: ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() >> 1) & 31),
        date: (((y - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31)
      };
    },
    /** files: [{ name: string, data: Uint8Array|string }] → Uint8Array(zip). mtime = Date(생략 시 현재). */
    build(files, mtime) {
      const list = Array.isArray(files) ? files : [];
      if (list.length > 0xFFFF) throw new Error("zip: 파일이 65535개를 넘습니다(ZIP64 미지원)");
      const dos = this._dos(mtime instanceof Date ? mtime : new Date());
      const seen = new Set();
      const ents = list.map((f) => {
        const name = String(f && f.name || "").replace(/\\/g, "/").replace(/^\/+/, "");
        if (!name || name.split("/").some((seg) => seg === "..")) throw new Error("zip: 잘못된 파일 이름 " + JSON.stringify(name));
        if (seen.has(name)) throw new Error("zip: 같은 이름이 두 번 있습니다 " + JSON.stringify(name));
        seen.add(name);
        const data = typeof f.data === "string" ? this._utf8(f.data) : (f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data || 0));
        return { nameBytes: this._utf8(name), data, crc: this.crc32(data) };
      });
      let localSize = 0, centralSize = 0;
      ents.forEach((e) => { localSize += 30 + e.nameBytes.length + e.data.length; centralSize += 46 + e.nameBytes.length; });
      const total = localSize + centralSize + 22;
      if (localSize > 0xFFFFFFFF || total > 0xFFFFFFFF) throw new Error("zip: 4 GiB 를 넘습니다(ZIP64 미지원)");
      const out = new Uint8Array(total);
      const dv = new DataView(out.buffer);
      let p = 0;
      const FLAG_UTF8 = 0x0800;
      ents.forEach((e) => {
        e.offset = p;
        dv.setUint32(p, 0x04034b50, true);       // 로컬 파일 헤더 시그니처
        dv.setUint16(p + 4, 20, true);           // 풀기에 필요한 버전 2.0
        dv.setUint16(p + 6, FLAG_UTF8, true);
        dv.setUint16(p + 8, 0, true);            // 0 = STORE(무압축)
        dv.setUint16(p + 10, dos.time, true);
        dv.setUint16(p + 12, dos.date, true);
        dv.setUint32(p + 14, e.crc, true);
        dv.setUint32(p + 18, e.data.length, true); // 압축 크기 = 원본 크기
        dv.setUint32(p + 22, e.data.length, true);
        dv.setUint16(p + 26, e.nameBytes.length, true);
        dv.setUint16(p + 28, 0, true);           // extra 길이
        out.set(e.nameBytes, p + 30);
        out.set(e.data, p + 30 + e.nameBytes.length);
        p += 30 + e.nameBytes.length + e.data.length;
      });
      const cdStart = p;
      ents.forEach((e) => {
        dv.setUint32(p, 0x02014b50, true);       // 중앙 디렉터리 시그니처
        dv.setUint16(p + 4, 20, true);           // 만든 버전
        dv.setUint16(p + 6, 20, true);           // 풀기에 필요한 버전
        dv.setUint16(p + 8, FLAG_UTF8, true);
        dv.setUint16(p + 10, 0, true);
        dv.setUint16(p + 12, dos.time, true);
        dv.setUint16(p + 14, dos.date, true);
        dv.setUint32(p + 16, e.crc, true);
        dv.setUint32(p + 20, e.data.length, true);
        dv.setUint32(p + 24, e.data.length, true);
        dv.setUint16(p + 28, e.nameBytes.length, true);
        dv.setUint16(p + 30, 0, true);           // extra
        dv.setUint16(p + 32, 0, true);           // comment
        dv.setUint16(p + 34, 0, true);           // 디스크 번호
        dv.setUint16(p + 36, 0, true);           // 내부 속성
        dv.setUint32(p + 38, 0, true);           // 외부 속성
        dv.setUint32(p + 42, e.offset, true);    // 로컬 헤더 위치
        out.set(e.nameBytes, p + 46);
        p += 46 + e.nameBytes.length;
      });
      dv.setUint32(p, 0x06054b50, true);         // EOCD
      dv.setUint16(p + 4, 0, true);
      dv.setUint16(p + 6, 0, true);
      dv.setUint16(p + 8, ents.length, true);
      dv.setUint16(p + 10, ents.length, true);
      dv.setUint32(p + 12, p - cdStart, true);   // 중앙 디렉터리 크기
      dv.setUint32(p + 16, cdStart, true);       // 중앙 디렉터리 시작
      dv.setUint16(p + 20, 0, true);             // 주석 길이
      return out;
    },
    blob(files, mtime) { return new Blob([this.build(files, mtime)], { type: "application/zip" }); }
  };
