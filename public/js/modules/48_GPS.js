  /* ══════════════════════════════════════════════════════════════
     GPS — 휴대폰 등록 시 현지 위치 자동 기록 (WO 20261001-gps, 지휘자 발주 2026-10-02)
     마스터 결정: "자동".
     - 핀 생성/사진 등록 시 navigator.geolocation 으로 1회 조회(권한 거부되면 다시 묻지 않음).
     - EXIF GPS(사진 안에 있으면)가 기기 GPS보다 우선(판정기준 §2).
     - 실패해도 저장을 막지 않는다(조용한 실패 금지 — 값 없으면 "" 로 정직하게 표시).
     🔴 테스트 대상(순수): accWarning/mapUrl/displayText/parseExifGPS(버퍼 파싱, 네트워크·DOM 없음).
       capture()/attachToPin()은 navigator.geolocation 의존(비순수) — 테스트는 스텁 주입으로 검증.
  ══════════════════════════════════════════════════════════════ */
  const GPS = {
    ACC_WARN_M: 50,              // 이 값(m) 이상이면 "위치 부정확" 경고(이름 있는 상수 — 매직넘버 금지)
    LS_ENABLED: "wm_gps_auto",   // localStorage '1'|'0' — 미설정이면 기기별 기본값(모바일 ON/데스크톱 OFF)
    LS_DENIED: "wm_gps_denied",  // 권한 거부 후 재요청 금지 플래그

    /** 터치/좁은화면 = 모바일(19_PinGrid.isMobileSheet 와 같은 판정기준, 모듈 간 결합 피하려 자체 보유). */
    isMobile() {
      if (typeof window === "undefined" || !window.matchMedia) return false;
      try { return window.matchMedia("(max-width: 720px), (pointer: coarse)").matches; }
      catch (e) { return false; }
    },

    enabled() {
      try {
        const v = localStorage.getItem(this.LS_ENABLED);
        if (v === "1") return true;
        if (v === "0") return false;
      } catch (e) {}
      return this.isMobile(); // 미설정 기본값: 모바일 ON, 데스크톱 OFF(판정기준 §5)
    },

    setEnabled(v) { try { localStorage.setItem(this.LS_ENABLED, v ? "1" : "0"); } catch (e) {} },

    _denied() { try { return localStorage.getItem(this.LS_DENIED) === "1"; } catch (e) { return false; } },
    _markDenied() { try { localStorage.setItem(this.LS_DENIED, "1"); } catch (e) {} },

    /** navigator.geolocation 1회 조회 → {lat,lng,acc,alt,ts,src:'device'} 또는 null.
     *  절대 throw 하지 않는다 — 실패해도 핀 저장을 막지 않는다(마스터 요구). */
    capture() {
      return new Promise((resolve) => {
        if (!this.enabled() || this._denied()) return resolve(null);
        if (typeof navigator === "undefined" || !navigator.geolocation) return resolve(null);
        try {
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              const c = pos && pos.coords;
              if (!c) return resolve(null);
              resolve({
                lat: c.latitude, lng: c.longitude, acc: c.accuracy,
                alt: (c.altitude != null ? c.altitude : null),
                ts: Date.now(), src: "device"
              });
            },
            (err) => {
              if (err && err.code === 1) this._markDenied(); // PERMISSION_DENIED — 다시 묻지 않음(판정기준 §1)
              resolve(null);
            },
            { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
          );
        } catch (e) { resolve(null); }
      });
    },

    /** 핀에 GPS 를 비동기로 부여(fire-and-forget) — 호출자(핀 생성 경로)를 블로킹하지 않는다.
     *  이미 EXIF GPS(src:'exif')가 있으면 기기 GPS로 덮지 않는다(EXIF 우선, 판정기준 §2). */
    attachToPin(pin) {
      if (!pin || (pin.gps && pin.gps.src === "exif")) return;
      this.capture().then((g) => {
        if (!g || !pin) return;
        if (pin.gps && pin.gps.src === "exif") return; // 그 사이 EXIF 쪽이 채워졌으면 유지
        pin.gps = g;
        try { if (typeof App !== "undefined" && App._autoSave) App._autoSave(); } catch (e) {}
        try { if (typeof UI !== "undefined" && UI.renderPinList) UI.renderPinList(); } catch (e) {}
      }).catch(() => {});
    },

    /** 사진 ArrayBuffer에 EXIF GPS가 있으면 pin.gps 에 적용(기기 GPS보다 우선). 적용 여부를 bool로 반환. */
    applyExifIfAny(pin, arrayBuffer) {
      try {
        const g = this.parseExifGPS(arrayBuffer);
        if (g && pin) { pin.gps = g; return true; }
      } catch (e) {}
      return false;
    },

    /* ── 순수 포맷/계산 함수(테스트 대상) ── */

    /** 정확도 경고 문자열 또는 null(정확도 양호/정보 없음) — 값은 그대로 저장, 표시만 경고(판정기준 §3). */
    accWarning(gps) {
      if (!gps || gps.acc == null) return null;
      return gps.acc >= this.ACC_WARN_M ? ("위치 부정확(±" + Math.round(gps.acc) + "m)") : null;
    },

    /** 외부 지도 링크(OpenStreetMap — API 키 불필요, 탭 시에만 열림, 데이터 전송 없음. 판정기준 §4) */
    mapUrl(gps) {
      if (!gps || gps.lat == null || gps.lng == null) return null;
      return "https://www.openstreetmap.org/?mlat=" + gps.lat + "&mlon=" + gps.lng + "#map=17/" + gps.lat + "/" + gps.lng;
    },

    /** 핀 패널 공용 표시 문자열 "📍 35.1023, 129.0401 (±12m) · 14:32" — 값 없으면 "" (지어내지 않음). */
    displayText(gps) {
      if (!gps || gps.lat == null || gps.lng == null) return "";
      const lat = gps.lat.toFixed(4), lng = gps.lng.toFixed(4);
      const acc = (gps.acc != null) ? (" (±" + Math.round(gps.acc) + "m)") : "";
      let time = "";
      if (gps.ts) {
        const d = new Date(gps.ts);
        time = " · " + String(d.getUTCHours()).padStart(2, "0") + ":" + String(d.getUTCMinutes()).padStart(2, "0");
      }
      return "📍 " + lat + ", " + lng + acc + time;
    },

    /* ── EXIF GPS 파서(JPEG, DataView) — 35_PhotoBatch._parseExifDate 와 같은 세그먼트 스캔 방식을
       이 모듈 안에서 자체 재현한다(기존 모듈 관례: 각 모듈 자기완결, 모듈 간 결합 0). ── */
    _asciiAt(b, off, len) {
      let s = "";
      for (let i = 0; i < len; i++) s += String.fromCharCode(b.getUint8(off + i));
      return s;
    },

    /** JPEG APP1(EXIF) GPS IFD(0x8825)에서 위도/경도/고도를 읽는다. 없으면 null(mock 아님 — 조용한 실패 금지, 호출자가 "위치 없음" 표시). */
    parseExifGPS(buf) {
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
            const r = this._parseExifGPSIfd(b, segStart + 6, Math.min(segStart + segLen, len));
            if (r) return r;
          }
          if (marker === 0xDA) break;
          i = segStart + segLen - 2;
          if (segLen <= 0) break;
        }
        return null;
      } catch (e) { return null; }
    },

    _parseExifGPSIfd(b, tiffStart, end) {
      if (tiffStart + 8 > end) return null;
      const le = this._asciiAt(b, tiffStart, 2) === "II";
      const u16 = (o) => b.getUint16(o, le);
      const u32 = (o) => b.getUint32(o, le);
      if (u16(tiffStart + 2) !== 42) return null;
      let gpsIfdOff = null;
      const n0 = u16(tiffStart + 8);
      for (let k = 0; k < n0; k++) {
        const e = tiffStart + 8 + 2 + k * 12;
        if (e + 12 > end) break;
        if (u16(e) === 0x8825) { gpsIfdOff = u32(e + 8); break; } // GPS IFD 포인터
      }
      if (gpsIfdOff == null) return null;
      const at = tiffStart + gpsIfdOff;
      if (at + 2 > end) return null;
      const n = u16(at);
      const rational = (off) => { const num = u32(off), den = u32(off + 4); return den ? (num / den) : 0; };
      const dms = (valOff) => rational(valOff) + rational(valOff + 8) / 60 + rational(valOff + 16) / 3600;
      let latRef = null, lngRef = null, lat = null, lng = null, alt = null, altRef = 0;
      for (let k = 0; k < n; k++) {
        const e = at + 2 + k * 12;
        if (e + 12 > end) break;
        const tag = u16(e), type = u16(e + 2), cnt = u32(e + 4);
        const valOff = (type === 5 && cnt * 8 > 4) ? tiffStart + u32(e + 8) : e + 8;
        if (tag === 0x0001 && type === 2) latRef = this._asciiAt(b, valOff, 1);
        if (tag === 0x0003 && type === 2) lngRef = this._asciiAt(b, valOff, 1);
        if (tag === 0x0002 && type === 5 && valOff + 24 <= end) lat = dms(valOff);
        if (tag === 0x0004 && type === 5 && valOff + 24 <= end) lng = dms(valOff);
        if (tag === 0x0005 && type === 1) altRef = b.getUint8(e + 8);
        if (tag === 0x0006 && type === 5 && valOff + 8 <= end) alt = rational(valOff);
      }
      if (lat == null || lng == null) return null;
      if (latRef === "S") lat = -lat;
      if (lngRef === "W") lng = -lng;
      return { lat, lng, acc: null, alt: (alt != null ? (altRef === 1 ? -alt : alt) : null), ts: Date.now(), src: "exif" };
    },

    /* ══════════════════════════════════════════════════════════════
       Calib — 도면 GPS 기준점 맞추기(WO 20261019-gap3 판정기준 §1)
       "열린 갑판, 계류 중"에서만 정확 — 선체 내부·갑판 아래·항해 중은 GPS 가 성립하지 않는다(정직한 안내, UI 쪽).
       2점 → 상사변환(회전·축척·평행이동, 4DOF) / 3점 이상 → 최소제곱 아핀(6DOF).
       위경도는 기준점 중 첫 점을 원점으로 한 로컬 ENU(m, 등장방형 근사 — 소규모 거리라 오차 무시 가능)로 바꿔 계산한다.
       🔴 순수 함수만(DOM·네트워크 없음) — 서버 저장은 호출부(UI)가 fit() 결과를 JSON 으로 올린다.
    ══════════════════════════════════════════════════════════════ */
    Calib: {
      M_PER_DEG_LAT: 110574,         // 위도 1도 ≈ 110.574km(WGS84 근사, 이름 있는 상수 — 매직넘버 금지)
      M_PER_DEG_LNG_AT_EQUATOR: 111320,

      /** 위경도 → 기준점(ref) 원점의 로컬 ENU(m). 등장방형 근사(소규모 거리 전용, 선박 갑판 스케일엔 충분). */
      toENU(ref, lat, lng) {
        const E = (lng - ref.lng) * this.M_PER_DEG_LNG_AT_EQUATOR * Math.cos(ref.lat * Math.PI / 180);
        const N = (lat - ref.lat) * this.M_PER_DEG_LAT;
        return { E, N };
      },
      /** ENU(m) → 위경도(toENU 의 역변환, 같은 근사). */
      fromENU(ref, E, N) {
        const lat = ref.lat + N / this.M_PER_DEG_LAT;
        const lng = ref.lng + E / (this.M_PER_DEG_LNG_AT_EQUATOR * Math.cos(ref.lat * Math.PI / 180));
        return { lat, lng };
      },

      /** 2점 상사변환(Helmert) — E = a*x - b*y + e, N = b*x + a*y + f. 4 미지수(a,b,e,f), 4 방정식(점 2개 × 2축)
       *  → 직접 대입으로 해석적으로 푼다(최소제곱 불필요, 과소/과대결정 없음). */
      _fitSimilarity(pts, ref) {
        const [p0, p1] = pts;
        const e0 = this.toENU(ref, p0.lat, p0.lng), e1 = this.toENU(ref, p1.lat, p1.lng);
        const dxPx = p1.x - p0.x, dyPx = p1.y - p0.y;
        const dE = e1.E - e0.E, dN = e1.N - e0.N;
        const denom = dxPx * dxPx + dyPx * dyPx;
        if (!denom) return null; // 두 점이 도면상 같은 위치 — 변환 불가(지어내지 않음)
        // [dE,dN] = a*[dxPx,dyPx] + b*[-dyPx,dxPx] 를 a,b 에 대해 풀면:
        const a = (dE * dxPx + dN * dyPx) / denom;
        const b = (dN * dxPx - dE * dyPx) / denom;
        const e = e0.E - (a * p0.x - b * p0.y);
        const f = e0.N - (b * p0.x + a * p0.y);
        return { a, b: -b, c: b, d: a, e, f }; // E=a*x+b*y+e, N=c*x+d*y+f (일반 아핀 표기로 통일)
      },

      /** 3x3 선형계 직접 소거(가우스) — 최소제곱 정규방정식(AᵗA x = Aᵗy, 3미지수) 풀이 전용(의존성 0). */
      _solve3(A, y) {
        const M = [A[0].slice(), A[1].slice(), A[2].slice()];
        const Y = y.slice();
        for (let col = 0; col < 3; col++) {
          let piv = col;
          for (let r = col + 1; r < 3; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
          if (Math.abs(M[piv][col]) < 1e-12) return null;
          if (piv !== col) { [M[col], M[piv]] = [M[piv], M[col]]; [Y[col], Y[piv]] = [Y[piv], Y[col]]; }
          for (let r = 0; r < 3; r++) {
            if (r === col) continue;
            const f = M[r][col] / M[col][col];
            for (let k = col; k < 3; k++) M[r][k] -= f * M[col][k];
            Y[r] -= f * Y[col];
          }
        }
        return [Y[0] / M[0][0], Y[1] / M[1][1], Y[2] / M[2][2]];
      },

      /** 최소제곱 아핀(3점 이상) — E,N 각각 독립 선형회귀(x,y,1 → 값). */
      _fitAffineLS(pts, ref) {
        // 정규방정식 Aᵗ A [p,q,r]ᵗ = Aᵗ [E] (N 도 같은 구조)
        let Sxx = 0, Sxy = 0, Sx = 0, Syy = 0, Sy = 0, Sn = pts.length;
        let SxE = 0, SyE = 0, SE = 0, SxN = 0, SyN = 0, SN = 0;
        pts.forEach((p) => {
          const { E, N } = this.toENU(ref, p.lat, p.lng);
          Sxx += p.x * p.x; Sxy += p.x * p.y; Sx += p.x;
          Syy += p.y * p.y; Sy += p.y;
          SxE += p.x * E; SyE += p.y * E; SE += E;
          SxN += p.x * N; SyN += p.y * N; SN += N;
        });
        const A = [[Sxx, Sxy, Sx], [Sxy, Syy, Sy], [Sx, Sy, Sn]];
        const solE = this._solve3(A, [SxE, SyE, SE]);
        const solN = this._solve3(A, [SxN, SyN, SN]);
        if (!solE || !solN) return null; // 특이행렬(모든 점이 한 직선 위 등) — 지어내지 않고 null
        return { a: solE[0], b: solE[1], e: solE[2], c: solN[0], d: solN[1], f: solN[2] };
      },

      /** 적합 잔차(m) — 각 기준점에서 실측 ENU와 변환 예측 ENU의 거리. 정확도 경고(§임계 5m)의 근거값. */
      _residuals(pts, ref, matrix) {
        return pts.map((p) => {
          const { E, N } = this.toENU(ref, p.lat, p.lng);
          const pE = matrix.a * p.x + matrix.b * p.y + matrix.e;
          const pN = matrix.c * p.x + matrix.d * p.y + matrix.f;
          return Math.sqrt((E - pE) * (E - pE) + (N - pN) * (N - pN));
        });
      },

      RESIDUAL_WARN_M: 5, // 정확도 경고 임계(m) — 지시 §1 "예: 5m"

      /** 기준점 배열({x,y,lat,lng}, x/y=도면 픽셀%) → 변환 결과. 2점=상사, 3점+=최소제곱 아핀.
       *  실패(점<2, 특이행렬)면 null(지어내지 않음 — 호출부가 "계산 불가"로 정직하게 표시). */
      fit(points) {
        const pts = (points || []).filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.lat) && Number.isFinite(p.lng));
        if (pts.length < 2) return null;
        const ref = { lat: pts[0].lat, lng: pts[0].lng };
        const matrix = pts.length === 2 ? this._fitSimilarity(pts, ref) : this._fitAffineLS(pts, ref);
        if (!matrix) return null;
        const residuals = this._residuals(pts, ref, matrix);
        const maxResidualM = residuals.length ? Math.max(...residuals) : 0;
        return {
          matrix, ref, pointCount: pts.length, residuals, maxResidualM,
          warn: maxResidualM >= this.RESIDUAL_WARN_M ? ("정확도 경고 — 잔차 ±" + maxResidualM.toFixed(1) + "m") : null
        };
      },

      /** 도면 픽셀%(x,y) → GPS(위경도). 2x2 선형계를 직접 역산(행렬식 0 이면 null). */
      pixelToGps(fitResult, x, y) {
        if (!fitResult) return null;
        const m = fitResult.matrix;
        const E = m.a * x + m.b * y + m.e, N = m.c * x + m.d * y + m.f;
        const g = this.fromENU(fitResult.ref, E, N);
        return { lat: g.lat, lng: g.lng };
      },

      /** GPS(위경도) → 도면 픽셀%(x,y). 순방향 아핀 2x2 를 역행렬로 풀어 x,y 를 구한다.
       *  det≈0(특이행렬, 예: 2점이 같은 선상이고 변환이 축퇴) → null(지어내지 않음). */
      gpsToPixel(fitResult, lat, lng) {
        if (!fitResult) return null;
        const m = fitResult.matrix;
        const det = m.a * m.d - m.b * m.c;
        if (Math.abs(det) < 1e-9) return null;
        const { E, N } = this.toENU(fitResult.ref, lat, lng);
        const Ex = E - m.e, Nx = N - m.f;
        const x = (m.d * Ex - m.b * Nx) / det;
        const y = (-m.c * Ex + m.a * Nx) / det;
        return { x, y };
      }
    },

    /** 설정 패널 토글 런타임 주입 — index.html(타 팀 점유)을 건드리지 않고, 있는
     *  #chk-leader360 행(State.leader360 토글, 같은 스타일) 바로 뒤에 추가한다(판정기준 §5). */
    initToggle() {
      const base = document.getElementById("chk-leader360");
      const row = base && base.closest ? base.closest(".settings-leader-toggle-row") : null;
      if (!row || !row.parentNode || document.getElementById("chk-gps-auto")) return;
      const label = document.createElement("label");
      label.style.cssText = "display:flex;align-items:center;gap:8px;margin-top:10px;cursor:pointer;";
      const chk = document.createElement("input");
      chk.type = "checkbox"; chk.id = "chk-gps-auto";
      chk.checked = this.enabled();
      const span = document.createElement("span");
      span.textContent = "휴대폰 등록 시 위치 자동 기록";
      label.appendChild(chk); label.appendChild(span);
      row.parentNode.insertBefore(label, row.nextSibling);
      chk.addEventListener("change", () => this.setEnabled(chk.checked));
    }
  };
