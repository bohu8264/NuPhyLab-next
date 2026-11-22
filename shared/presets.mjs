import {canvasCountForLayout} from './keyboard-models.mjs';
import heartKeys from "./heart-keys.json" with { type: "json" };
import {typingCrossThumbnail} from './typing-cross.mjs';
import {holidayPatterns} from "./holiday-lighting.mjs";
import {silhouetteAnimation} from "./silhouette-lighting.mjs";

export const DEFAULT_COLOR = "#dc847b";
const BLACK = "#000000";
const blank = keys => Array(canvasCountForLayout(keys)).fill(BLACK);
const animation = (effect = "static", frames = [], speed = 4) => ({
  effect,
  direction: "right",
  speed,
  loop: true,
  frames,
});
const center = (key) => [key.x + key.w / 2, key.y + (key.h ?? 1) / 2];

export function heartColors(keys, color = "#dc1210") {
  const colors = blank(keys);
  const hasRightMeta = keys.some((key) => key.code === "MetaRight");
  for (const key of keys)
    if (heartKeys.includes(key.code) || (!hasRightMeta && key.code === "AltRight"))
      colors[key.index] = color;
  return colors;
}

// Five rows of ordinary keycaps give each graphic a legible silhouette without
// stretching its bottom pixel across the six-unit Space key. Snap each point
// onto the actual row's key centers instead of treating this as a square grid.
function stencil(keys, rows, color) {
  const colors = blank(keys);
  const physicalRows = [...new Set(keys.map((key) => key.y))].sort((a, b) => a - b);
  rows.forEach((row, y) => {
    const candidates = keys.filter((key) => key.y === physicalRows[y] && key.w <= 1.5);
    [...row].forEach((pixel, x) => {
      if (pixel !== "#") return;
      const targetX = 5.5 + x;
      const key = candidates.reduce((best, current) => {
        const distance = Math.abs(center(current)[0] - targetX);
        return !best || distance < best.distance
          ? { key: current, distance }
          : best;
      }, null);
      if (key && key.distance <= 0.6) colors[key.key.index] = color;
    });
  });
  return colors;
}

function tint(hex, amount) {
  if (amount < 0.045) return BLACK;
  const level = Math.min(1, Math.max(0, amount));
  return "#" + [1, 3, 5].map((start) =>
    Math.round(parseInt(hex.slice(start, start + 2), 16) * level)
      .toString(16).padStart(2, "0"),
  ).join("");
}

function framesFor(keys, count, duration, render) {
  return Array.from({ length: count }, (_, frame) => {
    const colors = blank(keys);
    for (const key of keys) colors[key.index] = render(key, frame / count);
    return { colors, duration };
  });
}

export function createPresets(keys) {
  const graphic = (id, name, description, colors, render, count = 40, duration = 100) => ({
    id, name, category: "pattern", description, colors,
    animation: animation("frames", framesFor(keys, count, duration, render)),
  });
  const mix = (a, b, amount) => "#" + [1, 3, 5].map(start => {
    const left = parseInt(a.slice(start, start + 2), 16);
    const right = parseInt(b.slice(start, start + 2), 16);
    return Math.round(left + (right - left) * amount).toString(16).padStart(2, "0");
  }).join("");
  const cycle = phase => (1 - Math.cos(phase * Math.PI * 2)) / 2;
  const star = stencil(keys, [
    "...#...", "#######", ".#####.", "..#.#..", ".#...#.",
  ], "#dc9b1f");
  const wings = stencil(keys, [
    "##...##", "###.###", ".#####.", ".##.##.", ".#...#.",
  ], "#d68bb5");
  const folded = stencil(keys, [
    "..#.#..", "..###..", "...#...", "..###..", "..#.#..",
  ], "#d68bb5");

  const holidays = holidayPatterns(keys).map(({id, name, description, colors, accents}) =>
    graphic(id, name, description, colors, (key, phase) => {
      if (!accents.has(key.index)) return colors[key.index];
      const glint = cycle(phase + key.x * 0.12 + key.y * 0.07);
      return tint(colors[key.index], 0.78 + 0.22 * glint);
    }, 24, 140));
  const silhouette = silhouetteAnimation(keys);

  return [
    {
      id: "heart", name: "一颗小心意", category: "pattern",
      description: "熟悉的右侧爱心，缓缓亮起，再轻轻暗下。",
      colors: heartColors(keys), animation: animation("pulse", [], 2),
    },
    graphic("star", "星光闪闪", "金色星芒依次闪耀，轮廓始终清晰。", star, (key, phase) => {
      const [x, y] = center(key);
      return tint(star[key.index], 0.32 + 0.68 * cycle(phase + Math.atan2(y - 2.5, x - 8.5) / (Math.PI * 2)));
    }),
    graphic("butterfly", "蝴蝶振翅", "粉紫色的翅膀轻轻收拢，再慢慢展开。", wings, (key, phase) =>
      mix(wings[key.index], folded[key.index], cycle(phase)), 32, 100),
    ...holidays,
    {
      id: "bad-apple-silhouette", name: "Bad Apple", category: "motion",
      description: "人影抛起苹果，画面切到特写，再从左到右反转黑白。原创无声循环。",
      colors: silhouette.colors, animation: animation("frames", silhouette.frames),
    },
    {
      id:'typing-cross',name:'一石二鸟',category:'motion',
      description:'按任意键，从对应位置向横纵扩散，连续按键独立叠加。',
      colors:typingCrossThumbnail(keys),animation:animation(),
      trigger:{code:'Space',count:3,intervalMs:600,effect:'cross',color:'#ffffff',speed:4},
    },
  ];
}
