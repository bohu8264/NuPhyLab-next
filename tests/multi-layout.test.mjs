import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { airLayout, kickLayout, layout, setLayoutModel, getLayoutModel, blank, heart, presets } from "../shared/layout.mjs";
import { buildGameBoard } from "../server/engine.mjs";

afterEach(() => setLayoutModel("air75-v3"));

const byCode = (keys, code) => keys.find((key) => key.code === code);

test("model switching preserves AIR's existing indices and scene format", () => {
  assert.equal(getLayoutModel(), "air75-v3");
  assert.equal(layout, airLayout);
  const original = JSON.stringify(airLayout);
  assert.equal(airLayout.length, 83);
  assert.equal(byCode(airLayout, "Insert").index, 14);
  assert.equal(byCode(airLayout, "Backquote").index, 15);
  assert.equal(byCode(airLayout, "Space").index, 76);
  assert.equal(byCode(airLayout, "ArrowRight").index, 82);

  assert.equal(setLayoutModel("kick75"), kickLayout);
  assert.equal(layout, kickLayout);
  assert.equal(getLayoutModel(), "kick75");
  assert.deepEqual(blank(), Array(84).fill("#000000"));
  setLayoutModel("air75-v3");
  assert.equal(layout, airLayout);
  assert.equal(JSON.stringify(airLayout), original);
  assert.throws(() => setLayoutModel("unknown"), /Unsupported keyboard model/);
  assert.equal(getLayoutModel(), "air75-v3");
});

test("Kick has 80 unique physical keys and excludes the dial from RGB slots", () => {
  assert.equal(kickLayout.length, 80);
  assert.equal(new Set(kickLayout.map((key) => key.code)).size, 80);
  assert.deepEqual(kickLayout.map((key) => key.index), Array.from({ length: 80 }, (_, index) => index));
  const rowStarts = ["Escape", "Backquote", "Tab", "CapsLock", "ShiftLeft", "ControlLeft"];
  assert.deepEqual(rowStarts.map((code) => byCode(kickLayout, code).index), [0, 14, 29, 44, 58, 71]);
  assert.equal(byCode(kickLayout, "Delete").index, 13);
  assert.equal(byCode(kickLayout, "ArrowRight").index, 79);
  for (const code of ["Insert", "PrintScreen", "End", "ControlRight", "VolumeDown", "VolumeUp"])
    assert.equal(byCode(kickLayout, code), undefined, code);
});

test("Kick geometry retains function group gaps, the right column and wide keys", () => {
  assert.equal(byCode(kickLayout, "F1").x, 1.26);
  assert.equal(byCode(kickLayout, "F5").x, 5.52);
  assert.equal(byCode(kickLayout, "F9").x, 9.8);
  assert.equal(byCode(kickLayout, "Delete").x, 14.06);
  assert.deepEqual(["Home", "PageUp", "PageDown"].map((code) => byCode(kickLayout, code).index), [28, 43, 57]);
  assert.deepEqual([...new Set(kickLayout.map((key) => key.y))], [0, 1.28, 2.32, 3.35, 4.39, 5.43]);
  assert.deepEqual([byCode(kickLayout, "Space").x, byCode(kickLayout, "Space").w], [3.78, 6.45]);
  assert.equal(byCode(kickLayout, "AltRight").index, 75);
  for (const key of kickLayout) {
    assert(key.x >= 0 && key.y >= 0);
    assert(key.w > 0 && key.h === 1);
    assert(key.x + key.w <= 16.36);
  }
});

test("generated artwork uses the active model and leaves nonexistent Kick slots black", () => {
  setLayoutModel("kick75");
  const colors = heart();
  assert.equal(colors.length, 84);
  assert.equal(colors[byCode(kickLayout, "KeyU").index], "#dc847b");
  assert.equal(colors[byCode(kickLayout, "AltRight").index], "#dc847b");
  assert.equal(colors.filter((color) => color !== "#000000").length, 19);
  assert.deepEqual(colors.slice(80), Array(4).fill("#000000"));
  const catalog = presets();
  const star = catalog.find((preset) => preset.id === "star");
  assert.deepEqual([...new Set(kickLayout.filter((key) => star.colors[key.index] !== "#000000").map((key) => key.y))], [0, 1.28, 2.32, 3.35, 4.39]);
  for (const preset of catalog) {
    assert.equal(preset.colors.length, 84);
    assert.deepEqual(preset.colors.slice(80), Array(4).fill("#000000"), preset.id);
    for (const frame of preset.animation.frames ?? [])
      assert.deepEqual(frame.colors.slice(80), Array(4).fill("#000000"), preset.id);
  }
  setLayoutModel("air75-v3");
  assert.equal(heart()[byCode(airLayout, "KeyU").index], "#dc847b");
});

test("Kick's six physical rows form a connected board without phantom keys", () => {
  const board = buildGameBoard(kickLayout);
  assert.deepEqual(board.rows.map((row) => row.length), [14, 15, 15, 14, 13, 9]);
  assert.equal(board.indices.length, 80);
  const reached = new Set([0]);
  const queue = [0];
  for (let cursor = 0; cursor < queue.length; cursor++) {
    for (const index of Object.values(board.neighbors.get(queue[cursor]))) {
      if (index === null || reached.has(index)) continue;
      reached.add(index);
      queue.push(index);
    }
  }
  assert.equal(reached.size, 80);
});
