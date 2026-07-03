  const PinPrefs = {
    KEY: "wm_pin_color",
    // 선택 가능한 색상 팔레트 (라벨 + 머리색/머리진한색/바늘끝/글자색)
    PALETTE: [
      { id: "green",  name: "그린(기본)", head: "#10b981", head2: "#047857", needle: "#064e3b", text: "#065f46" },
      { id: "blue",   name: "블루",       head: "#2f6db5", head2: "#1d4f88", needle: "#13315a", text: "#1d4f88" },
      { id: "gold",   name: "골드",       head: "#c9962a", head2: "#9a7016", needle: "#5f450c", text: "#7a5a12" },
      { id: "red",    name: "레드",       head: "#ef4444", head2: "#b91c1c", needle: "#7f1d1d", text: "#991b1b" },
      { id: "purple", name: "퍼플",       head: "#8b5cf6", head2: "#6d28d9", needle: "#4c1d95", text: "#5b21b6" },
      { id: "orange", name: "오렌지",     head: "#f97316", head2: "#c2410c", needle: "#7c2d12", text: "#9a3412" }
    ],
    DEFAULT: "green",
    get() {
      try { return localStorage.getItem(this.KEY) || this.DEFAULT; } catch (e) { return this.DEFAULT; }
    },
    set(id) {
      try { localStorage.setItem(this.KEY, id); } catch (e) {}
      State.pinColor = id;
      try { if (typeof UI !== "undefined") UI.renderPinsOnMap(); } catch (e) {}
    },
    color() {
      const id = State.pinColor || this.get();
      return this.PALETTE.find(p => p.id === id) || this.PALETTE[0];
    }
  };
