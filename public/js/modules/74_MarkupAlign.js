  /* ══════════════════════════════════════════════════════════════
     MARKUP ALIGN — 마킹 도면 사진으로 핀 만들기 (WO 20261023-markupalign)
     마스터: "구역(영역)을 지정하면, 현장에서 출력 도면에 수동으로 마킹한 것을 사진으로 올렸을 때
             그 구역 PDF 원본과 대조해 위치를 정확하게 맞춰라."

     동선: 전체 기능 메뉴 → "마킹 도면 사진으로 핀 만들기"
       ① 사진 선택(갤러리·카메라) → ② 사진·원본 도면 각각에서 같은 기준점 4곳을 순서대로 탭
          → 4점 DLT 호모그래피로 사진을 원본 도면 좌표계로 역매핑 워프(양선형 보간)
          → 겹쳐보기 슬라이더로 정합 확인(점 다시 잡기 가능)
       ③ [마킹 찾기] — 그레이스케일 차분(+색 채도 보조) → 임계 → 형태학(닫힘→열림) → 연결 성분 →
          크기 필터 → 후보(중심) 목록
       ④ 검토 — 후보를 도면 위 번호 없는 원으로, 목록에 번호 입력칸(다음 번호 자동 제안·중복 경고)
          + 후보 추가(도면 탭)/삭제 → [확정] 시에만 기존 핀 생성 공용 경로로 일괄 생성(자동 생성 금지)

     🔴 좌표 SoT — pin.x/pin.y 는 기존 관례(20_App._placeCheckboardPin)와 동일하게 "그 페이지 폭/높이의
        0~100%". 이 모듈이 그리는 원본 캔버스는 어떤 해상도로 렌더해도 무방하다(퍼센트는 해상도 불변) —
        단, PDF 회전(State.pdfRotation)은 기존 PDF 모듈과 같은 공식으로 적용해야 좌표계가 일치한다.
     🔴 숫자 AI 자동인식(OCR)은 2단계(서버 엔드포인트 필요) — 이번 단계는 사람이 번호를 입력(자동 생성 0).
     🔴 순수 수학(호모그래피·워프·검출)은 DOM 없이도 호출 가능 — tests/p184 가 이 부분만 직접 검증한다.
     🔴 새 의존성 0 — opencv.js 등 대형 라이브러리 없이 4점 DLT + 분리형 박스블러 + 형태학 + 플러드필만 사용.
  ══════════════════════════════════════════════════════════════ */
  const MarkupAlign = {
    /* ── 검출 파라미터(기본값 — 테스트·호출부가 opts 로 덮어쓸 수 있다) ── */
    /* 🔴 [p184 실측 튜닝] DIFF_THRESH=38 은 사진↔원본 재래스터 과정의 서브픽셀 경계 유령(기존 도면
       선 자체가 ~35까지 "차이"로 번짐)과 구분이 안 됐다(실측: 보정 전 테두리선 blurred diff 최대
       ~38, 마킹 diff 는 수백). 60 으로 올리고 CLOSE_R 을 늘려 노이즈 산발을 더 확실히 닫되,
       5가지 조명·색펜 시나리오(밝기 0.8~1.15·노이즈 4~10·빨강/파랑/검정 펜) 전부 6/6 검출·
       평균오차 0.24%·오검출 0으로 실측 확인(아래 기본값). */
    DIFF_THRESH: 60,      // 그레이스케일 차분 임계(0~255)
    SAT_THRESH: 0.32,     // 색 채도 보조 임계(0~1) — 색펜 마킹 보조 검출
    SAT_DIFF_MIN: 12,     // 보조 채택 시 최소 차분(완전 무관 색 영역 배제)
    BLUR_R: 2,            // 차분 전 박스블러 반경(노이즈 완화)
    CLOSE_R: 3,           // 닫힘(팽창→침식) 반경 — 한 마킹의 조각(테두리+숫자)을 하나로
    OPEN_R: 1,            // 열림(침식→팽창) 반경 — 자잘한 노이즈 제거
    MIN_AREA_FRAC: 0.00008,  // 최소 성분 면적(캔버스 면적 비율)
    MAX_AREA_FRAC: 0.03,     // 최대 성분 면적(그림자 등 제외)

    /* ══ 선형대수 — 4점 DLT 호모그래피 ══════════════════════════════ */

    /** n×n 연립방정식(Gaussian elimination, 부분피벗). A=행배열의 배열, b=길이 n. 특이면 null. */
    _solveLinear(A, b, n) {
      const M = A.map((row, i) => row.slice().concat([b[i]]));
      for (let col = 0; col < n; col++) {
        let piv = col;
        for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
        if (Math.abs(M[piv][col]) < 1e-10) return null;
        if (piv !== col) { const t = M[piv]; M[piv] = M[col]; M[col] = t; }
        const pv = M[col][col];
        for (let c = col; c <= n; c++) M[col][c] /= pv;
        for (let r = 0; r < n; r++) {
          if (r === col) continue;
          const f = M[r][col];
          if (!f) continue;
          for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
        }
      }
      return M.map((row) => row[n]);
    },

    /** src4/dst4 = [{x,y}×4](같은 순서로 짝지은 점). H(src→dst, 3×3 행우선 9개, h33=1) 또는 null(특이/4점 미달). */
    computeHomography(src4, dst4) {
      if (!src4 || !dst4 || src4.length !== 4 || dst4.length !== 4) return null;
      const A = [], b = [];
      for (let i = 0; i < 4; i++) {
        const x = src4[i].x, y = src4[i].y, X = dst4[i].x, Y = dst4[i].y;
        A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]); b.push(X);
        A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]); b.push(Y);
      }
      const h = this._solveLinear(A, b, 8);
      if (!h) return null;
      return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
    },

    /** 3×3 역행렬(행우선 9개). 특이면 null. */
    invert3(m) {
      const a = m[0], b = m[1], c = m[2], d = m[3], e = m[4], f = m[5], g = m[6], h = m[7], i = m[8];
      const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
      if (Math.abs(det) < 1e-10) return null;
      const id = 1 / det;
      return [
        (e * i - f * h) * id, (c * h - b * i) * id, (b * f - c * e) * id,
        (f * g - d * i) * id, (a * i - c * g) * id, (c * d - a * f) * id,
        (d * h - e * g) * id, (b * g - a * h) * id, (a * e - b * d) * id
      ];
    },

    /** 호모그래피 적용 — (x,y) → (x',y') 동차좌표 정규화. w=0(무한점)이면 null. */
    applyH(m, x, y) {
      const w = m[6] * x + m[7] * y + m[8];
      if (!w) return null;
      return { x: (m[0] * x + m[1] * y + m[2]) / w, y: (m[3] * x + m[4] * y + m[5]) / w };
    },

    /* ══ 이미지 연산 — {data:Uint8ClampedArray, width, height}(ImageData 형태) 순수 함수 ══════════ */

    toGray(img) {
      const data = img.data, w = img.width, h = img.height;
      const g = new Uint8ClampedArray(w * h);
      for (let p = 0, o = 0; o < g.length; p += 4, o++) g[o] = (data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114) | 0;
      return g;
    },

    toSat(img) {
      const data = img.data, w = img.width, h = img.height;
      const s = new Float32Array(w * h);
      for (let p = 0, o = 0; o < s.length; p += 4, o++) {
        const r = data[p] / 255, gg = data[p + 1] / 255, b = data[p + 2] / 255;
        const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
        s[o] = mx === 0 ? 0 : (mx - mn) / mx;
      }
      return s;
    },

    /** 채도(블러 후) — 채널별로 먼저 블러해 사진의 픽셀 단위 색 노이즈(센서 노이즈)가 채도로
     *  오인되는 것을 막는다(원시 채도는 흰 배경의 랜덤 노이즈에도 쉽게 0.3 을 넘는다 — p184 실측). */
    toSatBlurred(img, w, h, r) {
      const data = img.data, n = w * h;
      const rc = new Float32Array(n), gc = new Float32Array(n), bc = new Float32Array(n);
      for (let p = 0, o = 0; o < n; p += 4, o++) { rc[o] = data[p]; gc[o] = data[p + 1]; bc[o] = data[p + 2]; }
      const rb = this.boxBlur(rc, w, h, r), gb = this.boxBlur(gc, w, h, r), bb = this.boxBlur(bc, w, h, r);
      const s = new Float32Array(n);
      for (let o = 0; o < n; o++) {
        const rr = rb[o] / 255, gg = gb[o] / 255, bbv = bb[o] / 255;
        const mx = Math.max(rr, gg, bbv), mn = Math.min(rr, gg, bbv);
        s[o] = mx === 0 ? 0 : (mx - mn) / mx;
      }
      return s;
    },

    _boxBlur1D(src, w, h, r, horizontal) {
      const out = new Float32Array(w * h);
      const n = 2 * r + 1;
      if (horizontal) {
        for (let y = 0; y < h; y++) {
          const row = y * w;
          let acc = 0;
          for (let x = -r; x <= r; x++) acc += src[row + Math.min(w - 1, Math.max(0, x))];
          for (let x = 0; x < w; x++) {
            out[row + x] = acc / n;
            acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
          }
        }
      } else {
        for (let x = 0; x < w; x++) {
          let acc = 0;
          for (let y = -r; y <= r; y++) acc += src[Math.min(h - 1, Math.max(0, y)) * w + x];
          for (let y = 0; y < h; y++) {
            out[y * w + x] = acc / n;
            acc += src[Math.min(h - 1, y + r + 1) * w + x] - src[Math.max(0, y - r) * w + x];
          }
        }
      }
      return out;
    },
    boxBlur(src, w, h, r) {
      if (!r || r <= 0) return Float32Array.from(src);
      return this._boxBlur1D(this._boxBlur1D(src, w, h, r, true), w, h, r, false);
    },

    /** src 이미지를 Hsrc2dst(src→dst) 로 destW×destH 캔버스에 역매핑(dst→src via Hinv) + 양선형 보간.
     *  범위 밖 픽셀은 bg 색으로 채우고 outside[] 에 1 을 남긴다(차분 계산에서 제외용).
     *  @returns {data,width,height,outside:Uint8Array} 또는 null(호모그래피 특이). */
    warp(srcImg, Hsrc2dst, destW, destH, bg) {
      const Hinv = this.invert3(Hsrc2dst);
      if (!Hinv) return null;
      const sd = srcImg.data, sw = srcImg.width, sh = srcImg.height;
      const dd = new Uint8ClampedArray(destW * destH * 4);
      const outside = new Uint8Array(destW * destH);
      const bgc = bg || [255, 255, 255];
      for (let Y = 0; Y < destH; Y++) {
        for (let X = 0; X < destW; X++) {
          const o = Y * destW + X;
          const p = this.applyH(Hinv, X + 0.5, Y + 0.5);
          let r = bgc[0], g = bgc[1], b = bgc[2], out = 1;
          if (p && p.x >= 0 && p.x <= sw - 1 && p.y >= 0 && p.y <= sh - 1) {
            out = 0;
            const x0 = Math.floor(p.x), y0 = Math.floor(p.y);
            const x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sh - 1, y0 + 1);
            const fx = p.x - x0, fy = p.y - y0;
            const i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4, i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
            const lerp = (c) => {
              const top = sd[i00 + c] + (sd[i10 + c] - sd[i00 + c]) * fx;
              const bot = sd[i01 + c] + (sd[i11 + c] - sd[i01 + c]) * fx;
              return top + (bot - top) * fy;
            };
            r = lerp(0); g = lerp(1); b = lerp(2);
          }
          dd[o * 4] = r; dd[o * 4 + 1] = g; dd[o * 4 + 2] = b; dd[o * 4 + 3] = 255;
          outside[o] = out;
        }
      }
      return { data: dd, width: destW, height: destH, outside };
    },

    /** 사진↔원본 밝기/노출 보정(최소제곱 선형회귀, g2≈a·g1+b) — 실제 현장 사진은 PDF 렌더와
     *  전역 밝기·대비가 달라(조명·카메라 노출) 이 보정 없이는 흰 배경 전체가 "차이"로 잡혀
     *  마킹과 구분이 안 된다(p184 실측: 보정 전 흰 배경 평균 diff ≈26, 보정 후 ≈0). */
    /** 🔴 [p184 실측] 최소제곱 선형회귀는 선 경계의 서브픽셀 정합오차(소수 비중이지만 극단값)에
     *  끌려가 배경조차 못 맞춘다(실측 a=0.68·b=98 — 틀린 보정). 배경(최다수 화소)의 전형적 차이값
     *  = 히스토그램 최빈값(mode)이 훨씬 안정적이다(소수 극단값에 둔감). 이득(a)은 1로 고정 —
     *  현장 사진의 노출차는 블러 후 영역에서 거의 가산적이라 굳이 곱셈 보정이 필요 없다. */
    _exposureFit(g1, g2, outside) {
      const hist = new Map();
      for (let o = 0; o < g1.length; o++) {
        if (outside && outside[o]) continue;
        const d = Math.round(g2[o] - g1[o]);
        hist.set(d, (hist.get(d) || 0) + 1);
      }
      let bestD = 0, bestN = -1;
      hist.forEach((n, d) => { if (n > bestN) { bestN = n; bestD = d; } });
      return { a: 1, b: -bestD };
    },

    /** 차분 마스크(0/1) — 노출 보정 후 그레이스케일 차분(블러 후) 임계 + 색 채도 보조. origImg/warped 는 같은 w×h. */
    buildMask(origImg, warped, opts) {
      opts = opts || {};
      const w = origImg.width, h = origImg.height;
      const blurR = opts.blurR != null ? opts.blurR : this.BLUR_R;
      const diffT = opts.diffThresh != null ? opts.diffThresh : this.DIFF_THRESH;
      const satT = opts.satThresh != null ? opts.satThresh : this.SAT_THRESH;
      const satDiffMin = opts.satDiffMin != null ? opts.satDiffMin : this.SAT_DIFF_MIN;
      const g1 = this.boxBlur(this.toGray(origImg), w, h, blurR);
      const g2raw = this.boxBlur(this.toGray(warped), w, h, blurR);
      const fit = opts.noExposureFit ? { a: 1, b: 0 } : this._exposureFit(g1, g2raw, warped.outside);
      const g2 = new Float32Array(g2raw.length);
      for (let o = 0; o < g2.length; o++) g2[o] = fit.a * g2raw[o] + fit.b;
      const sat2 = this.toSatBlurred(warped, w, h, blurR);
      const mask = new Uint8Array(w * h);
      for (let o = 0; o < mask.length; o++) {
        if (warped.outside && warped.outside[o]) continue;
        const diff = Math.abs(g1[o] - g2[o]);
        if (diff >= diffT) mask[o] = 1;
        else if (sat2[o] >= satT && diff >= satDiffMin) mask[o] = 1;
      }
      return mask;
    },

    _morphStep(mask, w, h, grow) {
      const out = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const o = y * w + x;
          if (grow) {
            let v = mask[o];
            for (let dy = -1; dy <= 1 && !v; dy++) for (let dx = -1; dx <= 1 && !v; dx++) {
              const yy = y + dy, xx = x + dx;
              if (yy >= 0 && yy < h && xx >= 0 && xx < w && mask[yy * w + xx]) v = 1;
            }
            out[o] = v;
          } else {
            let v = mask[o];
            for (let dy = -1; dy <= 1 && v; dy++) for (let dx = -1; dx <= 1 && v; dx++) {
              const yy = y + dy, xx = x + dx;
              if (yy < 0 || yy >= h || xx < 0 || xx >= w || !mask[yy * w + xx]) v = 0;
            }
            out[o] = v;
          }
        }
      }
      return out;
    },
    dilate(mask, w, h, r) { let m = mask; for (let i = 0; i < r; i++) m = this._morphStep(m, w, h, true); return m; },
    erode(mask, w, h, r) { let m = mask; for (let i = 0; i < r; i++) m = this._morphStep(m, w, h, false); return m; },
    /* 🔴 [p184 뮤테이션으로 발견] 이름을 close/open 으로 두면 아래 §UI 의 모달 close()/open() 과
       한 객체 리터럴 안에서 충돌해 나중 선언이 덮어쓴다(증상: detectMarks 가 늘 빈 결과) —
       closeMask/openMask 로 분리해 공유 네임스페이스 충돌을 근본적으로 없앤다. */
    closeMask(mask, w, h, r) { return r > 0 ? this.erode(this.dilate(mask, w, h, r), w, h, r) : mask; },
    openMask(mask, w, h, r) { return r > 0 ? this.dilate(this.erode(mask, w, h, r), w, h, r) : mask; },

    /** 8-연결 연결성분(반복 스택 플러드필 — 재귀 금지, 큰 이미지도 안전). */
    connectedComponents(mask, w, h) {
      const seen = new Uint8Array(w * h);
      const comps = [];
      const stack = [];
      for (let s = 0; s < mask.length; s++) {
        if (!mask[s] || seen[s]) continue;
        let minX = w, minY = h, maxX = -1, maxY = -1, area = 0, sx = 0, sy = 0;
        stack.length = 0; stack.push(s); seen[s] = 1;
        while (stack.length) {
          const o = stack.pop();
          const y = (o / w) | 0, x = o - y * w;
          area++; sx += x; sy += y;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const yy = y + dy, xx = x + dx;
            if (yy < 0 || yy >= h || xx < 0 || xx >= w) continue;
            const oo = yy * w + xx;
            if (mask[oo] && !seen[oo]) { seen[oo] = 1; stack.push(oo); }
          }
        }
        comps.push({ minX, minY, maxX, maxY, area, cx: sx / area, cy: sy / area, w: maxX - minX + 1, h: maxY - minY + 1 });
      }
      return comps;
    },

    /** 전체 검출 파이프라인 — origImg(마킹 없는 원본 렌더) vs warped(사진을 원본 좌표계로 워프한 결과).
     *  @returns [{x,y,w,h,area}](픽셀 좌표, 중심) */
    detectMarks(origImg, warped, opts) {
      opts = opts || {};
      const w = origImg.width, h = origImg.height;
      const mask = this.buildMask(origImg, warped, opts);
      const closed = this.closeMask(mask, w, h, opts.closeR != null ? opts.closeR : this.CLOSE_R);
      const opened = this.openMask(closed, w, h, opts.openR != null ? opts.openR : this.OPEN_R);
      const comps = this.connectedComponents(opened, w, h);
      const area = w * h;
      const minA = (opts.minAreaFrac != null ? opts.minAreaFrac : this.MIN_AREA_FRAC) * area;
      const maxA = (opts.maxAreaFrac != null ? opts.maxAreaFrac : this.MAX_AREA_FRAC) * area;
      return comps.filter((c) => c.area >= minA && c.area <= maxA)
        .map((c) => ({ x: c.cx, y: c.cy, w: c.w, h: c.h, area: c.area }));
    },

    /* ══ 번호 제안·중복 경고·핀 생성(DOM 없이도 호출 가능한 순수 함수) ══════════════════════ */

    /** 다음 번호 제안 — 정본 PinSeries.nextInBand(App 대역·시작값) 우선, 미로드 시 숫자 라벨 최댓값+1. */
    nextSuggested(pins, page) {
      try {
        if (typeof App !== "undefined" && App._numBand && App._checkboardStart && typeof PinSeries !== "undefined" && PinSeries.nextInBand) {
          const band = App._numBand();
          const start = App._checkboardStart(page, "content");
          const nx = PinSeries.nextInBand(pins, page, "content", band, start);
          if (nx && !nx.full) return String(nx.label != null ? nx.label : nx.no);
        }
      } catch (e) {}
      let max = 0;
      (pins || []).forEach((p) => { if (p && (p.page || 1) === page) { const n = parseInt(p.label, 10); if (Number.isFinite(n) && n > max) max = n; } });
      return String(max + 1);
    },

    /** 후보들에 순차 번호 제안(이미 쓰인 숫자는 건너뜀). pins = 실제 핀(그 페이지). */
    suggestLabels(pins, page, count) {
      const used = new Set();
      (pins || []).forEach((p) => { if (p && (p.page || 1) === page && p.label != null) used.add(String(p.label)); });
      const first = this.nextSuggested(pins, page);
      const out = [];
      let n = parseInt(first, 10);
      if (!Number.isFinite(n)) n = 1;
      for (let i = 0; i < count; i++) {
        while (used.has(String(n))) n++;
        out.push(String(n));
        used.add(String(n));
        n++;
      }
      return out;
    },

    /** 번호 충돌 — 같은 페이지 살아있는 핀 또는 다른 후보(selfIdx 제외)와 같은 라벨이면 true. */
    isDuplicateLabel(label, pins, page, candidates, selfIdx) {
      const lb = String(label == null ? "" : label).trim();
      if (!lb) return false;
      const hit = (pins || []).some((p) => p && !p._deleted && (p.page || 1) === page && String(p.label == null ? "" : p.label) === lb);
      if (hit) return true;
      return (candidates || []).some((c, i) => i !== selfIdx && c && c.include !== false && String(c.label == null ? "" : c.label).trim() === lb);
    },

    /** 픽셀 좌표 → 페이지 % (0~100, 기존 관례와 동일한 클램프). */
    toPct(px, py, canvasW, canvasH) {
      return {
        x: Math.max(0, Math.min(100, (px / canvasW) * 100)),
        y: Math.max(0, Math.min(100, (py / canvasH) * 100))
      };
    },

    /** 신규 핀 객체 — 기존 생성 지점(20_App._placeCheckboardPin)과 같은 필드 구성. id 는 배치 내 유일(ma<batch>-<n>). */
    buildPin({ x, y, page, label, author }, batchId, n) {
      const now = Date.now();
      const pin = { id: "ma" + batchId + "-" + n, createdAt: now, x, y, page: page || 1, label: String(label == null ? "" : label) };
      if (author) pin.author = author;
      return pin;
    },

    /** 확정 — include!==false 인 후보만 핀으로 생성해 State.pins 에 반영(기존 추가 경로와 동일 순서).
     *  candidates = [{x,y(px),label,include}] · canvasW/H = 중심 px → % 변환 기준(원본 렌더 캔버스 크기).
     *  🔴 자동 생성 금지 — 이 함수는 사용자가 [확정]을 눌렀을 때만 호출된다(호출부 책임). */
    confirmCreate(candidates, { page, canvasW, canvasH }) {
      const batchId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const author = (typeof Auth !== "undefined" && Auth.user) ? (Auth.user.email || Auth.user.name || null) : null;
      const created = [];
      let n = 0;
      (candidates || []).forEach((c) => {
        if (!c || c.include === false) return;
        const pct = this.toPct(c.x, c.y, canvasW, canvasH);
        const pin = this.buildPin({ x: pct.x, y: pct.y, page, label: c.label, author }, batchId, n++);
        State.pins.push(pin);
        created.push(pin);
      });
      if (!created.length) return { batchId, pins: [] };
      if (typeof Log !== "undefined" && Log.push) created.forEach((p) => Log.push("pin.add", p.id, { label: p.label, page: p.page, src: "markupAlign" }));
      if (typeof Zones !== "undefined" && Zones.refreshPinLinks) Zones.refreshPinLinks();
      if (typeof UI !== "undefined") { UI.renderPinList && UI.renderPinList(); UI.renderPinsOnMap && UI.renderPinsOnMap(); }
      if (typeof PinGrid !== "undefined" && PinGrid.render) { try { PinGrid.render(); } catch (e) {} }
      if (typeof App !== "undefined" && App._autoSave) App._autoSave();
      return { batchId, pins: created };
    },

    /* ══ DOM/UI — 모달(사진 선택 → 4점 정합 → 검출·검토 → 확정) ══════════════════════════ */

    _ctx: null,   // { step, photoImg, photoCanvas, photoOv, photoPts, origCanvas, origOv, origPts, H, warped, warpedCanvas, candidates, page }

    canOpen() {
      return typeof State !== "undefined" && State.mode === "designer" && typeof Auth !== "undefined" && !!Auth.isDesigner && !Auth.readonly
        && !!(State.fileType === "pdf" ? State.pdfDoc : (State.fileType === "image" && State.imageUrl));
    },

    _el(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; },
    _esc(s) { return (typeof UI !== "undefined" && UI.escapeHtml) ? UI.escapeHtml(String(s)) : String(s); },
    _toast(m) { try { if (typeof Prompt !== "undefined" && Prompt.toast) Prompt.toast(m, 4200); } catch (e) {} },

    /** 클라이언트(터치/마우스) 좌표 → 캔버스 내부 픽셀 좌표(CSS 스케일 보정). */
    _ptOnCanvas(canvas, clientX, clientY) {
      const r = canvas.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return {
        x: Math.max(0, Math.min(canvas.width, ((clientX - r.left) / r.width) * canvas.width)),
        y: Math.max(0, Math.min(canvas.height, ((clientY - r.top) / r.height) * canvas.height))
      };
    },

    async _loadImageFromFile(file) {
      const url = URL.createObjectURL(file);
      try {
        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
        return img;
      } finally { URL.revokeObjectURL(url); }
    },

    /** 사진 → 캔버스(최대 변 maxDim 로 축소, 내부 해상도 유지 — 마킹 식별에 충분한 화질). */
    _drawToCanvas(img, maxDim) {
      const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
      const scale = Math.min(1, maxDim / Math.max(iw, ih));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(iw * scale));
      c.height = Math.max(1, Math.round(ih * scale));
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      return c;
    },

    /** 원본 도면 현재 페이지를 새 오프스크린 캔버스에 렌더(편집 캔버스와 독립 — 부작용 0).
     *  퍼센트 좌표계가 기존 핀과 일치하도록 PDF 회전(State.pdfRotation)을 동일 공식으로 적용. */
    async _renderOriginCanvas(maxDim) {
      maxDim = maxDim || 1400;
      if (State.fileType === "image" && State.imageUrl) {
        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = State.imageUrl; });
        return this._drawToCanvas(img, maxDim);
      }
      if (State.fileType === "pdf" && State.pdfDoc) {
        const page = await State.pdfDoc.getPage(State.pdfPage || 1);
        const rot = ((page.rotate || 0) + (State.pdfRotation || 0)) % 360;
        const base = page.getViewport({ scale: 1, rotation: rot });
        const scale = Math.min(2, maxDim / Math.max(base.width, base.height));
        const vp = page.getViewport({ scale, rotation: rot });
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(vp.width));
        c.height = Math.max(1, Math.round(vp.height));
        await page.render({ canvasContext: c.getContext("2d", { alpha: false }), viewport: vp }).promise;
        return c;
      }
      return null;
    },

    _ensureModal() {
      let m = document.getElementById("ma-modal");
      if (m) return m;
      m = this._el("div", "admin-gate hidden");
      m.id = "ma-modal"; m.setAttribute("role", "dialog"); m.setAttribute("aria-modal", "true");
      m.innerHTML =
        '<div class="admin-gate-backdrop"></div>' +
        '<div class="admin-gate-card ma-card">' +
        '<h2 class="admin-gate-title">마킹 도면 사진으로 핀 만들기</h2>' +
        '<div id="ma-step1" class="ma-step">' +
        '<p class="admin-gate-sub">현장에서 출력 도면에 번호·동그라미로 마킹한 사진을 선택하세요.</p>' +
        '<input id="ma-file" type="file" accept="image/*" capture="environment" class="hidden">' +
        '<button id="ma-pick" type="button" class="admin-gate-btn primary full">사진 선택</button>' +
        '</div>' +
        '<div id="ma-step2" class="ma-step hidden">' +
        '<p id="ma-step2-hint" class="admin-gate-sub"></p>' +
        '<div class="ma-canvases">' +
        '<div class="ma-cv-wrap"><p class="ma-lbl">사진</p><div class="ma-cv-stage"><canvas id="ma-photo"></canvas><canvas id="ma-photo-ov"></canvas></div></div>' +
        '<div class="ma-cv-wrap"><p class="ma-lbl">원본 도면</p><div class="ma-cv-stage"><canvas id="ma-orig"></canvas><canvas id="ma-orig-ov"></canvas></div></div>' +
        '</div>' +
        '<div class="admin-gate-actions"><button id="ma-reset-pts" type="button" class="admin-gate-btn ghost">점 다시 잡기</button>' +
        '<button id="ma-align" type="button" class="admin-gate-btn primary" disabled>정합 확인</button></div>' +
        '</div>' +
        '<div id="ma-step3" class="ma-step hidden">' +
        '<p class="admin-gate-sub">슬라이더로 겹쳐보기(정합 확인) → [마킹 찾기] → 번호 입력 후 [확정]</p>' +
        '<input id="ma-opacity" type="range" min="0" max="100" value="50" class="ma-slider">' +
        '<div class="ma-cv-stage ma-cv-stage-wide"><canvas id="ma-cmp-base"></canvas><canvas id="ma-cmp-over"></canvas><canvas id="ma-cmp-cand"></canvas></div>' +
        '<div class="admin-gate-actions">' +
        '<button id="ma-redo-pts" type="button" class="admin-gate-btn ghost">점 다시 잡기</button>' +
        '<button id="ma-detect" type="button" class="admin-gate-btn primary">마킹 찾기</button></div>' +
        '<label class="rm-chk"><input type="checkbox" id="ma-addmode"> 후보 추가(도면 탭으로 직접 찍기)</label>' +
        '<p id="ma-cand-summary" class="rm-preview"></p>' +
        '<div id="ma-cand-list" class="ma-cand-list"></div>' +
        '<div id="ma-err" class="admin-gate-error hidden"></div>' +
        '<div class="admin-gate-actions"><button id="ma-cancel" type="button" class="admin-gate-btn ghost">취소</button>' +
        '<button id="ma-confirm" type="button" class="admin-gate-btn primary" disabled>확정</button></div>' +
        '</div>' +
        '</div>';
      document.body.appendChild(m);
      m.querySelector(".admin-gate-backdrop").addEventListener("click", () => this.close());
      m.querySelector("#ma-pick").addEventListener("click", () => m.querySelector("#ma-file").click());
      m.querySelector("#ma-file").addEventListener("change", (e) => { const f = e.target.files && e.target.files[0]; if (f) this._onFile(f); e.target.value = ""; });
      m.querySelector("#ma-reset-pts").addEventListener("click", () => this._resetPoints());
      m.querySelector("#ma-redo-pts").addEventListener("click", () => this._backToPoints());
      m.querySelector("#ma-align").addEventListener("click", () => this._align());
      m.querySelector("#ma-opacity").addEventListener("input", (e) => this._renderOverlay(Number(e.target.value) / 100));
      m.querySelector("#ma-detect").addEventListener("click", () => this._detect());
      m.querySelector("#ma-cancel").addEventListener("click", () => this.close());
      m.querySelector("#ma-confirm").addEventListener("click", () => this._confirm());
      const cmpCand = m.querySelector("#ma-cmp-cand");
      cmpCand.addEventListener("pointerdown", (e) => this._onCandTap(e));
      this._wirePointPicker(m.querySelector("#ma-photo-ov"), "photoPts", "ma-photo");
      this._wirePointPicker(m.querySelector("#ma-orig-ov"), "origPts", "ma-orig");
      this._panel = m;
      return m;
    },

    _wirePointPicker(ov, key, baseId) {
      ov.addEventListener("pointerdown", (e) => {
        const ctx = this._ctx;
        if (!ctx || ctx.step !== 2) return;
        const arr = ctx[key];
        if (arr.length >= 4) return;
        const base = document.getElementById(baseId);
        const p = this._ptOnCanvas(base, e.clientX, e.clientY);
        if (!p) return;
        arr.push(p);
        this._drawPoints(ov, arr);
        this._updateAlignBtn();
        e.preventDefault();
      });
    },

    _drawPoints(ov, pts) {
      const ctx = ov.getContext("2d");
      ctx.clearRect(0, 0, ov.width, ov.height);
      pts.forEach((p, i) => {
        ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(5, ov.width * 0.012), 0, Math.PI * 2);
        ctx.fillStyle = "rgba(239,68,68,.85)"; ctx.fill();
        ctx.fillStyle = "#fff"; ctx.font = "bold " + Math.max(11, Math.round(ov.width * 0.02)) + "px sans-serif";
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(String(i + 1), p.x, p.y);
      });
    },

    _updateAlignBtn() {
      const ctx = this._ctx, m = this._panel;
      if (!ctx || !m) return;
      m.querySelector("#ma-align").disabled = !(ctx.photoPts.length === 4 && ctx.origPts.length === 4);
      m.querySelector("#ma-step2-hint").textContent = ctx.photoPts.length < 4
        ? "사진에서 기준점(도면 모서리 등) " + (4 - ctx.photoPts.length) + "곳을 순서대로 탭하세요"
        : (ctx.origPts.length < 4 ? "원본 도면에서 같은 순서로 같은 기준점 " + (4 - ctx.origPts.length) + "곳을 탭하세요" : "4점씩 모두 지정했습니다 — [정합 확인]");
    },

    _resetPoints() {
      const ctx = this._ctx; if (!ctx) return;
      ctx.photoPts = []; ctx.origPts = [];
      this._drawPoints(document.getElementById("ma-photo-ov"), []);
      this._drawPoints(document.getElementById("ma-orig-ov"), []);
      this._updateAlignBtn();
    },

    _backToPoints() {
      const ctx = this._ctx; if (!ctx) return;
      ctx.step = 2;
      this._panel.querySelector("#ma-step2").classList.remove("hidden");
      this._panel.querySelector("#ma-step3").classList.add("hidden");
    },

    async _onFile(file) {
      try {
        const img = await this._loadImageFromFile(file);
        const ctx = this._ctx;
        ctx.photoCanvas = this._drawToCanvas(img, 1600);
        ctx.origCanvas = await this._renderOriginCanvas(1400);
        if (!ctx.origCanvas) { this._toast("원본 도면을 불러오지 못했습니다"); return; }
        ctx.page = State.pdfPage || 1;
        ctx.photoPts = []; ctx.origPts = [];
        const pc = document.getElementById("ma-photo"), poc = document.getElementById("ma-photo-ov");
        const oc = document.getElementById("ma-orig"), ooc = document.getElementById("ma-orig-ov");
        [pc, poc].forEach((c) => { c.width = ctx.photoCanvas.width; c.height = ctx.photoCanvas.height; });
        [oc, ooc].forEach((c) => { c.width = ctx.origCanvas.width; c.height = ctx.origCanvas.height; });
        pc.getContext("2d").drawImage(ctx.photoCanvas, 0, 0);
        oc.getContext("2d").drawImage(ctx.origCanvas, 0, 0);
        ctx.step = 2;
        this._panel.querySelector("#ma-step1").classList.add("hidden");
        this._panel.querySelector("#ma-step2").classList.remove("hidden");
        this._panel.querySelector("#ma-step3").classList.add("hidden");
        this._updateAlignBtn();
      } catch (e) { this._toast("사진을 열지 못했습니다: " + ((e && e.message) || e)); }
    },

    _align() {
      const ctx = this._ctx;
      if (!ctx || ctx.photoPts.length !== 4 || ctx.origPts.length !== 4) return;
      const H = this.computeHomography(ctx.photoPts, ctx.origPts);
      const err = this._panel.querySelector("#ma-err");
      if (!H) { err.textContent = "4점이 일직선에 가깝습니다 — 네 모서리처럼 서로 멀리 떨어진 점을 고르세요"; err.classList.remove("hidden"); return; }
      err.classList.add("hidden");
      const w = ctx.origCanvas.width, h = ctx.origCanvas.height;
      const photoImgData = ctx.photoCanvas.getContext("2d").getImageData(0, 0, ctx.photoCanvas.width, ctx.photoCanvas.height);
      const warped = this.warp(photoImgData, H, w, h);
      if (!warped) { err.textContent = "정합 계산에 실패했습니다 — 점을 다시 지정하세요"; err.classList.remove("hidden"); return; }
      ctx.H = H; ctx.warped = warped; ctx.candidates = [];
      const warpedCanvas = document.createElement("canvas");
      warpedCanvas.width = w; warpedCanvas.height = h;
      warpedCanvas.getContext("2d").putImageData(new ImageData(warped.data, w, h), 0, 0);
      ctx.warpedCanvas = warpedCanvas;
      ["ma-cmp-base", "ma-cmp-over", "ma-cmp-cand"].forEach((id) => { const c = document.getElementById(id); c.width = w; c.height = h; });
      document.getElementById("ma-cmp-base").getContext("2d").drawImage(ctx.origCanvas, 0, 0);
      ctx.step = 3;
      this._panel.querySelector("#ma-step2").classList.add("hidden");
      this._panel.querySelector("#ma-step3").classList.remove("hidden");
      this._renderOverlay(Number(this._panel.querySelector("#ma-opacity").value) / 100);
      this._renderCandList();
    },

    _renderOverlay(alpha) {
      const ctx = this._ctx; if (!ctx || !ctx.warpedCanvas) return;
      const c = document.getElementById("ma-cmp-over");
      const g = c.getContext("2d");
      g.clearRect(0, 0, c.width, c.height);
      g.globalAlpha = Math.max(0, Math.min(1, alpha));
      g.drawImage(ctx.warpedCanvas, 0, 0);
      g.globalAlpha = 1;
    },

    _detect() {
      const ctx = this._ctx; if (!ctx || !ctx.warped) return;
      const orig = ctx.origCanvas.getContext("2d").getImageData(0, 0, ctx.origCanvas.width, ctx.origCanvas.height);
      const found = this.detectMarks(orig, ctx.warped);
      const existingLabels = this.suggestLabels((State.pins || []), ctx.page, found.length);
      ctx.candidates = found.map((f, i) => ({ x: f.x, y: f.y, w: f.w, h: f.h, label: existingLabels[i], include: true }));
      this._renderCandidateDots();
      this._renderCandList();
    },

    _renderCandidateDots() {
      const ctx = this._ctx; if (!ctx) return;
      const c = document.getElementById("ma-cmp-cand");
      const g = c.getContext("2d");
      g.clearRect(0, 0, c.width, c.height);
      (ctx.candidates || []).forEach((cd, i) => {
        if (cd.include === false) return;
        g.beginPath(); g.arc(cd.x, cd.y, Math.max(10, c.width * 0.016), 0, Math.PI * 2);
        g.strokeStyle = "#22c55e"; g.lineWidth = 3; g.stroke();
        g.fillStyle = "rgba(34,197,94,.18)"; g.fill();
      });
    },

    _onCandTap(e) {
      const ctx = this._ctx;
      const addMode = this._panel.querySelector("#ma-addmode");
      if (!ctx || ctx.step !== 3 || !addMode || !addMode.checked) return;
      const c = document.getElementById("ma-cmp-cand");
      const p = this._ptOnCanvas(c, e.clientX, e.clientY);
      if (!p) return;
      const label = this.suggestLabels((State.pins || []).concat(ctx.candidates.filter((x) => x.include !== false).map((x) => ({ page: ctx.page, label: x.label }))), ctx.page, 1)[0];
      ctx.candidates.push({ x: p.x, y: p.y, w: 0, h: 0, label, include: true });
      this._renderCandidateDots();
      this._renderCandList();
    },

    _renderCandList() {
      const ctx = this._ctx, host = document.getElementById("ma-cand-list");
      if (!ctx || !host) return;
      host.innerHTML = "";
      const list = ctx.candidates || [];
      list.forEach((cd, i) => {
        const row = this._el("div", "ma-cand-row" + (cd.include === false ? " off" : ""));
        const inp = document.createElement("input");
        inp.type = "text"; inp.className = "admin-gate-input ma-cand-input"; inp.value = cd.label || "";
        inp.addEventListener("input", () => { cd.label = inp.value; this._renderCandList(); });
        const warn = this._el("span", "ma-cand-warn");
        if (this.isDuplicateLabel(cd.label, State.pins, ctx.page, list, i)) warn.textContent = "번호 중복";
        const del = this._el("button", "ma-cand-del"); del.type = "button"; del.textContent = "✕";
        del.addEventListener("click", () => { list.splice(i, 1); this._renderCandidateDots(); this._renderCandList(); });
        row.appendChild(this._el("span", "ma-cand-ico"));
        row.appendChild(inp); row.appendChild(warn); row.appendChild(del);
        host.appendChild(row);
      });
      const n = list.length;
      this._panel.querySelector("#ma-cand-summary").textContent = n ? ("후보 " + n + "개") : "아직 찾은 후보가 없습니다 — [마킹 찾기]를 누르세요";
      this._panel.querySelector("#ma-confirm").disabled = !n;
    },

    _confirm() {
      const ctx = this._ctx; if (!ctx) return;
      const list = (ctx.candidates || []).map((c) => ({ x: c.x, y: c.y, label: (c.label == null || c.label === "") ? this.nextSuggested(State.pins, ctx.page) : c.label, include: true }));
      const res = this.confirmCreate(list, { page: ctx.page, canvasW: ctx.origCanvas.width, canvasH: ctx.origCanvas.height });
      this.close();
      this._toast(res.pins.length + "개 핀을 만들었습니다");
    },

    close() {
      const m = this._panel;
      if (m && m.classList) { m.classList.remove("on"); setTimeout(() => m.classList.add("hidden"), 180); }
      this._ctx = null;
    },

    open() {
      if (!this.canOpen()) { this._toast("도면이 열린 설계자 편집 화면에서만 사용할 수 있습니다"); return; }
      const m = this._ensureModal();
      this._ctx = { step: 1, photoPts: [], origPts: [], candidates: [], page: State.pdfPage || 1 };
      m.querySelector("#ma-step1").classList.remove("hidden");
      m.querySelector("#ma-step2").classList.add("hidden");
      m.querySelector("#ma-step3").classList.add("hidden");
      m.querySelector("#ma-err").classList.add("hidden");
      m.querySelector("#ma-cand-list").innerHTML = "";
      m.classList.remove("hidden");
      requestAnimationFrame(() => m.classList.add("on"));
    }
  };
