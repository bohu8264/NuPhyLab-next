import {canvasCountForLayout} from "./keyboard-models.mjs";

const palette = {
  red: "#ef304c", ivory: "#fff4e4", gold: "#ffbf48",
  green: "#29bc68", trunk: "#95652d", pearl: "#fff0ca",
};

// The drawings follow physical key names so the number pad on a larger board
// never pulls the motif sideways. Four-row variants keep the missing top detail.
const designs = [
  {
    id: "santa-hat", name: "圣诞帽", description: "冰蓝底上的红帽子，白色绒边连到帽尖的小绒球。",
    background: "#243d50", shimmer: ["ivory"],
    paint: {red: "F7 F8 Digit6 Digit7 Digit8 KeyR KeyT KeyY KeyU KeyI", ivory: "F9 KeyD KeyF KeyG KeyH KeyJ KeyK"},
    compact: {red: "Digit7 Digit8 KeyT KeyY KeyU KeyI KeyF KeyG KeyH KeyJ KeyK", ivory: "Digit9 KeyC KeyV KeyB KeyN KeyM Comma"},
  },
  {
    id: "candy-cane", name: "拐杖糖", description: "红白糖纹横过数字行，在右手边弯成钩。",
    background: "#18372a", shimmer: ["ivory"],
    paint: {red: "Digit3 Digit4 Digit7 Digit8 Minus Equal Semicolon", ivory: "Digit5 Digit6 Digit9 Digit0 BracketRight Quote"},
  },
  {
    id: "christmas-tree", name: "圣诞树", description: "金星下面是层层绿枝，枝间挂着两颗红色彩球。",
    background: "#353b41", shimmer: ["gold", "red"],
    paint: {gold: "F6", green: "Digit6 KeyT KeyY KeyF KeyH KeyJ KeyX KeyC KeyV KeyB KeyN Comma", red: "KeyG KeyM", trunk: "Space"},
    compact: {gold: "Digit6", green: "KeyT KeyY KeyF KeyH KeyJ KeyX KeyC KeyV KeyB KeyN Comma"},
  },
  {
    id: "christmas-stocking", name: "圣诞袜", description: "奶白色袜口下，红袜尖向左翘起。",
    background: "#263d34", shimmer: ["ivory"],
    paint: {ivory: "Digit8 Digit9 Digit0 Minus", red: "KeyI KeyO KeyP KeyH KeyJ KeyK KeyL Semicolon KeyN KeyM Comma Period"},
  },
  {
    id: "gift-box", name: "礼物盒", description: "红色礼盒系着十字金丝带，顶上打了一个蝴蝶结。",
    background: "#243b32", shimmer: ["gold"],
    paint: {red: "Digit4 Digit5 Digit7 Digit8 KeyR KeyT KeyU KeyI KeyV KeyB KeyM Comma", gold: "F5 F6 F7 Digit6 KeyY KeyF KeyG KeyH KeyJ KeyK KeyN"},
    compact: {red: "KeyE KeyR KeyY KeyU KeyC KeyV KeyN KeyM", gold: "Digit4 Digit6 KeyT KeyD KeyF KeyG KeyH KeyJ KeyB"},
  },
  {
    id: "christmas-bell", name: "铃铛", description: "淡紫底上系着红缎带的金铃，铃口下露出浅色铃舌。",
    background: "#34334d", shimmer: ["gold", "pearl"],
    paint: {red: "F5 F6 F7", gold: "Digit5 Digit6 Digit7 KeyR KeyT KeyY KeyU KeyD KeyF KeyG KeyH KeyJ KeyK", pearl: "KeyB KeyN"},
    compact: {red: "Digit5 Digit6 Digit7", gold: "KeyR KeyT KeyY KeyU KeyD KeyF KeyG KeyH KeyJ KeyK"},
  },
];

export function holidayPatterns(keys) {
  const hasFunctionRow = keys.some(key => /^F\d+$/.test(key.code));
  const count = canvasCountForLayout(keys);
  return designs.map(({id, name, description, background, shimmer, paint, compact}) => {
    const inkByCode = new Map();
    for (const [ink, codes] of Object.entries(hasFunctionRow ? paint : {...paint, ...compact}))
      for (const code of codes.split(" ")) inkByCode.set(code, ink);

    const colors = Array(count).fill("#000000");
    const accents = new Set();
    for (const key of keys) {
      const ink = inkByCode.get(key.code);
      colors[key.index] = palette[ink] ?? background;
      if (shimmer.includes(ink)) accents.add(key.index);
    }
    return {id, name, description, colors, accents};
  });
}
