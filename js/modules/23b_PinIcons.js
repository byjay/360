  /* ════════════════════════════════════════════════════════════
     PinIcons — 핀(호스팟)별 아이콘 세트
     ────────────────────────────────────────────────────────────
     [마스터 요청] 핀마다 다른 아이콘을 선택·적용 + 디자인 개선.
     • 각 아이콘은 24x24 viewBox 기준 stroke path 로 정의(단색 currentColor).
     • 핀 머리(흰 원, 중심 18,12) 안에 <g transform> 으로 축소 배치된다.
     • 'number' 는 기본값(기존 동작: 번호 표시) — 하위호환.
     ════════════════════════════════════════════════════════════ */
  const PinIcons = {
    // 아이콘 정의: id, 한글명, 24x24 기준 inner SVG(전부 stroke, currentColor)
    SET: [
      { id: "number",   name: "번호",     body: null /* 숫자 표시(기본) */ },
      { id: "camera360",name: "360°카메라",body:'<circle cx="12" cy="12" r="8.5"/><ellipse cx="12" cy="12" rx="8.5" ry="3.4"/><path d="M12 3.5v17"/>' },
      { id: "warning",  name: "경고/위험", body:'<path d="M12 3 2.5 20h19L12 3z"/><path d="M12 10v4"/><circle cx="12" cy="17" r=".6" fill="currentColor" stroke="none"/>' },
      { id: "valve",    name: "밸브/설비", body:'<circle cx="12" cy="12" r="3.2"/><path d="M12 8.8V3M12 21v-5.8M8.8 12H3M21 12h-5.8"/>' },
      { id: "fire",     name: "소화/안전", body:'<path d="M12 3c2 3 4 4.5 4 8a4 4 0 0 1-8 0c0-1.6.6-2.8 1.4-3.8C10.2 9 11 8 12 3z"/>' },
      { id: "electric", name: "전기",     body:'<path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z"/>' },
      { id: "pipe",     name: "배관",     body:'<path d="M3 9h10a3 3 0 0 1 3 3v9"/><path d="M3 6v6M21 18h-6"/>' },
      { id: "gauge",    name: "계측",     body:'<path d="M3.5 14a8.5 8.5 0 0 1 17 0"/><path d="M12 14l4-3"/><circle cx="12" cy="14" r="1.2" fill="currentColor" stroke="none"/>' },
      { id: "door",     name: "출입구",   body:'<rect x="6" y="3" width="12" height="18" rx="1"/><path d="M14.5 12h.01"/>' },
      { id: "note",     name: "정보/메모", body:'<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>' }
    ],
    DEFAULT: "number",

    /** id → 정의(없으면 기본) */
    def(id) { return this.SET.find(s => s.id === id) || this.SET[0]; },

    /** 핀 머리 안에 들어갈 아이콘 SVG 문자열(흰 원 중심 18,12 / 반경≈7.3 기준).
     *  number 이면 null 반환(호출측에서 숫자 text 를 그린다). */
    headMarkup(iconId, color) {
      const d = this.def(iconId);
      if (!d.body) return null;
      // 24x24 아이콘을 약 13px(원지름 14.6) 안에 들어가게: scale≈0.54, 중심(18,12)로 평행이동
      // translate = (18 - 12*0.54, 12 - 12*0.54) = (11.52, 5.52)
      const s = 0.54, tx = 18 - 12 * s, ty = 12 - 12 * s;
      return `<g transform="translate(${tx} ${ty}) scale(${s})"
                 fill="none" stroke="${color || '#065f46'}" stroke-width="2.2"
                 stroke-linecap="round" stroke-linejoin="round">${d.body}</g>`;
    },

    /** 선택 그리드용 미리보기 칩(24x24 단독 SVG) */
    chipSvg(iconId) {
      const d = this.def(iconId);
      if (!d.body) {
        return `<svg viewBox="0 0 24 24" aria-hidden="true"><text x="12" y="12" text-anchor="middle" dominant-baseline="central" font-size="13" font-weight="800" fill="currentColor">#</text></svg>`;
      }
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                   stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d.body}</svg>`;
    }
  };
