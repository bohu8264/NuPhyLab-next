import test from "node:test";
import assert from "node:assert/strict";
import { fakeService, until } from "./helpers/fake-service.mjs";
import { heart } from "../shared/layout.mjs";
import { FACTORY_MAC_ROW } from "../shared/keycap-functions.mjs";

const denied = {
  inputMonitoring: false,
  accessibility: false,
  canPostEvents: false,
  promptsRequested: false,
};
const lightingSnapshot = state => ({
  connected: state.device.connected,
  armed: state.device.armed,
  recoveryPending: state.device.recoveryPending,
  hardwareState: state.device.state,
  colors: state.colors,
  playback: state.playback,
  trigger: state.trigger,
  game: state.game,
  settings: state.settings,
  scenes: state.scenes,
});

test('one refresh publishes the current host and helper grants without waiting for a separate native report',async t=>{
  const granted={...denied,inputMonitoring:true,accessibility:true,canPostEvents:true};
  const service=await fakeService(t,{permissions:denied});
  await service.command({op:'disconnect'});
  await service.command({op:'nativePermissions',permissions:denied});
  const before=lightingSnapshot(await service.state());
  await service.configure({permissions:granted});
  const response=await service.command({op:'refreshPermissions',hostPermissions:granted});
  assert.equal(response.ok,true);
  for(const key of ['inputMonitoring','accessibility','canPostEvents'])assert.equal(response.result[key],true);
  assert.deepEqual(response.result.host,{inputMonitoring:true,accessibility:true,canPostEvents:true});
  assert.deepEqual(lightingSnapshot(await service.state()),before);
  const revoked=await service.command({op:'refreshPermissions',hostPermissions:denied});
  assert.equal(revoked.result.accessibility,false,'host revocation immediately wins over helper grant');
});

test('refresh never uses malformed host or helper permission results as a grant',async t=>{
  const granted={...denied,inputMonitoring:true,accessibility:true,canPostEvents:true};
  const service=await fakeService(t,{permissions:granted});
  await service.command({op:'disconnect'});
  await service.command({op:'nativePermissions',permissions:granted});
  assert.equal((await service.command({op:'refreshPermissions',hostPermissions:{accessibility:true}})).ok,false);
  await service.configure({permissions:{...granted,canPostEvents:null}});
  const failed=await service.command({op:'refreshPermissions',hostPermissions:denied});
  assert.equal(failed.ok,false);
  const state=await service.state();
  assert.equal(state.native.host.accessibility,false);
  assert.equal(state.native.canPostEvents,false);
  assert.equal(state.native.helper.canPostEvents,null);
});

test("both permission settings and permission refresh work while the keyboard is disconnected", async t => {
  const service = await fakeService(t, { permissions: denied });
  assert.equal((await service.command({ op: "disconnect" })).ok, true);
  const before = await service.state();
  const start = (await service.operations()).length;
  assert.equal(before.device.connected, false);
  for (const permission of ["inputMonitoring", "accessibility"]) {
    const response = await service.command({ op: "openPermissionSettings", permission });
    assert.equal(response.status, 200);
    assert.deepEqual(response.result, { opened: true, permission, permissions: denied });
  }
  const refreshed = await service.command({ op: "refreshPermissions" });
  assert.equal(refreshed.ok, true);
  assert.deepEqual(refreshed.result, denied);
  const after = await service.state();
  assert.deepEqual(after.native, denied);
  assert.deepEqual(after.device.permissions, denied);
  assert.deepEqual(lightingSnapshot(after), lightingSnapshot(before));
  assert.deepEqual(
    (await service.operations()).slice(start).map(({ op }) => op).filter(op=>!["status","bluetoothDevices"].includes(op)),
    ["openPermissionSettings", "openPermissionSettings", "permissions"],
  );
});

test("permission actions leave an armed static scene and all lighting settings unchanged", async t => {
  const service = await fakeService(t);
  const preview = await service.command({ op: "preview", colors: heart() });
  assert.equal(preview.ok, true);
  const before = await service.state();
  const start = (await service.operations()).length;
  assert.equal(before.device.armed, true);
  assert.equal((await service.command({
    op: "openPermissionSettings",
    permission: "inputMonitoring",
    url: "file:///untrusted-path",
  })).ok, true);
  assert.equal((await service.command({ op: "refreshPermissions" })).ok, true);
  assert.deepEqual(lightingSnapshot(await service.state()), lightingSnapshot(before));
  const forwarded = (await service.operations()).slice(start);
  // The global idle timer polls independently while a static scene is armed.
  // This read-only query is allowed; permission actions must still never paint.
  assert(forwarded.every(({ op }) => ["openPermissionSettings", "permissions", "status", "bluetoothDevices", "systemIdle"].includes(op)),JSON.stringify(forwarded));
  const { id, ...nativeRequest } = forwarded.find(({ op }) => op === "openPermissionSettings");
  assert(Number.isInteger(id));
  assert.deepEqual(nativeRequest, {
    op: "openPermissionSettings",
    permission: "inputMonitoring",
  });
});

test("permission settings reject all values outside the two-entry whitelist before forwarding", async t => {
  const service = await fakeService(t);
  await service.command({ op: "disconnect" });
  const start = (await service.operations()).length;
  const before = lightingSnapshot(await service.state());
  for (const permission of [undefined, null, "", "InputMonitoring", "microphone", "__proto__", "constructor", 1, ["inputMonitoring"], { permission: "accessibility" }]) {
    const response = await service.command({ op: "openPermissionSettings", permission });
    assert.equal(response.status, 400);
    assert.equal(response.ok, false);
    assert.match(response.error, /不支持这个权限设置/);
  }
  const operations = (await service.operations()).slice(start);
  assert(operations.every(({ op }) => ["status","bluetoothDevices"].includes(op)), "invalid values must never reach an open, connect, or lighting operation");
  assert.deepEqual(lightingSnapshot(await service.state()), before);
});

test("refreshPermissions returns the latest native snapshot and updates both state views", async t => {
  const service = await fakeService(t, { permissions: denied });
  await service.command({ op: "disconnect" });
  const initial = await service.command({ op: "refreshPermissions" });
  assert.deepEqual(initial.result, denied);
  const granted = {
    inputMonitoring: true,
    accessibility: true,
    canPostEvents: true,
    promptsRequested: false,
  };
  await service.configure({ permissions: granted });
  const response = await service.command({ op: "refreshPermissions" });
  assert.equal(response.ok, true);
  assert.deepEqual(response.result, granted);
  const current = await service.state();
  assert.deepEqual(current.native, granted);
  assert.deepEqual(current.device.permissions, granted);
  assert.equal(current.device.connected, false);
  assert.equal(current.device.armed, false);
  const revoked = { ...granted, inputMonitoring: false, canPostEvents: false };
  await service.configure({ permissions: revoked });
  const reopened = await service.command({ op: "openPermissionSettings", permission: "accessibility" });
  assert.deepEqual(reopened.result.permissions, revoked);
  assert.deepEqual((await service.state()).native, revoked);
});

test("native authorization changes refresh the helper immediately without changing lighting or requesting trust", async t => {
  const service = await fakeService(t, { permissions: denied });
  await service.command({ op: "preview", colors: heart() });
  assert.equal((await service.command({ op: "nativePermissions", permissions: denied })).ok, true);
  const before = lightingSnapshot(await service.state());
  const start = (await service.operations()).length;
  const granted = { ...denied, inputMonitoring: true, accessibility: true, canPostEvents: true };
  await service.configure({ permissions: granted });
  const response = await service.command({ op: "nativePermissions", permissions: granted });
  assert.equal(response.ok, true);
  const current = await service.state();
  assert.equal(current.native.accessibility, true);
  assert.equal(current.native.canPostEvents, true);
  assert.deepEqual(current.native.helper, granted);
  assert.deepEqual(lightingSnapshot(current), before);
  for (let i = 0; i < 3; i++) {
    assert.equal((await service.command({ op: "nativePermissions", permissions: granted })).ok, true);
  }
  let operations = (await service.operations()).slice(start);
  assert.equal(operations.filter(({ op }) => op === "permissions").length, 1, "unchanged granted host reports do not repeatedly query the helper");
  assert(operations.every(({ op }) => ["permissions", "status", "bluetoothDevices", "systemIdle"].includes(op)), JSON.stringify(operations));

  const revoked = { ...granted, accessibility: false, canPostEvents: false };
  await service.configure({ permissions: revoked });
  assert.equal((await service.command({ op: "nativePermissions", permissions: revoked })).ok, true);
  const after = await service.state();
  assert.equal(after.native.accessibility, false);
  assert.equal(after.native.canPostEvents, false);
  assert.deepEqual(after.native.helper, revoked);
  assert.deepEqual(lightingSnapshot(after), before);
});

test("a delayed helper grant is picked up from unchanged native reports without a window focus event", async t => {
  const service = await fakeService(t, { permissions: denied });
  await service.command({ op: "disconnect" });
  const granted = { ...denied, inputMonitoring: true, accessibility: true, canPostEvents: true };
  assert.equal((await service.command({ op: "nativePermissions", permissions: granted })).ok, true);
  assert.equal((await service.state()).native.accessibility, false, "host trust alone never grants helper access");
  const before = lightingSnapshot(await service.state());
  const start = (await service.operations()).length;
  await service.configure({ permissions: granted });
  assert.equal((await service.command({ op: "nativePermissions", permissions: granted })).ok, true);
  assert.equal((await service.state()).native.accessibility, false, "pending helper checks are throttled");
  await until(async () => {
    assert.equal((await service.command({ op: "nativePermissions", permissions: granted })).ok, true);
    return service.state();
  }, state => state.native.accessibility && state.native.canPostEvents && state.native.inputMonitoring,
  "helper grant did not become visible from the host reports", 4000);
  const operations = (await service.operations()).slice(start);
  assert.equal(operations.filter(({ op }) => op === "permissions").length, 1, "waiting host reports coalesce into one throttled read-only helper check");
  assert(operations.every(({ op }) => ["permissions", "status", "bluetoothDevices"].includes(op)), JSON.stringify(operations));
  assert.deepEqual(lightingSnapshot(await service.state()), before);
});

test("an invalid helper refresh cannot preserve a stale grant or hide host revocation", async t => {
  const granted = { ...denied, inputMonitoring: true, accessibility: true, canPostEvents: true };
  const service = await fakeService(t, { permissions: granted });
  await service.command({ op: "disconnect" });
  assert.equal((await service.command({ op: "nativePermissions", permissions: granted })).ok, true);
  const before = lightingSnapshot(await service.state());
  await service.configure({ permissions: { ...granted, accessibility: null } });
  const revoked = { ...granted, accessibility: false, canPostEvents: false };
  const response = await service.command({ op: "nativePermissions", permissions: revoked });
  assert.equal(response.ok, false, "a malformed helper reply is reported as a failed refresh");
  let state = await service.state();
  assert.equal(state.native.host.accessibility, false);
  assert.equal(state.native.accessibility, false);
  assert.equal(state.native.canPostEvents, false);
  assert.equal(state.native.helper.accessibility, null, "the old helper grant was invalidated");
  assert.deepEqual(lightingSnapshot(state), before);

  assert.equal((await service.command({ op: "nativePermissions", permissions: granted })).ok, false);
  state = await service.state();
  assert.equal(state.native.host.accessibility, true);
  assert.equal(state.native.accessibility, false, "an unverified helper can never inherit host trust");
  await service.configure({ permissions: granted });
  await until(async () => {
    assert.equal((await service.command({ op: "nativePermissions", permissions: granted })).ok, true);
    return service.state();
  }, next => next.native.accessibility === true, "a failed helper check did not retry", 4000);
  assert.deepEqual(lightingSnapshot(await service.state()), before);
});

test("unchanged pending permission checks do not force agent key writes, while grant and revocation still synchronize", async t => {
  const win = Array(98).fill(0), mac = Array(98).fill(0);
  for (let i = 0; i < 12; i++) { win[i + 1] = 58 + i; mac[i + 1] = FACTORY_MAC_ROW[i]; }
  const keymap = { mode: 0, locationId: 1, firmwareVersion: "1.0.16.6", active: mac, defaults: [mac, win] };
  const service = await fakeService(t, { permissions: denied, keymap });
  assert.equal((await service.command({ op: "codexAdapt" })).ok, true);
  assert.equal((await service.command({ op: "nativePermissions", permissions: denied })).ok, true);
  assert.equal((await service.state()).codex.adaptation.status, "permissions");
  const start = (await service.operations()).length;
  await until(async () => {
    assert.equal((await service.command({ op: "nativePermissions", permissions: denied })).ok, true);
    return (await service.operations()).slice(start);
  }, ops => ops.some(({ op }) => op === "permissions"), "pending permissions were not rechecked", 3500);
  for (let i = 0; i < 3; i++) {
    assert.equal((await service.command({ op: "refreshPermissions" })).ok, true);
  }
  const pendingOps = (await service.operations()).slice(start);
  assert(!pendingOps.some(({ op }) => ["readKeymap", "prepareFunctionKey", "adaptKeys", "restoreKeys", "restoreFunctionKey"].includes(op)),
    "rechecking the same denied values must not force another key setup");

  const granted = { ...denied, inputMonitoring: true, accessibility: true, canPostEvents: true };
  await service.configure({ permissions: granted });
  assert.equal((await service.command({ op: "nativePermissions", permissions: granted })).ok, true);
  assert.equal((await service.state()).codex.adaptation.status, "ready", "grant immediately resumes pending adaptation");
  const grantedOps = (await service.operations()).slice(start);
  assert(grantedOps.some(({ op }) => op === "adaptKeys"));
  const revokedStart = (await service.operations()).length;
  await service.configure({ permissions: denied });
  assert.equal((await service.command({ op: "nativePermissions", permissions: denied })).ok, true);
  assert.equal((await service.state()).codex.adaptation.status, "permissions", "revocation immediately pauses adaptation");
  const revokedOps = (await service.operations()).slice(revokedStart);
  assert(revokedOps.some(({ op }) => op === "restoreKeys"));
  assert(revokedOps.some(({ op }) => op === "restoreFunctionKey"));
  assert(!revokedOps.some(({ op }) => op === "adaptKeys"));
});
