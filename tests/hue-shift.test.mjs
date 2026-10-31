import test from "node:test";
import assert from "node:assert/strict";
import { applyHueShift, renderAnimation, animationDuration } from "../shared/render-animation.mjs";
import { hexToHsv } from "../shared/color.mjs";
import { blank, layout, defaultAnimation } from "../shared/layout.mjs";

test("zero hue shift copies original HEX bytes without normalizing case", () => {
  const input = Object.freeze(["#aBcD12", "#00fF00", "#aAaAaA", "#000000"]);
  for (const shift of [undefined, 0, -0]) {
    const output = applyHueShift(input, shift);
    assert.deepEqual(output, input);
    assert.notEqual(output, input);
  }
  assert.equal(Object.hasOwn(defaultAnimation, "hueShift"), false);
});

test("hue rotation preserves a monochrome animation's brightness ramp and achromatic bytes", () => {
  const input = Object.freeze(["#ff0000", "#800000", "#400000", "#000000", "#aAaAaA", "#fFfFfF"]);
  assert.deepEqual(applyHueShift(input, 120), ["#00FF00", "#008000", "#004000", "#000000", "#aAaAaA", "#fFfFfF"]);
  assert.deepEqual(input, ["#ff0000", "#800000", "#400000", "#000000", "#aAaAaA", "#fFfFfF"]);
});

test("a common hue offset keeps separate palette colors and saturation/value", () => {
  const input = Object.freeze(["#c00000", "#00c000", "#0000c0", "#994c26", "#223344"]);
  const output = applyHueShift(input, 60);
  assert.deepEqual(output.slice(0, 3), ["#C0C000", "#00C0C0", "#C000C0"]);
  input.forEach((hex, index) => {
    const before = hexToHsv(hex), after = hexToHsv(output[index]);
    assert.equal(after.s, before.s);
    assert.equal(after.v, before.v);
  });
  assert.deepEqual(applyHueShift(input.slice(0, 3), -120), ["#0000C0", "#C00000", "#00C000"]);
  assert.deepEqual(applyHueShift(["#ff0000"], -180), applyHueShift(["#ff0000"], 180));
  assert.deepEqual(applyHueShift(["#ff0000"], 12.5), ["#FF3500"]);
});

test("invalid hue offsets are rejected rather than silently clamped or coerced", () => {
  for (const value of [null, "0", true, NaN, Infinity, -Infinity, -180.01, 180.01, {}, []])
    assert.throws(() => applyHueShift([], value), RangeError);
  assert.throws(() => renderAnimation(blank(), { effect: "static", hueShift: null }, 0), RangeError);
});

test("static, moving and pulsing output is rotated after its existing rendering", () => {
  const input = blank();
  input[layout[0].index] = "#aBcD12";
  const frozen = Object.freeze(input);
  for (const animation of [{ effect: "static" }, { effect: "move", direction: "right", speed: 4, loop: true }]) {
    assert.deepEqual(renderAnimation(frozen, animation, 0), frozen);
    assert.deepEqual(renderAnimation(frozen, { ...animation, hueShift: 0 }, 0), frozen);
    const shifted = renderAnimation(frozen, { ...animation, hueShift: 120 }, 0);
    assert.notEqual(shifted[layout[0].index], input[layout[0].index]);
    assert.equal(shifted.filter(hex => hex !== "#000000").length, 1);
  }
  const red = Object.freeze(Array(84).fill("#ff0000"));
  assert.equal(renderAnimation(red, { effect: "pulse", hueShift: 0 }, 0)[0], "#1f0000");
  assert.equal(renderAnimation(red, { effect: "pulse", hueShift: 120 }, 0)[0], "#001F00");
});

test("frame output rotates each active frame without rewriting stored frames or their timing", () => {
  const base = Object.freeze(Array(84).fill("#abcdef"));
  const first = Object.freeze(Object.assign(blank(), { 0: "#800000", 1: "#000000", 2: "#777777" }));
  const last = Object.freeze(Object.assign(blank(), { 0: "#000080", 1: "#008000" }));
  const frames = Object.freeze([Object.freeze({ colors: first, duration: 100 }), Object.freeze({ colors: last, duration: 200 })]);
  const animation = Object.freeze({ effect: "frames", speed: 4, loop: false, frames, hueShift: 120 });
  const snapshot = JSON.stringify({ base, animation });
  assert.deepEqual(renderAnimation(base, animation, 0).slice(0, 3), ["#008000", "#000000", "#777777"]);
  for (const elapsed of [100, 299, 300, 9999])
    assert.deepEqual(renderAnimation(base, animation, elapsed).slice(0, 2), ["#800000", "#000080"]);
  assert.equal(animationDuration(animation), 300);
  assert.equal(JSON.stringify({ base, animation }), snapshot);
  const zero = renderAnimation(base, { ...animation, hueShift: 0 }, 0);
  assert.deepEqual(zero, first);
  assert.notEqual(zero, first);
});

test("wave receives the same final hue offset without lighting unused indices", () => {
  const input = Object.freeze(blank());
  const original = renderAnimation(input, { effect: "wave", speed: 3, loop: true }, 712);
  const rotated = renderAnimation(input, { effect: "wave", speed: 3, loop: true, hueShift: 45 }, 712);
  assert.notDeepEqual(rotated, original);
  original.forEach((hex, index) => {
    if (hex === "#000000") return assert.equal(rotated[index], hex);
    const before = hexToHsv(hex), after = hexToHsv(rotated[index]);
    assert.equal(after.s, before.s);
    assert.equal(after.v, before.v);
    const delta = ((after.h - before.h + 540) % 360) - 180;
    assert.ok(Math.abs(delta - 45) < 0.5, `8-bit hue at ${index}: ${delta}`);
  });
  assert.ok(input.every(hex => hex === "#000000"));
});

test("empty-frame and unknown-effect fallback output is also rotated", () => {
  const input = Object.freeze(["#aB0000", "#000000"]);
  for (const animation of [{ effect: "frames", frames: [] }, { effect: "unknown" }]) {
    assert.deepEqual(renderAnimation(input, { ...animation, hueShift: 0 }, 0), input);
    assert.deepEqual(renderAnimation(input, { ...animation, hueShift: 120 }, 0), ["#00AB00", "#000000"]);
  }
});
