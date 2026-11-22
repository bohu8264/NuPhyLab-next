import {canvasCountForLayout} from "./keyboard-models.mjs";

// Original pixel drawings. The second pose raises the hand from the third
// row to meet the apple. The short layout has its own hat, hem and apple leaf.
const tall = {
  rest:  ["...#........", ".####.......", "..##........", "...####.....", ".####......."],
  throw: ["...#........", ".####.......", "..##..#.....", "...###......", "..####......"],
  apple: [".......##...", "....##.##...", "...#######..", "...######...", "....####...."],
};
const short = {
  rest:  ["..##........", ".####.......", "..####......", ".####......."],
  throw: ["..##........", ".####.#.....", "..####......", "..####......"],
  apple: [".......##...", "....##.##...", "...#######..", "....#####..."],
};

const rows = [
  "F1 F2 F3 F4 F5 F6 F7 F8 F9 F10 F11 F12",
  "Digit1 Digit2 Digit3 Digit4 Digit5 Digit6 Digit7 Digit8 Digit9 Digit0 Minus Equal",
  "KeyQ KeyW KeyE KeyR KeyT KeyY KeyU KeyI KeyO KeyP BracketLeft BracketRight",
  "KeyA KeyS KeyD KeyF KeyG KeyH KeyJ KeyK KeyL Semicolon Quote",
  "KeyZ KeyX KeyC KeyV KeyB KeyN KeyM Comma Period Slash",
];
const clamp = value => Math.max(0, Math.min(1, value));
const mix = (from, to, t) => from + (to - from) * t;
const gray = Array.from({length: 256}, (_, n) => "#" + n.toString(16).padStart(2, "0").repeat(3));

export function silhouetteAnimation(keys) {
  const compact = !keys.some(key => /^F\d+$/.test(key.code));
  const art = compact ? short : tall;
  const grid = new Map();
  const stageRows = compact ? rows.slice(1) : rows;
  stageRows.forEach((codes, y) => {
    // The Z row begins about one key to the right of the number row.
    const stagger = y === stageRows.length - 1 ? 1 : 0;
    codes.split(" ").forEach((code, x) => grid.set(code, [x + stagger, y]));
  });
  const pixels = keys.filter(key => grid.has(key.code)).map(key => ({
    index: key.index, point: grid.get(key.code),
  }));
  const count = canvasCountForLayout(keys);
  const frames = [];
  function draw(duration, sample) {
    const colors = Array(count).fill("#000000");
    for (const {index, point: [x, y]} of pixels)
      colors[index] = gray[Math.round(clamp(sample(x, y)) * 242)];
    frames.push({colors, duration});
    return colors;
  }
  const ink = (shape, x, y) => Number(shape[y][x] === "#");
  const apple = (x, y) => ink(art.apple, x, y);
  function toss(x, y, t) {
    const handY = art.rest.length - 2;
    const pose = mix(ink(art.rest, x, y), ink(art.throw, x, y), clamp(t * 4));
    const fruitX = 6.7 + t * 3.1;
    const fruitY = handY - (handY - 0.75) * 4 * t * (1 - t) - 0.55 * t;
    return Math.max(pose, clamp(1.2 - Math.hypot(x - fruitX, y - fruitY)));
  }
  const opening = (x, y) => toss(x, y, 0);
  draw(450, opening);
  for (let step = 1; step <= 9; step++) draw(125, (x, y) => toss(x, y, step / 9));
  for (let step = 1; step < 5; step++)
    draw(110, (x, y) => mix(toss(x, y, 1), apple(x, y), step / 5));
  const thumbnail = draw(420, apple).slice();

  // Wipe the negative across the stage a column at a time, then reveal the
  // opening drawing. This avoids a simultaneous full-board light/dark cut.
  const wipe = (from, to, step) => (x, y) => mix(from(x, y), to(x, y), clamp(step * 1.5 - x));
  const negative = (x, y) => 1 - apple(x, y);
  for (let step = 1; step <= 8; step++) draw(step === 8 ? 430 : 125, wipe(apple, negative, step));
  for (let step = 1; step < 8; step++) draw(125, wipe(negative, opening, step));
  return {colors: thumbnail, frames};
}
