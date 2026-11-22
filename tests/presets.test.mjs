import test from "node:test";
import assert from "node:assert/strict";
import heartKeys from "../shared/heart-keys.json" with { type: "json" };
import { KEYBOARD_MODEL_IDS, getKeyboardProfile } from "../shared/keyboard-models.mjs";
import { layout, getLayoutForModel } from "../shared/layout.mjs";
import { createPresets, heartColors } from "../shared/presets.mjs";
import { validateAnimation, validateScene } from "../server/storage.mjs";
import { renderAnimation } from "../shared/render-animation.mjs";
import {TypingCross} from '../shared/typing-cross.mjs';

const lit = (colors) => colors.map((color, index) => color !== "#000000" ? index : -1).filter((index) => index >= 0);
const holidays = ["santa-hat", "candy-cane", "christmas-tree", "christmas-stocking", "gift-box", "christmas-bell"];
const retired = ["comet", "rain", "scan"];

test("curated catalog animates every preset and preserves the chosen heart shape", () => {
  const presets = createPresets(layout);
  assert.deepEqual(presets.map(p => p.id), ["heart", "star", "butterfly", ...holidays, "bad-apple-silhouette", "typing-cross"]);
  assert.equal(new Set(presets.map((preset) => preset.id)).size, presets.length);
  assert.equal(presets[0].id, "heart");
  assert.equal(presets[0].name, "一颗小心意");
  assert.deepEqual(new Set(presets.find(p => p.id === "star").colors), new Set(["#000000", "#dc9b1f"]));
  assert.equal(presets.find(p => p.id === "bad-apple-silhouette").name, "Bad Apple");
  assert.ok(!presets.some(preset => ["blank", "diamond", "bowtie", ...retired].includes(preset.id)));
  assert.equal(presets.filter((preset) => preset.category === "pattern").length, 9);
  assert.equal(presets.filter((preset) => preset.category === "motion").length, 2);
  assert.deepEqual(lit(presets[0].colors).map((index) => layout.find((key) => key.index === index).code).sort(), [...heartKeys].sort());
  assert.equal(lit(presets[0].colors).length, 19);
  assert.ok(lit(presets[0].colors).every((index) => presets[0].colors[index] === "#dc1210"));
  assert.equal(presets[0].animation.effect, "pulse");
  assert.equal(presets[0].animation.frames.length, 0);
  assert.deepEqual(heartColors(layout, "#ff1122").filter((color) => color !== "#000000"), Array(19).fill("#ff1122"));
  assert.ok(!JSON.stringify(presets).includes("rainbow"));
  for (const preset of presets) {
    const cross=preset.trigger?.effect==='cross'?new TypingCross(layout):null;
    if(cross){
      assert.ok(cross.render(0,preset.trigger).every(color=>color==='#000000'),'typing preset must wait for input');
      cross.fire('KeyG',0);
    }
    const frames = Array.from({ length: 100 }, (_, i) => cross?cross.render(i*8,preset.trigger):renderAnimation(preset.colors, preset.animation, i * 80));
    assert.ok(new Set(frames.map(JSON.stringify)).size >= 16, `${preset.id}: playback must visibly change`);
  }
  const heart = presets[0];
  const period = 2 * Math.PI / (heart.animation.speed * 0.9) * 1000;
  assert.ok(period >= 3000 && period <= 5000, "heart should breathe slowly");
  for (const at of [0, period / 4, period / 2, period])
    assert.deepEqual(lit(renderAnimation(heart.colors, heart.animation, at)), lit(heart.colors), "breathing must not move or expand the heart");
  assert.deepEqual(renderAnimation(heart.colors, heart.animation, period / 2), heart.colors);
  assert.deepEqual(renderAnimation(heart.colors, heart.animation, 0), renderAnimation(heart.colors, heart.animation, period));
});

test("all preset colors and editable frames round-trip through scene storage", () => {
  const knownIndices = new Set(layout.map((key) => key.index));
  for (const preset of createPresets(layout)) {
    assert.deepEqual(validateAnimation(preset.animation), preset.animation);
    const stored = validateScene(JSON.parse(JSON.stringify(preset)));
    assert.deepEqual(stored.colors, preset.colors);
    assert.deepEqual(stored.animation, preset.animation);
    for (const colors of [preset.colors, ...preset.animation.frames.map((frame) => frame.colors)]) {
      assert.equal(colors.length, 84, preset.id);
      assert.ok(colors.every((color) => /^#[0-9a-f]{6}$/.test(color)), preset.id);
      for (let index = 0; index < colors.length; index++)
        if (!knownIndices.has(index)) assert.equal(colors[index], "#000000", `${preset.id}: phantom LED ${index}`);
    }
    if (preset.id === "blank") assert.equal(lit(preset.colors).length, 0);
    else assert.ok(lit(preset.colors).length >= 3, `${preset.id} has an empty preview`);
    if (preset.animation.effect === "frames") {
      assert.ok(preset.animation.frames.length >= 16 && preset.animation.frames.length <= 40);
      assert.ok(preset.animation.frames.every((frame) => frame.duration >= 80));
      assert.ok(new Set(preset.animation.frames.map((frame) => JSON.stringify(frame.colors))).size >= 16, `${preset.id} does not animate`);
    }
    assert.ok(preset.animation.speed >= 1 && preset.animation.speed <= 10);
    assert.equal(preset.animation.loop, true);
  }
});

test("catalog creation is deterministic, never aliases editable arrays, and respects a sparse physical key map", () => {
  const first = createPresets(layout);
  const second = createPresets(layout);
  assert.deepEqual(first, second);
  const allArrays = first.flatMap((preset) => [preset.colors, preset.animation.frames, ...preset.animation.frames.map((frame) => frame.colors)]);
  assert.equal(new Set(allArrays).size, allArrays.length);
  const silhouette = first.find(preset => preset.id === "bad-apple-silhouette");
  const untouched = structuredClone(second);
  first[0].colors.fill("#ffffff");
  silhouette.colors.fill("#ffffff");
  silhouette.animation.frames[0].colors.fill("#ffffff");
  silhouette.animation.frames[1].duration = 800;
  assert.deepEqual(second, untouched);
  assert.notDeepEqual(silhouette.animation.frames[1].colors, silhouette.animation.frames[0].colors);

  const sparseKeys = layout.filter((key) => key.index % 3 === 0);
  const sparseIndices = new Set(sparseKeys.map((key) => key.index));
  for (const preset of createPresets(sparseKeys))
    for (const colors of [preset.colors, ...preset.animation.frames.map((frame) => frame.colors)])
      for (let index = 0; index < 84; index++)
        if (!sparseIndices.has(index)) assert.equal(colors[index], "#000000");
});

test("community drawings preserve their photographed landmarks and compact layouts keep the top details", () => {
  for (const model of KEYBOARD_MODEL_IDS) {
    const keys = getLayoutForModel(model), profile = getKeyboardProfile(model);
    const catalog = createPresets(keys);
    const index = code => keys.find(key => key.code === code).index;
    const compact = !profile.functionRow;
    const landmarks = {
      "santa-hat": [[compact ? "Digit7" : "F7", "#ef304c"], [compact ? "KeyC" : "KeyD", "#fff4e4"], [compact ? "Digit9" : "F9", "#fff4e4"]],
      "candy-cane": [["Digit3", "#ef304c"], ["Digit5", "#fff4e4"], ["BracketRight", "#fff4e4"], ["Semicolon", "#ef304c"]],
      "christmas-tree": [[compact ? "Digit6" : "F6", "#ffbf48"], ["KeyT", "#29bc68"], ["KeyM", "#ef304c"], ["Space", "#95652d"]],
      "christmas-stocking": [["Digit8", "#fff4e4"], ["KeyI", "#ef304c"], ["KeyH", "#ef304c"], ["KeyN", "#ef304c"]],
      "gift-box": [[compact ? "Digit4" : "F5", "#ffbf48"], [compact ? "KeyT" : "Digit6", "#ffbf48"], ["KeyG", "#ffbf48"], [compact ? "KeyM" : "Comma", "#ef304c"]],
      "christmas-bell": [[compact ? "Digit5" : "F5", "#ef304c"], ["KeyR", "#ffbf48"], ["KeyD", "#ffbf48"], ["KeyN", "#fff0ca"]],
    };
    const used = new Set(keys.map(key => key.index));
    for (const preset of catalog.filter(p => holidays.includes(p.id) || p.id === "bad-apple-silhouette")) {
      const copy = validateScene({...preset, modelId: model});
      assert.deepEqual(copy.animation, preset.animation, model);
      for (const colors of [preset.colors, ...preset.animation.frames.map(frame => frame.colors)]) {
        assert.equal(colors.length, profile.canvasCount);
        for (let i = 0; i < colors.length; i++) if (!used.has(i)) assert.equal(colors[i], "#000000", model);
      }
      if (!landmarks[preset.id]) continue;
      for (const [code, color] of landmarks[preset.id]) assert.equal(preset.colors[index(code)], color, model + " " + preset.id + " " + code);
      const bg = preset.colors[index("Escape")];
      for (const {colors} of preset.animation.frames) {
        assert.ok(keys.every(key => (preset.colors[key.index] === bg) === (colors[key.index] === bg)), "glints must keep the drawing in place");
        assert.ok(keys.filter(key => key.code.startsWith("Numpad")).every(key => colors[key.index] === bg));
      }
    }
  }
});

test("silhouette casts the apple, holds its close-up, sweeps to the negative, then loops on tall and compact boards", () => {
  for (const model of ["air75-v3", "air65-v3"]) {
    const keys = getLayoutForModel(model);
    const {colors, animation} = createPresets(keys).find(p => p.id === "bad-apple-silhouette");
    const {frames} = animation;
    const duration = frames.reduce((total, frame) => total + frame.duration, 0);
    const closeup = frames.findIndex(frame => JSON.stringify(frame.colors) === JSON.stringify(colors));
    assert.ok(closeup > 5);
    assert.deepEqual(renderAnimation(colors, animation, duration, keys), frames[0].colors);
    assert.ok(frames.every(frame => frame.colors.every(rgb => rgb.slice(1,3) === rgb.slice(3,5) && rgb.slice(3,5) === rgb.slice(5))));
    const pixel = (frame, code) => parseInt(frame.colors[keys.find(k => k.code === code).index].slice(1,3), 16);
    const negative = frames.findIndex((frame, i) => i > closeup && pixel(frame, "Digit1") === 242 && pixel(frame, "Equal") === 242 && pixel(frame, "KeyJ") === 0);
    assert.ok(negative > closeup + 3);
    assert.ok(frames.slice(closeup, negative).some(frame => pixel(frame, "Digit1") === 242 && pixel(frame, "Equal") === 0));
    assert.ok(frames.every(frame => pixel(frame, "Space") === 0 && pixel(frame, "ArrowLeft") === 0));
    assert.ok(new Set(frames.map(f => JSON.stringify(f.colors))).size >= 20);
  }
});
