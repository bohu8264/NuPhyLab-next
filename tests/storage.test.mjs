import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import {
  Store,
  validateColors,
  validateAnimation,
  validateSettings,
} from "../server/storage.mjs";
import { blank } from "../shared/layout.mjs";
async function temp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "airstudio-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
test("Air module preference defaults for legacy libraries and persists without changing artwork", async t => {
  const dir = await temp(t), file = path.join(dir, "library.json");
  const legacy = JSON.stringify({ version: 1, scenes: [], settings: { brightness: 42 } });
  await writeFile(file, legacy);
  const store = await new Store(dir).load();
  assert.equal(store.warning, null);
  assert.equal(store.data.settings.airTopRightModule, "rotary");
  assert.equal(await readFile(file, "utf8"), legacy, "loading a legacy file does not rewrite it");
  const scene = await store.saveScene({ name: "保留作品", colors: blank() });
  for (const module of ["keycap", "rotary", "keycap"]) {
    await store.settings({ airTopRightModule: module });
    const reopened = await new Store(dir).load();
    assert.equal(reopened.warning, null);
    assert.equal(reopened.data.settings.airTopRightModule, module);
    assert.equal(reopened.data.settings.brightness, 42);
    assert.deepEqual(reopened.data.scenes, [scene]);
  }
});
test("Air module validation rejects invalid patches and stored values atomically", async t => {
  const store = await new Store(await temp(t)).load();
  await store.settings({ airTopRightModule: "keycap" });
  const before = await readFile(store.file, "utf8");
  for (const value of [undefined, null, "", "knob", "Del", true, 0, [], {}]) {
    assert.throws(() => validateSettings({ airTopRightModule: value }), /Air/);
    await assert.rejects(store.settings({ airTopRightModule: value }), /Air/);
    assert.equal(store.data.settings.airTopRightModule, "keycap");
    assert.equal(await readFile(store.file, "utf8"), before);
  }
  assert.throws(() => validateSettings({ brightness: 30 }, { ...store.data.settings, airTopRightModule: "invalid" }), /Air/);
  const corrupt = JSON.stringify({ version: 1, scenes: [], settings: { airTopRightModule: "invalid" } });
  await writeFile(store.file, corrupt);
  const reopened = await new Store(store.dir).load();
  assert.ok(reopened.warning);
  assert.equal(reopened.readOnly, true);
  await assert.rejects(reopened.settings({ airTopRightModule: "rotary" }));
  assert.equal(await readFile(store.file, "utf8"), corrupt);
});
test('legacy audio loads as single color and multicolor choice persists across reopen',async t=>{
  const dir=await temp(t);
  const original={version:1,scenes:[],settings:{audio:{source:'microphone',deviceId:'saved-mic',effect:'ripple',color:'#ac2345',sensitivity:2,noiseFloor:-40}}};
  await writeFile(path.join(dir,'library.json'),JSON.stringify(original));
  const store=await new Store(dir).load();
  assert.equal(store.data.settings.audio.colorMode,'single');assert.equal(store.warning,null);
  await store.settings({audio:{colorMode:'colorful'}});
  const reopened=await new Store(dir).load();
  assert.equal(reopened.warning,null);
  assert.deepEqual(reopened.data.settings.audio,{...original.settings.audio,colorMode:'colorful'});
  await reopened.settings({audio:{colorMode:'single'}});
  assert.equal((await new Store(dir).load()).data.settings.audio.color,original.settings.audio.color);
});
test("save/reopen/update/delete preserves scene data and original creation time", async (t) => {
  const dir = await temp(t),
    store = await new Store(dir).load();
  const first = await store.saveScene({
    name: "心",
    colors: blank(),
    animation: { effect: "move", loop: true },
  });
  const reopened = await new Store(dir).load();
  assert.equal(reopened.data.scenes[0].name, "心");
  assert.equal(reopened.data.scenes[0].colors.length, 84);
  const edited = await reopened.saveScene({ ...first, name: "移动的心" });
  assert.equal(edited.createdAt, first.createdAt);
  assert.equal(reopened.data.scenes.length, 1);
  await reopened.deleteScene(first.id);
  assert.equal((await new Store(dir).load()).data.scenes.length, 0);
});
test("invalid multi-scene import is atomic and preserves existing library", async (t) => {
  const store = await new Store(await temp(t)).load();
  await store.saveScene({ name: "保留", colors: blank() });
  await assert.rejects(
    store.importScenes([
      { name: "合法", colors: blank() },
      { name: "无效", colors: ["#ff0000"] },
    ]),
    /84/,
  );
  assert.equal(store.data.scenes.length, 1);
  const result = await store.importScenes([{ name: "导入", colors: blank() }]);
  assert.equal(result.count, 1);
  assert.equal(store.data.scenes.length, 2);
});
test("corrupt library is preserved instead of overwritten", async (t) => {
  const dir = await temp(t);
  await writeFile(path.join(dir, "library.json"), "BROKEN");
  const store = await new Store(dir).load();
  assert.ok(store.warning);
  await assert.rejects(store.saveScene({ name: "新作品", colors: blank() }));
  assert.equal(
    await readFile(path.join(dir, "library.json"), "utf8"),
    "BROKEN",
  );
});
test("removed rainbow scenes load and import as static without losing artwork or locking the library", async (t) => {
  const dir = await temp(t);
  const colors = blank();
  colors[20] = "#dc847b";
  colors[23] = "#6493d7";
  const oldScene = {
    id: "legacy-artwork",
    name: "自定义旧作品",
    colors,
    animation: {
      effect: "rainbow",
      direction: "left",
      speed: 6,
      loop: false,
      frames: [{ colors: [...colors].reverse(), duration: 300 }],
    },
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-02T10:00:00.000Z",
  };
  const waveScene = {
    ...oldScene,
    id: "existing-wave",
    name: "保留波浪",
    animation: { ...oldScene.animation, effect: "wave" },
  };
  const original = JSON.stringify({ version: 1, scenes: [oldScene, waveScene] });
  const file = path.join(dir, "library.json");
  await writeFile(file, original);

  const store = await new Store(dir).load();
  const expected = {
    ...oldScene,
    animation: { ...oldScene.animation, effect: "static" },
  };
  assert.equal(store.warning, null);
  assert.ok(!store.readOnly);
  assert.deepEqual(store.data.scenes, [expected, waveScene]);
  assert.equal(await readFile(file, "utf8"), original);

  await store.saveScene({ ...store.data.scenes[0], name: "仍可编辑" });
  const reopened = await new Store(dir).load();
  assert.equal(reopened.data.scenes[0].animation.effect, "static");
  assert.deepEqual(reopened.data.scenes[0].colors, colors);
  assert.equal(reopened.data.scenes[0].name, "仍可编辑");
  assert.equal(reopened.data.scenes[0].createdAt, oldScene.createdAt);
  assert.deepEqual(await reopened.importScenes([oldScene]), { count: 1 });
  const imported = reopened.data.scenes[0];
  assert.equal(imported.animation.effect, "static");
  assert.deepEqual(imported.colors, colors);
  assert.deepEqual(imported.animation.frames, oldScene.animation.frames);
  assert.equal(imported.name, oldScene.name);
  assert.notEqual(imported.id, oldScene.id);
  assert.equal(reopened.data.scenes[2].animation.effect, "wave");

  assert.throws(() => validateAnimation({ effect: "rainbow" }), /不支持/);
  assert.equal(validateAnimation({ effect: "wave" }).effect, "wave");
});
test("malformed colors and excessive frames are rejected before touching hardware", () => {
  assert.throws(() => validateColors(Array(84).fill("red")));
  assert.throws(() => validateAnimation({ effect: "frames", frames: [] }));
  assert.throws(() =>
    validateAnimation({
      effect: "frames",
      frames: Array(121).fill({ colors: blank(), duration: 100 }),
    }),
  );
  assert.throws(() => validateSettings({ brightness: NaN }));
  assert.throws(() => validateSettings({ __proto__: null, unknown: true }));
  assert.throws(() => validateSettings({ slotIds: [true] }));
});

test("optional animation hue shift round-trips without migrating legacy artwork or baking colors", async t => {
  for (const value of [-180, -12.5, 0, 12.5, 180])
    assert.equal(validateAnimation({ hueShift: value }).hueShift, value);
  assert.equal(Object.hasOwn(validateAnimation({}), "hueShift"), false);
  assert.equal(Object.hasOwn(validateAnimation({ hueShift: undefined }), "hueShift"), false);
  const dir = await temp(t), store = await new Store(dir).load();
  const legacy = await store.saveScene({ name: "旧作品", colors: blank(), animation: { effect: "pulse" } });
  const legacyBytes = await readFile(store.file, "utf8");
  const legacyReopened = await new Store(dir).load();
  assert.equal(Object.hasOwn(legacyReopened.data.scenes[0].animation, "hueShift"), false);
  assert.equal(await readFile(store.file, "utf8"), legacyBytes);
  const colors = blank();colors[0] = "#c00000";colors[1] = "#004400";
  const frameColors = blank();frameColors[4] = "#000088";
  const saved = await store.saveScene({
    name: "非破坏色相", colors,
    animation: { effect: "frames", hueShift: 27.5, frames: [{ colors: frameColors, duration: 300 }] },
  });
  const reopened = await new Store(dir).load();
  assert.equal(reopened.data.scenes[0].animation.hueShift, 27.5);
  assert.deepEqual(reopened.data.scenes[0].colors, colors);
  assert.deepEqual(reopened.data.scenes[0].animation.frames[0].colors, frameColors);
  await reopened.importScenes(JSON.parse(JSON.stringify([{ ...saved, animation: { ...saved.animation, hueShift: -75.5 } }])));
  const imported = (await new Store(dir).load()).data.scenes[0];
  assert.equal(imported.animation.hueShift, -75.5);
  assert.deepEqual(imported.colors, colors);
  assert.deepEqual(imported.animation.frames, saved.animation.frames);
  assert.notEqual(imported.id, saved.id);
  assert.deepEqual(reopened.data.scenes.find(scene => scene.id === legacy.id), legacy);
});

test("invalid hue shift cannot partially save or import artwork", async t => {
  const store = await new Store(await temp(t)).load();
  await store.saveScene({ name: "保留", colors: blank() });
  const originalBytes = await readFile(store.file, "utf8"), originalScenes = structuredClone(store.data.scenes);
  for (const hueShift of [null, true, "0", NaN, Infinity, -Infinity, -180.001, 180.001, {}, []]) {
    assert.throws(() => validateAnimation({ hueShift }), /色相/);
    await assert.rejects(store.saveScene({ name: "不应保存", colors: blank(), animation: { hueShift } }), /色相/);
    await assert.rejects(store.importScenes([
      { name: "也不应部分导入", colors: blank(), animation: { hueShift: 30 } },
      { name: "无效色相", colors: blank(), animation: { hueShift } },
    ]), /色相/);
    assert.equal(await readFile(store.file, "utf8"), originalBytes);
    assert.deepEqual(store.data.scenes, originalScenes);
  }
});

test("legacy Snake record is retained while arcade records persist independently", async (t) => {
  const dir = await temp(t);
  await writeFile(path.join(dir, "library.json"), JSON.stringify({ version: 1, scenes: [], bestScore: 12 }));
  const store = await new Store(dir).load();
  assert.deepEqual(store.data.gameBestScores, { snake: 12, whack: 0, memory: 0, pong: 0 });
  await store.bestScore(4, "memory");
  await store.bestScore(20, "whack");
  await store.bestScore(13, "pong");
  await store.bestScore(2, "whack");
  const reopened = await new Store(dir).load();
  assert.equal(reopened.data.bestScore, 12);
  assert.deepEqual(reopened.data.gameBestScores, { snake: 12, whack: 20, memory: 4, pong: 13 });
  await assert.rejects(reopened.bestScore(100, "__proto__"));
  await assert.rejects(reopened.bestScore(NaN, "whack"));
});
