// Layout measured by ShallowRed/nuphy-leds (MIT); see THIRD_PARTY_NOTICES.md.
import { createPresets, heartColors } from "./presets.mjs";
import raw from "./air75-v3-ansi.json" with { type: "json" };
import kickRaw from "./kick75-ansi.json" with { type: "json" };
export const LED_COUNT = 84;
const names = {
  esc: "Escape",
  scr: "PrintScreen",
  ins: "Insert",
  tab: "Tab",
  caps: "CapsLock",
  enter: "Enter",
  pgup: "PageUp",
  pgdn: "PageDown",
  home: "Home",
  end: "End",
  "⌫": "Backspace",
  "`": "Backquote",
  "-": "Minus",
  "=": "Equal",
  "[": "BracketLeft",
  "]": "BracketRight",
  "\\": "Backslash",
  ";": "Semicolon",
  "'": "Quote",
  ",": "Comma",
  ".": "Period",
  "/": "Slash",
  "": "Space",
  "↑": "ArrowUp",
  "←": "ArrowLeft",
  "↓": "ArrowDown",
  "→": "ArrowRight",
  fn: "Fn",
};
export const airLayout = raw.rows.flatMap((row, y) => {
  let x = 0;
  return row.map((k) => {
    const p = {
      index: k.i,
      code:
        names[k.l] ??
        (/^[A-Z]$/.test(k.l)
          ? "Key" + k.l
          : /^[0-9]$/.test(k.l)
            ? "Digit" + k.l
            : k.l === "shift"
              ? k.i === 59
                ? "ShiftLeft"
                : "ShiftRight"
              : k.l === "ctrl"
                ? k.i === 73
                  ? "ControlLeft"
                  : "ControlRight"
                : k.l === "cmd"
                  ? k.i === 75
                    ? "MetaLeft"
                    : "MetaRight"
                  : k.l === "alt"
                    ? "AltLeft"
                    : k.l),
      label:
        {
          esc: "Esc",
          scr: "截图",
          ins: "Ins",
          tab: "Tab",
          caps: "Caps",
          enter: "Enter",
          pgup: "PgUp",
          pgdn: "PgDn",
          home: "Home",
          end: "End",
          shift: "Shift",
          ctrl: "Ctrl",
          alt: "Opt",
          cmd: "⌘",
          fn: "Fn",
        }[k.l] ?? k.l,
      x,
      y,
      w: k.w ?? 1,
      h: 1,
    };
    x += p.w;
    return p;
  });
});
// Kick uses the official physical coordinates and its own contiguous RGB order.
// The dial's three input functions have no per-key RGB indices.
export const kickLayout = kickRaw.rows.flatMap((row) => row.map((key) => ({
  index: key.i,
  code: key.c,
  label: key.l,
  x: key.x,
  y: key.y,
  w: key.w ?? 1,
  h: 1,
})));
let layoutModel = "air75-v3";
export let layout = airLayout;
export function getLayoutModel() { return layoutModel; }
export function setLayoutModel(modelId) {
  const normalized = ["air75v3", "air75-v3-ansi"].includes(modelId) ? "air75-v3" : modelId;
  if (!["air75-v3", "kick75"].includes(normalized))
    throw new Error(`Unsupported keyboard model: ${modelId}`);
  layoutModel = normalized;
  layout = normalized === "kick75" ? kickLayout : airLayout;
  return layout;
}
// Scene files retain their historical 84-slot format across models. Hardware
// adapters send only the active model's physical key slots to the keyboard.
export const blank = () => Array(LED_COUNT).fill("#000000");
export function hsv(h, s = 0.55, v = 0.85) {
  const f = (n) => {
    const k = (n + h * 6) % 6;
    return Math.round(255 * v * (1 - s * Math.max(0, Math.min(k, 4 - k, 1))))
      .toString(16)
      .padStart(2, "0");
  };
  return "#" + f(5) + f(3) + f(1);
}
export function heart(color = "#dc847b") {
  return heartColors(layout, color);
}
export const defaultAnimation = {
  effect: "static",
  direction: "right",
  speed: 4,
  loop: true,
  frames: [],
};
// Keep the historical lowercase RGB form for server consumers.
export const presets = () => createPresets(layout).map((preset) => ({
  ...preset,
  colors: preset.colors.map((color) => color.toLowerCase()),
  animation: {
    ...preset.animation,
    ...(preset.animation.frames ? { frames: preset.animation.frames.map((frame) => ({
      ...frame, colors: frame.colors.map((color) => color.toLowerCase()),
    })) } : {}),
  },
}));
