import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {blank, defaultAnimation} from '../shared/layout.mjs';
import {applyArtworkAppearance, applyHueShift, renderAnimation, animationDuration, scaleColor} from '../shared/render-animation.mjs';
import {Store, validateAnimation} from '../server/storage.mjs';

const freeze = value => {if (value && typeof value === 'object') {Object.values(value).forEach(freeze); Object.freeze(value);} return value;};

test('default and explicit 100% appearance preserve legacy HEX bytes and source arrays', () => {
  const colors = freeze(['#AbCdEf', '#aAaAaA', '#000000', '#fFfFfF']);
  for (const animation of [undefined, {}, {brightness: undefined}, {brightness: 100}, {hueShift: 0, brightness: 100}]) {
    const output = applyArtworkAppearance(colors, animation);
    assert.deepEqual(output, colors);
    assert.notEqual(output, colors);
  }
  assert.deepEqual(applyArtworkAppearance(colors, {hueShift: 37, brightness: 100}), applyHueShift(colors, 37));
  assert.equal(Object.hasOwn(defaultAnimation, 'brightness'), false);
  assert.equal(Object.hasOwn(validateAnimation({}), 'brightness'), false);
  assert.equal(Object.hasOwn(validateAnimation({brightness: undefined}), 'brightness'), false);
});

test('appearance rotates hue before dimming and keeps black, gray and source colors intact', () => {
  const colors = freeze(['#01e241', '#000000', '#808080', '#ffffff']);
  assert.deepEqual(applyArtworkAppearance(colors, {hueShift: 12.5, brightness: 37}),
    ['#005429', '#000000', '#2f2f2f', '#5e5e5e']);
  // Reversing these operations would round the first color to #00542a.
  assert.equal(applyHueShift([scaleColor(colors[0], 0.37)], 12.5)[0].toLowerCase(), '#00542a');
  assert.deepEqual(colors, ['#01e241', '#000000', '#808080', '#ffffff']);
  assert.deepEqual(applyArtworkAppearance(['#ff0000', '#00ff00', '#0000ff'], {brightness: 50}),
    ['#800000', '#008000', '#000080']);
});

test('all five effect paths apply brightness once after rendering without changing duration', () => {
  const colors = blank(); colors[31] = '#dc847b'; colors[32] = '#123456';
  const frame = blank(); frame[12] = '#00aa88';
  const source = freeze(colors), frameColors = freeze(frame);
  for (const effect of ['static', 'pulse', 'wave', 'move', 'frames']) {
    const animation = freeze({effect, speed: 3, direction: 'right', loop: false,
      frames: [{colors: frameColors, duration: 300}]});
    for (const elapsed of [0, 175, 900]) {
      const legacy = renderAnimation(source, animation, elapsed);
      assert.deepEqual(renderAnimation(source, {...animation, brightness: 100}, elapsed), legacy, effect + ' legacy bytes');
      assert.deepEqual(renderAnimation(source, {...animation, brightness: 50}, elapsed), legacy.map(color => scaleColor(color, 0.5)), effect + ' single dimming');
      assert.ok(renderAnimation(source, {...animation, brightness: 0}, elapsed).every(color => color === '#000000'), effect + ' zero output');
    }
    assert.equal(animationDuration({...animation, brightness: 0}), animationDuration(animation));
    assert.equal(animationDuration({...animation, hueShift: 37, brightness: 50}), animationDuration(animation));
    assert.equal(Object.hasOwn(animation, 'brightness'), false);
  }
  assert.equal(source[31], '#dc847b');
  assert.equal(frameColors[12], '#00aa88');
});

test('frame brightness and hue preserve speed boundaries, wrapping, final frame and saved timing', () => {
  const first = blank(), last = blank();
  first[1] = '#ff0000'; last[2] = '#0000ff';
  const animation = freeze({effect: 'frames', speed: 8, loop: false, hueShift: 120, brightness: 50,
    frames: [{colors: first, duration: 100}, {colors: last, duration: 200}]});
  assert.equal(animationDuration(animation), 150);
  assert.equal(renderAnimation(first, animation, 49.9)[1], '#008000');
  assert.equal(renderAnimation(first, animation, 49.9)[2], '#000000');
  assert.equal(renderAnimation(first, animation, 50)[2], '#800000');
  assert.equal(renderAnimation(first, animation, 150)[2], '#800000');
  assert.equal(renderAnimation(first, animation, 9999)[2], '#800000');
  assert.equal(renderAnimation(first, {...animation, loop: true}, 150)[1], '#008000');
  assert.equal(first[1], '#ff0000');
  assert.equal(last[2], '#0000ff');
  assert.deepEqual(animation.frames.map(frame => frame.duration), [100, 200]);
});

test('move brightness retains physical destination and pulse brightness retains phase', () => {
  const colors = blank(); colors[31] = '#ff0000';
  const moved = renderAnimation(colors, {effect: 'move', direction: 'right', speed: 1, loop: true, brightness: 50}, 1000);
  assert.equal(moved[31], '#000000');
  assert.equal(moved[32], '#800000');
  const pulse = {effect: 'pulse', speed: 2, brightness: 50};
  assert.equal(renderAnimation(colors, pulse, 0)[31], '#100000');
  assert.equal(renderAnimation(colors, pulse, Math.PI / 1.8 * 1000)[31], '#800000');
});

test('brightness saves, reopens and imports without baking palette or frames or migrating legacy works', async t => {
  for (const brightness of [0, 0.5, 37.5, 100])
    assert.equal(validateAnimation({brightness}).brightness, brightness);
  const dir = await mkdtemp(path.join(tmpdir(), 'nuphylab-artwork-brightness-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const store = await new Store(dir).load();
  const legacy = await store.saveScene({name: 'Legacy pulse', colors: blank(), animation: {effect: 'pulse'}});
  const bytes = await readFile(store.file, 'utf8');
  const legacyReopened = await new Store(dir).load();
  assert.equal(Object.hasOwn(legacyReopened.data.scenes[0].animation, 'brightness'), false);
  assert.equal(await readFile(store.file, 'utf8'), bytes);
  const colors = blank(), frameColors = blank(); colors[0] = '#dc847b'; frameColors[2] = '#71958b';
  const saved = await store.saveScene({name: 'Dimmed frames', colors,
    animation: {effect: 'frames', speed: 8, hueShift: 27.5, brightness: 37.5,
      frames: [{colors: frameColors, duration: 320}]}});
  const reopened = await new Store(dir).load();
  const restored = reopened.data.scenes.find(scene => scene.id === saved.id);
  assert.equal(restored.animation.brightness, 37.5);
  assert.deepEqual(restored.colors, colors);
  assert.deepEqual(restored.animation.frames, saved.animation.frames);
  await reopened.importScenes([{...saved, animation: {...saved.animation, brightness: 0}}]);
  const imported = (await new Store(dir).load()).data.scenes[0];
  assert.equal(imported.animation.brightness, 0);
  assert.equal(imported.animation.hueShift, 27.5);
  assert.deepEqual(imported.colors, colors);
  assert.deepEqual(imported.animation.frames, saved.animation.frames);
  assert.deepEqual(reopened.data.scenes.find(scene => scene.id === legacy.id), legacy);
});

test('invalid brightness cannot render or partially save/import artwork', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nuphylab-invalid-brightness-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const store = await new Store(dir).load();
  await store.saveScene({name: 'Keep unchanged', colors: blank()});
  const bytes = await readFile(store.file, 'utf8'), scenes = structuredClone(store.data.scenes);
  for (const brightness of [null, true, '50', NaN, Infinity, -Infinity, -0.001, 100.001, {}, []]) {
    assert.throws(() => validateAnimation({brightness}), /亮度/);
    assert.throws(() => applyArtworkAppearance([], {brightness}), RangeError);
    assert.throws(() => renderAnimation(blank(), {effect: 'static', brightness}, 0), RangeError);
    await assert.rejects(store.saveScene({name: 'Invalid brightness', colors: blank(), animation: {brightness}}), /亮度/);
    await assert.rejects(store.importScenes([
      {name: 'No partial import', colors: blank(), animation: {brightness: 50}},
      {name: 'Invalid brightness', colors: blank(), animation: {brightness}},
    ]), /亮度/);
    assert.equal(await readFile(store.file, 'utf8'), bytes);
    assert.deepEqual(store.data.scenes, scenes);
  }
});
