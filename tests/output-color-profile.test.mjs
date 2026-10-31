import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {applyOutputColorProfile, deriveOutputColorProfileStatus, validateOutputColorProfile} from '../shared/output-color-profile.mjs';
import {Hardware, outputColorBinding} from '../server/hardware.mjs';
import {Store, defaultSettings, validateSettings} from '../server/storage.mjs';
import {fakeService} from './helpers/fake-service.mjs';
import {scaleColor} from '../shared/render-animation.mjs';

const identity = {
  connected: true, identified: true, modelId: 'kick75', productId: 0x1026,
  firmwareVersion: '4.0.18.6', backupPath: '/isolated/devices/kick75-1026-74657374/original-lighting-mac.json',
};
const binding = outputColorBinding(identity);
const profile = (patch = {}) => ({version: 1, enabled: true, binding: {...binding},
  transfer: 'srgb', gains: {r: 1, g: 0.6, b: 0.6}, ...patch});
const freeze = value => {if (value && typeof value === 'object') {Object.values(value).forEach(freeze); Object.freeze(value);} return value;};

test('missing, disabled and all four binding mismatches preserve exact input strings and array', () => {
  const colors = freeze(['#D07D74', '#aBcDeF', '#000000']);
  const original = [...colors];
  for (const candidate of [undefined, null, profile({enabled: false})])
    assert.equal(applyOutputColorProfile(colors, candidate, binding), colors);
  for (const change of [{modelId: 'air75-v3'}, {productId: 0x1027}, {firmwareVersion: '4.0.19.6'}, {deviceKey: 'native-device-v1:' + 'f'.repeat(64)}])
    assert.equal(applyOutputColorProfile(colors, profile(), {...binding, ...change}), colors);
  assert.equal(applyOutputColorProfile(colors, profile(), null), colors);
  assert.deepEqual(colors, original);
});

test('standard sRGB decode and selected sample values have independent byte expectations', () => {
  const selected = freeze(profile());
  const colors = freeze(['#D07D74', '#B0B0B0', '#D09020', '#000000', '#FFFFFF']);
  assert.deepEqual(applyOutputColorProfile(colors, selected, binding), ['#a11f1b', '#6f4242', '#a12b02', '#000000', '#ff9999']);
  const unity = profile({gains: {r: 1, g: 1, b: 1}});
  assert.deepEqual(applyOutputColorProfile(['#808080', '#0a0a0a', '#0b0b0b'], unity, binding), ['#373737', '#010101', '#010101']);
  assert.equal(selected.gains.g, 0.6);
  assert.equal(colors[0], '#D07D74');
});

test('linear transfer preserves legacy PWM meaning and channel order with bounded gains', () => {
  const linear = profile({transfer: 'linear', gains: {r: 1, g: 0.5, b: 0.25}});
  assert.deepEqual(applyOutputColorProfile(['#800000', '#008000', '#000080', '#ffffff', '#000000'], linear, binding),
    ['#800000', '#004000', '#000020', '#ff8040', '#000000']);
  assert.deepEqual(applyOutputColorProfile(['#D07D74'], profile({transfer: 'linear', gains: {r: 1, g: 1, b: 1}}), binding), ['#d07d74']);
});

test('validation rejects unsafe profiles and clones accepted configuration', () => {
  for (const value of [[], {}, profile({version: 2}), profile({enabled: 1}), profile({transfer: 'gamma'}),
    profile({extra: true}), profile({binding: {...binding, deviceKey: '/private/path'}}),
    profile({binding: {...binding, productId: '4134'}}), profile({binding: {...binding, modelId: '__proto__'}}),
    profile({binding: {...binding, firmwareVersion: 'unknown'}})])
    assert.throws(() => validateOutputColorProfile(value));
  for (const gain of [0, -1, 1.01, NaN, Infinity, '0.6', null, undefined])
    assert.throws(() => validateOutputColorProfile(profile({gains: {r: 1, g: gain, b: 1}})));
  assert.doesNotThrow(() => validateOutputColorProfile(profile({gains: {r: 0.01, g: 1, b: 1}})));
  const input = profile(), valid = validateOutputColorProfile(input);
  input.gains.g = 0.2; input.binding.firmwareVersion = '4.0.99.6';
  assert.equal(valid.gains.g, 0.6);
  assert.equal(valid.binding.firmwareVersion, '4.0.18.6');
});

test('trusted native identity is stable across profile/data paths and exposes only a hash', () => {
  assert.equal(binding.deviceKey.length, 'native-device-v1:'.length + 64);
  assert.deepEqual(outputColorBinding({...identity, backupPath: '/other-root/devices/kick75-1026-74657374/original-lighting-win.json'}), binding);
  assert.notEqual(outputColorBinding({...identity, backupPath: '/isolated/devices/kick75-1026-6f74686572/original-lighting-mac.json'}).deviceKey, binding.deviceKey);
  assert.doesNotMatch(JSON.stringify(binding), /isolated|original-lighting|74657374/);
  for (const changed of [{connected: false}, {identified: false}, {readOnly: true}, {backupPath: undefined},
    {backupPath: '/isolated/original-lighting.json'}, {backupPath: '/isolated/devices/kick75-1026-unidentified/original.json'},
    {backupPath: '/isolated/devices/kick75-1026-location-0/original.json'}, {productId: 0x1027},
    {modelId: 'air75-v3', productId: 0x1028}, {firmwareVersion: null, firmware: null}])
    assert.equal(outputColorBinding({...identity, ...changed}), null);
});

test('status distinguishes availability, disabled and exact mismatch without activating a default', () => {
  assert.deepEqual(deriveOutputColorProfileStatus(null, binding), {active: false, matches: false, canBind: true, reason: 'unconfigured', binding});
  assert.equal(deriveOutputColorProfileStatus(profile({enabled: false}), binding).reason, 'disabled');
  assert.equal(deriveOutputColorProfileStatus(profile({enabled: false}), binding).matches, true);
  assert.equal(deriveOutputColorProfileStatus(profile(), null).reason, 'identityUnavailable');
  assert.equal(deriveOutputColorProfileStatus(profile(), {...binding, productId: 0x1027}).reason, 'bindingMismatch');
  assert.equal(deriveOutputColorProfileStatus(profile(), binding).active, true);
});

test('Hardware paint maps exactly once while restore/native requests bypass correction', async () => {
  const hardware = new Hardware('never-launched', 'never-used');
  hardware.state = {...identity};
  const operations = [];
  hardware.request = async (op, args) => {operations.push({op, args}); return {verified: true};};
  const colors = freeze(['#D07D74', '#B0B0B0', '#D09020']);
  await hardware.paint(colors);
  assert.equal(operations[0].args.colors, colors);
  hardware.setOutputColorProfile(profile());
  await hardware.paint(colors);
  assert.deepEqual(operations[1], {op: 'paint', args: {colors: ['#a11f1b', '#6f4242', '#a12b02']}});
  await hardware.restore();
  await hardware.request('nativeLighting', {color: '#D07D74'});
  assert.deepEqual(operations.slice(2), [{op: 'restore', args: undefined}, {op: 'nativeLighting', args: {color: '#D07D74'}}]);
  hardware.state = {...identity, firmwareVersion: '4.0.19.6'};
  await hardware.paint(colors);
  assert.equal(operations.at(-1).args.colors, colors);
});

test('explicit global brightness scales corrected linear output once; omitted option retains the Hardware API', async () => {
  const hardware = new Hardware('never-launched', 'never-used');
  hardware.state = {...identity};
  hardware.setOutputColorProfile(profile());
  const colors = freeze(['#D07D74', '#FFFFFF', '#000000']);
  assert.deepEqual(hardware.outputColors(colors), ['#a11f1b', '#ff9999', '#000000']);
  assert.deepEqual(hardware.outputColors(colors, {brightness: 27}), ['#2b0807', '#452929', '#000000']);
  assert.deepEqual(hardware.outputColors(colors, {brightness: 0}), Array(3).fill('#000000'));
  assert.deepEqual(hardware.outputColors(colors, {brightness: 100}), hardware.outputColors(colors));
  for (const brightness of [-1, 101, NaN, Infinity, '27', null])
    assert.throws(() => hardware.outputColors(colors, {brightness}));
  const requests = [];
  hardware.request = async (op, args) => requests.push({op, args});
  await hardware.paint(colors, {brightness: 27});
  assert.deepEqual(requests, [{op: 'paint', args: {colors: ['#2b0807', '#452929', '#000000']}}]);
  assert.deepEqual(colors, ['#D07D74', '#FFFFFF', '#000000']);
});

test('missing, disabled and mismatched profiles retain exact legacy globally scaled bytes', () => {
  const hardware = new Hardware('never-launched', 'never-used');
  const colors = freeze(['#D07D74', '#aBcDeF', '#000000', '#FFFFFF']);
  for (const selected of [null, profile({enabled: false}), profile()]) {
    hardware.setOutputColorProfile(selected);
    hardware.state = {...identity, ...(selected?.enabled ? {firmwareVersion: '4.0.19.6'} : {})};
    for (const brightness of [0, 27, 100])
      assert.deepEqual(hardware.outputColors(colors, {brightness}), colors.map(color => scaleColor(color, brightness / 100)));
    assert.equal(hardware.outputColors(colors), colors);
  }
});

test('native unchanged paint reuses a proven same-session commit rather than a fresh timestamp', async () => {
  const hardware=new Hardware('never-launched','never-used');hardware.state={...identity,connectionSessionId:'proof:1'};
  let skipped=false;hardware.request=async()=>({painted:80,skipped});
  const first=await hardware.paint(['#123456']);assert.ok(Number.isFinite(first.frameCommittedAt));
  skipped=true;const same=await hardware.paint(['#123456']);
  assert.equal(same.frameCommittedAt,first.frameCommittedAt);assert.equal(same.reusedCommittedFrame,true);
  hardware.state.connectionSessionId='proof:2';const unknown=await hardware.paint(['#123456']);
  assert.equal(unknown.frameCommittedAt,null,'a new USB connection cannot inherit the old native cache proof');
});

test('optional settings persist and clear independently of artwork and existing preferences', async t => {
  assert.equal(Object.hasOwn(defaultSettings, 'outputColorProfile'), false);
  const dir = await mkdtemp(path.join(tmpdir(), 'nuphylab-output-profile-store-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const store = await new Store(dir).load();
  await store.settings({brightness: 83, language: 'en'});
  await store.saveScene({name: 'Unmodified mixed-colour frames', modelId: 'kick75', colors: Array(84).fill('#D07D74'),
    animation: {effect: 'frames', frames: [{colors: Array(84).fill('#B0B0B0'), duration: 320}]}});
  const artwork = structuredClone(store.data.scenes);
  const old = structuredClone(store.data.settings);
  await store.settings({outputColorProfile: profile({enabled: false})});
  const reopened = await new Store(dir).load();
  assert.deepEqual(reopened.data.settings, {...old, outputColorProfile: profile({enabled: false})});
  assert.deepEqual(reopened.data.scenes, artwork);
  const before = await readFile(store.file, 'utf8');
  await assert.rejects(store.settings({outputColorProfile: profile({gains: {r: 2, g: 1, b: 1}})}));
  assert.equal(await readFile(store.file, 'utf8'), before);
  await reopened.settings({outputColorProfile: null});
  const cleared = await new Store(dir).load();
  assert.deepEqual(cleared.data.settings, old);
  assert.deepEqual(cleared.data.scenes, artwork);
  assert.deepEqual(validateSettings({brightness: 15}, {...old, outputColorProfile: profile()}), {...old, outputColorProfile: profile(), brightness: 15});
});

test('real service with a JSONL-only stub refreshes static, paused and agent output and verifies mapped bytes', async t => {
  const service = await fakeService(t, {modelId: 'kick75', firmwareVersion: '4.0.18.6',
    outputIdentity: {productId: identity.productId, backupPath: identity.backupPath}});
  const initial = await service.state();
  assert.equal(initial.device.outputColorProfile.active, false);
  assert.equal(initial.device.outputColorProfile.reason, 'unconfigured');
  const selected = profile({binding: initial.device.outputColorProfile.binding});
  const colors = Array(84).fill('#D07D74');
  const command = async body => {const result = await service.command(body); assert.equal(result.ok, true, JSON.stringify(result)); return result.result;};
  await command({op: 'settings', settings: {brightness: 100}});
  await command({op: 'preview', colors});
  const rawBefore = (await service.operations()).filter(op => op.op === 'paint').at(-1).colors;
  assert.deepEqual(rawBefore, colors.map(c => c.toLowerCase()));
  await command({op: 'settings', settings: {outputColorProfile: selected}});
  const active = await service.state();
  assert.equal(active.device.outputColorProfile.active, true);
  assert.deepEqual(active.colors, colors.map(c => c.toLowerCase()), 'state artwork/output colours remain logical');
  assert.equal((await service.operations()).filter(op => op.op === 'paint').at(-1).colors[0], '#a11f1b');
  const verified = await command({op: 'verifyColors'});
  assert.equal(verified.matches, true);
  assert.equal(verified.expected[0], '#a11f1b');
  await command({op: 'play', colors, animation: {effect: 'frames', speed: 4, loop: true, frames: [{colors, duration: 500}]}});
  await command({op: 'pause'});
  let count = (await service.operations()).filter(op => op.op === 'paint').length;
  await command({op: 'settings', settings: {outputColorProfile: {...selected, enabled: false}}});
  let paints = (await service.operations()).filter(op => op.op === 'paint');
  assert.ok(paints.length > count, 'paused output refreshes when profile is disabled');
  assert.equal(paints.at(-1).colors[0], '#d07d74');
  await command({op: 'settings', settings: {codexEnabled: true}});
  count = (await service.operations()).filter(op => op.op === 'paint').length;
  await command({op: 'settings', settings: {outputColorProfile: selected}});
  paints = (await service.operations()).filter(op => op.op === 'paint');
  assert.ok(paints.length > count, 'agent output refreshes despite unchanged logical colours');
  assert.equal((await command({op: 'verifyColors'})).matches, true);
  // Explicit Restore leaves the AI mode; an internal scene Stop now keeps its
  // persistent status overlay and deliberately does not restore stock colours.
  await command({op: 'restore'});
  const last = (await service.operations()).filter(op => ['restore', 'paint'].includes(op.op)).at(-1);
  assert.equal(last.op, 'restore');
  assert.equal(last.colors, undefined);
});

test('toggling output profile repaints a paused game without moving or replacing its frame', async t => {
  const service = await fakeService(t, {modelId: 'kick75', firmwareVersion: '4.0.18.6',
    outputIdentity: {productId: identity.productId, backupPath: identity.backupPath}});
  const command = async body => {const result = await service.command(body); assert.equal(result.ok, true, JSON.stringify(result)); return result.result;};
  await command({op: 'settings', settings: {brightness: 100}});
  await command({op: 'gameStart', gameType: 'snake', speed: 10});
  await command({op: 'gamePause', paused: true});
  const paused = await service.state(), head = paused.game.body[0];
  assert.equal(paused.game.status, 'paused');
  assert.equal(paused.playback.mode, 'game');
  assert.equal(paused.playback.playing, false);
  assert.equal(paused.colors[head], '#b8d8bd');
  const selected = profile({binding: paused.device.outputColorProfile.binding});
  const paintsBefore = (await service.operations()).filter(op => op.op === 'paint').length;
  await command({op: 'settings', settings: {outputColorProfile: selected}});
  const enabled = await service.state();
  const corrected = (await service.operations()).filter(op => op.op === 'paint');
  assert.equal(corrected.length, paintsBefore + 1, 'enabling profile repaints once even though game is paused');
  assert.equal(corrected.at(-1).colors[head], '#7a694e');
  assert.deepEqual(enabled.colors, paused.colors, 'logical game frame is retained');
  assert.deepEqual(enabled.game, paused.game, 'score, body, food, direction and pause state are retained');
  assert.equal(enabled.playback.playing, false);
  assert.equal((await command({op: 'verifyColors'})).matches, true);
  // More than one 100ms Snake movement interval passes while the real service
  // frame loop runs; profile redraw must not resume or advance the paused game.
  await new Promise(resolve => setTimeout(resolve, 220));
  await command({op: 'settings', settings: {outputColorProfile: {...selected, enabled: false}}});
  const disabled = await service.state();
  const restored = (await service.operations()).filter(op => op.op === 'paint');
  assert.equal(restored.length, corrected.length + 1);
  assert.deepEqual(restored.at(-1).colors, paused.colors, 'disabling returns the identical frame to legacy output bytes');
  assert.deepEqual(disabled.game, paused.game);
  assert.equal(disabled.playback.mode, 'game');
  assert.equal(disabled.playback.playing, false);
  assert.equal((await command({op: 'verifyColors'})).matches, true);
});

test('artwork brightness remains a saved colour operation before profile; global dimming follows it once', async t => {
  const service = await fakeService(t, {modelId: 'kick75', firmwareVersion: '4.0.18.6',
    outputIdentity: {productId: identity.productId, backupPath: identity.backupPath}});
  const command = async body => {const result = await service.command(body); assert.equal(result.ok, true, JSON.stringify(result)); return result.result;};
  const selected = profile({binding: (await service.state()).device.outputColorProfile.binding});
  const colors = freeze(Array(84).fill('#D07D74'));
  await command({op: 'settings', settings: {brightness: 100, outputColorProfile: selected}});
  await command({op: 'play', colors, animation: {effect: 'frames', brightness: 50, speed: 4, loop: true,
    frames: [{colors, duration: 500}]}});
  await command({op: 'pause'});
  const paused = await service.state();
  assert.equal(paused.playback.mode, 'paused');
  assert.equal(paused.device.outputColorProfile.active, true);
  assert.deepEqual(paused.colors, Array(84).fill('#683f3a'), 'logical output includes exactly one artwork dimming');
  const paints = (await service.operations()).filter(op => op.op === 'paint');
  assert.equal(paints.length, 1, 'constant frame is not redundantly repainted');
  assert.deepEqual(paints[0].colors, Array(84).fill('#230806'), 'sRGB decode and gains follow the dimmed artwork bytes once');
  const verified = await command({op: 'verifyColors'});
  assert.equal(verified.matches, true);
  assert.equal(verified.checked, 80);
  assert.deepEqual(verified.expected, Array(80).fill('#230806'));
  await command({op: 'settings', settings: {brightness: 27}});
  assert.deepEqual((await service.state()).colors, Array(84).fill('#1c1110'), 'preview preserves the previous artwork then global dimming algorithm');
  assert.deepEqual((await service.operations()).filter(op => op.op === 'paint').at(-1).colors, Array(84).fill('#090202'), 'only global dimming moves after profile; artwork50 is not silently reinterpreted');
  assert.deepEqual((await command({op: 'verifyColors'})).expected, Array(80).fill('#090202'));
  assert.deepEqual(colors, Array(84).fill('#D07D74'), 'source frame remains unchanged');
});

test('real service keeps preview bytes while global0/27/100 uses corrected wire and disabled profile remains legacy', async t => {
  const service = await fakeService(t, {modelId: 'kick75', firmwareVersion: '4.0.18.6',
    outputIdentity: {productId: identity.productId, backupPath: identity.backupPath}});
  const command = async body => {const result = await service.command(body); assert.equal(result.ok, true, JSON.stringify(result)); return result.result;};
  const selected = profile({binding: (await service.state()).device.outputColorProfile.binding});
  await command({op: 'settings', settings: {brightness: 27, outputColorProfile: selected, codexEnabled: false}});
  const source = Array(84).fill('#D07D74');
  await command({op: 'preview', colors: source});
  assert.deepEqual((await service.state()).colors, Array(84).fill('#38221f'));
  assert.deepEqual((await service.operations()).filter(op => op.op === 'paint').at(-1).colors, Array(84).fill('#2b0807'));
  assert.deepEqual((await command({op: 'verifyColors'})).expected, Array(80).fill('#2b0807'));
  await command({op: 'settings', settings: {brightness: 0}});
  assert.deepEqual((await command({op: 'verifyColors'})).expected, Array(80).fill('#000000'));
  await command({op: 'settings', settings: {brightness: 100}});
  assert.deepEqual((await command({op: 'verifyColors'})).expected, Array(80).fill('#a11f1b'));
  await command({op: 'settings', settings: {brightness: 27, outputColorProfile: {...selected, enabled: false}}});
  assert.deepEqual((await command({op: 'verifyColors'})).expected, Array(80).fill('#38221f'));
  assert.deepEqual(source, Array(84).fill('#D07D74'));
});

test('global27 repaints a paused game at corrected intensity without advancing the game', async t => {
  const service = await fakeService(t, {modelId: 'kick75', firmwareVersion: '4.0.18.6',
    outputIdentity: {productId: identity.productId, backupPath: identity.backupPath}});
  const command = async body => {const result = await service.command(body); assert.equal(result.ok, true, JSON.stringify(result)); return result.result;};
  const selected = profile({binding: (await service.state()).device.outputColorProfile.binding});
  await command({op: 'settings', settings: {brightness: 100, outputColorProfile: selected, codexEnabled: false}});
  await command({op: 'gameStart', gameType: 'snake', speed: 10});
  await command({op: 'gamePause', paused: true});
  const before = await service.state(), head = before.game.body[0];
  const count = (await service.operations()).filter(op => op.op === 'paint').length;
  await command({op: 'settings', settings: {brightness: 27}});
  const after = await service.state(), paints = (await service.operations()).filter(op => op.op === 'paint');
  assert.equal(paints.length, count + 1);
  assert.equal(paints.at(-1).colors[head], '#211c15');
  assert.deepEqual(after.colors, before.colors.map(color => scaleColor(color, .27)));
  assert.deepEqual(after.game, before.game);
  assert.equal(after.playback.playing, false);
  assert.equal((await command({op: 'verifyColors'})).matches, true);
});

test('verifyColors waits for an in-flight tick paint before capturing its exact committed wire frame', async t => {
  const service = await fakeService(t, {modelId: 'kick75', firmwareVersion: '4.0.18.6', paintDelayMs: 180,
    outputIdentity: {productId: identity.productId, backupPath: identity.backupPath}});
  const command = async body => {const result = await service.command(body); assert.equal(result.ok, true, JSON.stringify(result)); return result.result;};
  const selected = profile({binding: (await service.state()).device.outputColorProfile.binding});
  await command({op: 'settings', settings: {brightness: 27, outputColorProfile: selected, codexEnabled: false}});
  await command({op: 'play', colors: Array(84).fill('#D07D74'), animation: {effect: 'frames', speed: 4, loop: true,
    frames: [{colors: Array(84).fill('#D07D74'), duration: 160}, {colors: Array(84).fill('#B0B0B0'), duration: 160}]}});
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await service.operations()).filter(op => op.op === 'paint').length >= 2) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok((await service.operations()).filter(op => op.op === 'paint').length >= 2, 'the real tick entered a delayed second paint');
  const verified = await command({op: 'verifyColors'});
  assert.equal(verified.matches, true);
  const operations = await service.operations();
  const readIndex = operations.findLastIndex(op => op.op === 'readColors');
  const precedingPaint = operations.slice(0, readIndex).filter(op => op.op === 'paint').at(-1);
  assert.deepEqual(verified.expected, precedingPaint.colors.slice(0, 80));
});

async function outputSourceFixture() {
  const source = await readFile(new URL('../server/main.mjs', import.meta.url), 'utf8');
  const functions = source.slice(source.indexOf('async function output(input)'), source.indexOf('function rememberReconnectPlayback()'));
  const verifyCase = source.slice(source.indexOf('    case "verifyColors": {'), source.indexOf('    case "refreshCodex":'));
  const verifyBody = verifyCase.slice(verifyCase.indexOf('{') + 1, verifyCase.lastIndexOf('}'));
  const hardware = new Hardware('never-launched', 'never-used');
  hardware.state = {...identity, armed: true, connectionSessionId: 'fixture:1', keyLedCount: 80};
  hardware.setOutputColorProfile(profile());
  const paints = [];
  hardware.request = async (op, args) => {if (op === 'paint') paints.push(args.colors); return {};};
  const context = vm.createContext({hardware, store: {data: {settings: {brightness: 27}}}, scaleColor, blank:()=>Array(84).fill('#000000'),
    agentEnabled: () => false, agentLightingSource: () => null, playback: {mode: 'static', framesSent: 0}, lightPower: {sleeping: false},
    colors: [], previewColors:[], lastFrame: '', lastCommittedWire: null, agentOutputReceipt:null, frameTimes: [], getLayoutModel: () => 'kick75',
    performance: {now: () => 100}, gameSideMuted: false, lastQuotaColor: null, quotaChanged: 0});
  new vm.Script(functions + '\nasync function verifyFixture(){' + verifyBody + '}').runInContext(context);
  return {context, hardware, paints};
}

test('actual output function caches wire bytes, retains changing preview and commits only successful paint', async () => {
  const {context, hardware, paints} = await outputSourceFixture();
  await context.output(Array(84).fill('#D07D74'));
  const firstPreview = [...context.colors];
  await context.output(Array(84).fill('#D17D74'));
  assert.deepEqual([...context.colors], firstPreview, 'same old preview quantization');
  assert.equal(paints.length, 2, 'different corrected bytes must still paint');
  assert.equal(paints[0][0], '#2b0807');
  assert.equal(paints[1][0], '#2c0807');
  await context.output(Array(84).fill('#050000'));
  const count = paints.length;
  await context.output(Array(84).fill('#060000'));
  assert.equal(paints.length, count, 'same zero wire bytes do not repaint');
  assert.equal(context.colors[0], '#020000', 'preview still updates when only wire quantization is equal');
  assert.equal(context.previewColors[0], '#060000', 'screen palette does not apply global LED dimming');
  const committed = context.lastCommittedWire;
  hardware.request = async () => {throw new Error('fixture paint failed');};
  await assert.rejects(context.output(Array(84).fill('#FFFFFF')), /fixture paint failed/);
  assert.equal(context.lastCommittedWire, committed);
  assert.equal(context.previewColors[0], '#060000', 'failed paint cannot publish its requested screen colour');
  context.invalidateLightingCache();
  assert.equal(context.lastCommittedWire, null);
  assert.ok(context.previewColors.every(color=>color==='#000000'));
});

test('actual verify function snapshots committed wire and fails closed on session changes during read', async () => {
  const {context, hardware} = await outputSourceFixture();
  await context.output(Array(84).fill('#D07D74'));
  let finishRead;
  hardware.request = async op => {
    assert.equal(op, 'readColors');
    return new Promise(resolve => {finishRead = resolve;});
  };
  const pending = context.verifyFixture();
  assert.equal(typeof finishRead, 'function');
  hardware.state.connectionSessionId = 'fixture:2';
  finishRead({colors: Array(85).fill('#2b0807'), customColorScale: 255});
  await assert.rejects(pending, /连接已改变/);
  hardware.state.connectionSessionId = 'fixture:1';
  hardware.transportEpoch++;
  await assert.rejects(context.verifyFixture(), /尚未提交/);
});
