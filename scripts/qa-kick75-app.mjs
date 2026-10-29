// Explicit opt-in hardware acceptance against an already running, isolated QA
// service. This script never starts a helper or opens HID itself.
// Usage: node scripts/qa-kick75-app.mjs /absolute/qa-data/runtime.json /absolute/report.json [--trigger]
// Start the service with AIR_STUDIO_DATA pointing at a dedicated QA directory.
// runtime.json and its token are read privately; neither is printed or reported.
import assert from "node:assert/strict";
import { readFile, writeFile, realpath } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { createPresets } from "../shared/presets.mjs";
import { kickLayout } from "../shared/layout.mjs";
import { GAME_TYPES } from "../shared/games.mjs";

const args = process.argv.slice(2);
if (args.length < 2 || args.length > 3 || (args[2] && args[2] !== "--trigger")) {
  console.error("Usage: node scripts/qa-kick75-app.mjs <isolated-QA-runtime.json> <report.json> [--trigger]");
  process.exitCode = 1;
} else {
  await run(args[0], args[1], args[2] === "--trigger");
}

async function run(runtimePath, reportPath, includeTrigger) {
  // Check this before entering the report-producing error path: a failed
  // preflight must never overwrite the private runtime with its failure report.
  const runtimeRealPath = await realpath(runtimePath).catch(() => path.resolve(runtimePath));
  const reportRealPath = await realpath(reportPath).catch(() => path.resolve(reportPath));
  if (runtimeRealPath === reportRealPath) {
    console.error("Report must not overwrite runtime.json.");
    process.exitCode = 1;
    return;
  }
  const report = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    modelId: "kick75",
    requiredFirmware: "4.0.18.6",
    passed: false,
    brightness: 10,
    presetPlaybackMs: 400,
    gamePlaybackMs: 350,
    readbackSettleMs: 80,
    checks: [],
    presets: [],
    games: [],
    trigger: { requested: includeTrigger, tested: false },
    cleanup: { attempted: false, errors: [] },
  };
  let token = "";
  let initial;
  let mayHaveChanged = false;
  let baseURL;
  let interrupted = false;
  const onSignal = () => { interrupted = true; };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const safeError = (error) => {
    const text = error instanceof Error ? error.message : String(error);
    return token ? text.split(token).join("[redacted]") : text;
  };
  const ensureRunning = () => {
    if (interrupted) throw new Error("Acceptance interrupted; restoring original lighting and settings.");
  };
  const normalize = (colors) => colors.map((color) => color.toLowerCase());
  const check = (label) => {
    report.checks.push(label);
    console.log(label);
  };
  async function request(endpoint, body) {
    const response = await fetch(new URL(endpoint, baseURL), {
      method: body === undefined ? "GET" : "POST",
      headers: { "X-Air-Token": token, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    });
    let value;
    try { value = await response.json(); }
    catch { throw new Error(`Local API returned invalid JSON (HTTP ${response.status}).`); }
    assert(response.ok && value?.ok !== false, value?.error || `Local API HTTP ${response.status}`);
    return value;
  }
  const state = () => request("/api/state");
  const command = async (op, data = {}) => (await request("/api/command", { op, ...data })).result;
  function assertKeyboard(snapshot) {
    assert.equal(snapshot.device?.connected, true, "Kick75 must remain connected");
    assert.equal(snapshot.device.modelId, "kick75", "Service must identify Kick75");
    assert.equal(snapshot.device.firmwareVersion ?? snapshot.device.firmware, "4.0.18.6", "Expected real Kick75 4.0.18.6");
    assert.equal(snapshot.device.keyLedCount, 80);
    assert.equal(snapshot.device.sideLedCount, 5);
    assert.equal(snapshot.device.ledCount, 85);
    assert.equal(snapshot.device.capabilities?.perKey, true);
    assert.equal(snapshot.layout?.length, 80, "Service must expose the 80-key Kick layout");
    assert.deepEqual(snapshot.layout.map((key) => key.index), Array.from({ length: 80 }, (_, index) => index));
  }
  function assertNoPending(snapshot) {
    assert.equal(snapshot.device.armed, false, "Keyboard must be disarmed");
    assert.equal(snapshot.device.recoveryPending, false, "Recovery must be complete");
    assert.equal(snapshot.device.needsRestore, false, "No restoration may remain pending");
    assert.deepEqual(snapshot.device.deferredProfiles ?? [], [], "No deferred profile restoration may remain");
  }
  async function verifyPaused(label) {
    const paused = await state();
    assertKeyboard(paused);
    assert.equal(paused.playback.playing, false, `${label}: playback must be paused`);
    assert.equal(paused.playback.lastError, null, `${label}: playback error`);
    assert.equal(paused.device.armed, true, `${label}: lighting must be armed`);
    assert.equal(paused.colors.length, 84, `${label}: scene format must remain 84 slots`);
    assert.deepEqual(normalize(paused.colors.slice(80)), Array(4).fill("#000000"), `${label}: nonexistent Kick slots must stay black`);
    await delay(report.readbackSettleMs);
    const verified = await command("verifyColors");
    assert.equal(verified.checked, 80, `${label}: verify every physical RGB key`);
    assert.equal(verified.matches, true, `${label}: native RGB readback mismatch`);
    assert.deepEqual(verified.mismatches, [], `${label}: mismatched RGB indices`);
    assert.equal(verified.expected?.length, 80);
    assert.equal(verified.actual?.length, 80);
    assert.deepEqual(normalize(verified.expected), normalize(paused.colors.slice(0, 80)), `${label}: Kick must use identity RGB readback`);
    assert.deepEqual(normalize(verified.actual), normalize(paused.colors.slice(0, 80)), `${label}: all 80 key colors must match the paused service frame exactly`);
    const stable = await state();
    assert.equal(stable.playback.playing, false);
    assert.deepEqual(stable.colors, paused.colors, `${label}: frame changed while paused`);
    return paused;
  }
  try {
    let runtime;
    try { runtime = JSON.parse(await readFile(runtimePath, "utf8")); }
    catch { throw new Error("Unable to read a valid private QA runtime.json."); }
    assert(typeof runtime.token === "string" && runtime.token.length > 0, "QA runtime must contain a private API token");
    token = runtime.token;
    try { baseURL = new URL(runtime.url); }
    catch { throw new Error("QA runtime has an invalid local service URL."); }
    assert(baseURL.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(baseURL.hostname)
      && !baseURL.username && !baseURL.password && !baseURL.search && !baseURL.hash && baseURL.pathname === "/",
    "Acceptance can only target an authenticated loopback QA service");
    initial = await state();
    assertKeyboard(initial);
    const qaData = await realpath(initial.device.storagePath);
    const runtimeData = await realpath(path.dirname(path.resolve(runtimePath)));
    assert.equal(qaData, runtimeData, "Runtime must belong to the service's QA data directory");
    assert.notEqual(qaData, path.join(os.homedir(), "Library/Application Support/Air Studio"), "Use isolated AIR_STUDIO_DATA, not the production application data");
    assertNoPending(initial);
    assert.equal(initial.playback.playing, false, "Do not interrupt active playback");
    assert.equal(initial.playback.mode, "idle", "QA service must start idle");
    assert.equal(initial.game.status, "idle", "Do not interrupt an active game");
    assert.equal(initial.trigger.armed, false, "Do not interrupt an armed trigger");
    assert.equal(initial.audio?.active, false, "Do not interrupt audio capture");
    assert(Array.isArray(initial.device.state) && initial.device.state.length === 17, "Original Kick lighting state must contain all 17 bytes");
    report.originalState = [...initial.device.state];
    assert.deepEqual(await request("/api/layout"), initial.layout, "Layout endpoint must agree with service state");
    assert.deepEqual(initial.layout, kickLayout, "Service must use the official Kick geometry");
    check("Identify real USB Kick75 4.0.18.6, 80+5 LEDs and the official layout in isolated QA data");

    ensureRunning();
    // Arm cleanup before a settings mutation whose response could be lost.
    mayHaveChanged = true;
    await command("settings", { settings: {
      codexEnabled: false, claudeEnabled: false, quotaSideEnabled: false,
      codexKeyAdaptation: false, codexKeycapFallback: false,
      brightness: 10, lightDurationMs: 0, lightIdleMs: 0,
    } });
    await command("stop");
    const catalog = createPresets(kickLayout);
    assert.equal(catalog.length, 12, "Expected the complete twelve-preset catalog");
    for (const preset of catalog) {
      ensureRunning();
      const before = (await state()).playback.framesSent;
      await command("play", { colors: preset.colors, animation: preset.animation });
      await delay(report.presetPlaybackMs);
      ensureRunning();
      await command("pause");
      const paused = await verifyPaused(`Preset ${preset.id}`);
      assert.equal(paused.playback.mode, "paused");
      assert(paused.playback.framesSent > before, `${preset.id}: no RGB frame reached the service output`);
      report.presets.push({ id: preset.id, framesSent: paused.playback.framesSent - before, checked: 80, exactReadback: true });
      check(`Preset ${preset.id}: 400 ms playback, pause and exact 80-key readback`);
    }
    await command("stop");
    for (const type of GAME_TYPES) {
      ensureRunning();
      await command("gameStart", { gameType: type, speed: 1 });
      await delay(report.gamePlaybackMs);
      ensureRunning();
      await command("gamePause", { paused: true });
      const paused = await verifyPaused(`Game ${type}`);
      assert.equal(paused.game.type, type);
      assert.equal(paused.game.status, "paused");
      const read = await command("readColors");
      assert.equal(read.colors.length, 85);
      assert.deepEqual(normalize(read.colors.slice(80)), Array(5).fill("#000000"), `${type}: game must leave the side LEDs dark`);
      await command("gameStop");
      const ended = await state();
      assert.equal(ended.game.status, "idle");
      assertNoPending(ended);
      report.games.push({ type, checked: 80, exactReadback: true, sideLEDsDark: 5, stopped: true });
      check(`Game ${type}: 350 ms playback, pause, exact 80-key readback and stop`);
    }
    if (includeTrigger) {
      ensureRunning();
      await command("triggerArm", { colors: catalog[0].colors, trigger: { code: "Space", count: 1, intervalMs: 400 } });
      assert.equal((await state()).trigger.armed, true);
      await command("triggerFire");
      await delay(600);
      ensureRunning();
      const finished = await verifyPaused("Software trigger");
      assert.equal(finished.trigger.flashing, false);
      assert.equal(finished.trigger.completed, 1);
      assert(normalize(finished.colors).every((color) => color === "#000000"));
      await command("triggerStop");
      report.trigger = { requested: true, tested: true, softwareFire: true, checked: 80, exactReadback: true };
      check("Software trigger completes one flash and returns every key to black");
    }
    report.testCasesCompleted = true;
  } catch (error) {
    report.error = safeError(error);
  } finally {
    if (initial && mayHaveChanged) {
      report.cleanup.attempted = true;
      // Attempt every restoration step even when an earlier request failed.
      for (const [label, action] of [
        ["stop", () => command("stop")],
        ["restoreSettings", () => command("settings", { settings: initial.settings })],
        ["finalStop", () => command("stop")],
      ]) {
        try { await action(); }
        catch (error) { report.cleanup.errors.push({ step: label, error: safeError(error) }); }
      }
      try {
        const final = await state();
        assertKeyboard(final);
        assertNoPending(final);
        assert.deepEqual(final.device.state, report.originalState, "Final lighting state must equal every original byte");
        assert.deepEqual(final.settings, initial.settings, "All original QA settings must be restored");
        assert.deepEqual(final.scenes, initial.scenes, "Saved scenes must remain unchanged");
        assert.equal(final.playback.mode, "idle");
        assert.equal(final.playback.playing, false);
        assert.equal(final.game.status, "idle");
        assert.equal(final.trigger.armed, false);
        assert.equal(final.audio?.active, false);
        report.finalState = [...final.device.state];
        Object.assign(report.cleanup, { original17BytesRestored: true, settingsRestored: true, scenesUnchanged: true, noPendingRecovery: true, idle: true });
        check("Stop restores all original 17 lighting bytes, clears pending recovery and restores QA settings");
      } catch (error) {
        report.cleanup.errors.push({ step: "verifyRestoration", error: safeError(error) });
      }
    }
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
  report.finishedAt = new Date().toISOString();
  report.passed = report.testCasesCompleted === true && !report.error && !interrupted
    && report.presets.length === 12 && report.games.length === 4
    && report.cleanup.original17BytesRestored === true && report.cleanup.errors.length === 0;
  try { await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 }); }
  catch (error) {
    console.error("Unable to save the acceptance report: " + safeError(error));
    process.exitCode = 1;
    return;
  }
  if (report.passed) console.log("Kick75 application acceptance passed: 12 presets, 4 games and complete restoration.");
  else {
    const reason = report.error ?? (report.cleanup.errors.map((item) => item.error).join("; ") || "interrupted or incomplete");
    console.error("Kick75 application acceptance failed: " + reason);
    process.exitCode = 1;
  }
}
