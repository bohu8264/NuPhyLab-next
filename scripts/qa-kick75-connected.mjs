// Explicit physical Kick75 acceptance. Close/disconnect NuPhyIO and NuPhyLab first.
// This script writes dim test frames and restores the durable original in finally.
// Usage: node scripts/qa-kick75-connected.mjs --run /absolute/lighting-backup.json [report.json] [helper]
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Hardware } from "../server/hardware.mjs";

const [, , flag, backupPath, reportArg, helperArg] = process.argv;
if (flag !== "--run" || !path.isAbsolute(backupPath ?? "")) {
  throw new Error("Use --run /absolute/path/to/lighting-backup.json [report.json] [helper], with other keyboard clients disconnected.");
}
const helper = helperArg ? path.resolve(helperArg) : fileURLToPath(new URL("../bin/HIDBridge", import.meta.url));
const reportPath = reportArg ? path.resolve(reportArg) : path.join(path.dirname(backupPath), `kick75-connected-qa-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
assert.notEqual(reportPath, backupPath, "The report must not replace the recovery journal.");
await mkdir(path.dirname(backupPath), { recursive: true, mode: 0o700 });
await mkdir(path.dirname(reportPath), { recursive: true, mode: 0o700 });
const hardware = new Hardware(helper, backupPath);
const report = {
  startedAt: new Date().toISOString(),
  helper,
  backupBasePath: backupPath,
  passed: false,
  checks: [],
  frames: [],
  // The helper's first-paint/verify path and readColors perform their own wait.
  // No extra settling delay or retry hides a native readback timing failure.
  additionalReadbackDelayMs: 0,
  cleanup: { restoreVerified: false, helperExitedCleanly: false },
};
let originalState;
const normalize = values => values.map(value => value.toLowerCase());
const rgb = values => values.flatMap(value => [1, 3, 5].map(offset => parseInt(value.slice(offset, offset + 2), 16)));
const hex = channels => `#${channels.map(value => value.toString(16).padStart(2, "0")).join("")}`;
const persist = () => writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
async function checked(name, body) {
  await body();
  report.checks.push(name);
  await persist();
  console.log(`PASS ${name}`);
}
async function readColors() {
  const read = await hardware.request("readColors");
  assert.equal(read.ledCount, 85);
  assert.equal(read.colors.length, 85);
  assert.equal(read.customColorScale, 255, "Kick RGB must not inherit AIR quantization.");
  return normalize(read.colors);
}
async function assertSideState() {
  const state = await hardware.status();
  assert.deepEqual(state.state.slice(9, 17), originalState.slice(9, 17), "A main-key frame changed the original side-light configuration.");
  return state;
}
async function paintAndRead(name, colors, verify = true) {
  const sent = await hardware.request("paint", { colors, verify });
  assert.equal(sent.painted, 80);
  assert.equal(sent.verification, verify ? "readback" : "validatedAck");
  const actual = await readColors();
  assert.deepEqual(actual.slice(0, 80), normalize(colors.slice(0, 80)), `${name}: every one of the 80 main RGB entries must match.`);
  await assertSideState();
  report.frames.push({ name, checkedMainEntries: 80, returnedEntries: actual.length, verification: sent.verification, exactMatch: true, sideStatePreserved: true });
}
async function restoreAndCheck() {
  const restored = await hardware.restore();
  assert.equal(restored.verified, true);
  const status = await hardware.status();
  assert.deepEqual(status.state, originalState, "The complete original 17-byte state did not restore.");
  assert.equal(status.recoveryPending, false);
  assert.equal(status.armed, false);
  return status;
}

await persist();
let failure;
try {
  await checked("identify wired Kick75 4.0.18.6 and its independent geometry", async () => {
    const connected = await hardware.connect();
    assert.equal(connected.modelId, "kick75");
    assert.equal(connected.firmwareVersion ?? connected.firmware, "4.0.18.6");
    assert.equal(connected.keyLedCount, 80);
    assert.equal(connected.sideLedCount, 5);
    assert.equal(connected.ledCount, 85);
    assert.equal(connected.capabilities?.perKey, true);
    assert.equal(connected.capabilities?.protocol, "kick75-s4");
    assert.equal(connected.state.length, 17);
    assert.equal(connected.armed, false);
    originalState = [...connected.state];
    report.firmware = connected.firmwareVersion ?? connected.firmware;
    report.modelId = connected.modelId;
    report.lightingProfile = connected.lightingProfile;
    report.originalState = originalState;
    report.initialRgb = await readColors();
  });

  let originalPalette;
  await checked("arm only after a durable original, and capture the original global palette", async () => {
    await hardware.arm();
    const state = await assertSideState();
    assert.equal(state.armed, true);
    assert.equal(state.state[0], 21);
    const journal = JSON.parse(await readFile(state.backupPath, "utf8"));
    assert.equal(journal.productID, hardware.state.productId);
    assert.deepEqual(journal.state, originalState);
    assert.equal(journal.renderedColors.length, 85 * 3);
    assert.equal(journal.customColors.length, 80 * 3);
    originalPalette = (await readColors()).slice(0, 80);
    assert.deepEqual(journal.customColors, rgb(originalPalette), "Durable palette differs from the original mode21 RGB readback.");
    report.recoveryJournalPath = state.backupPath;
    report.originalPalette = originalPalette;
  });

  const dense = Array.from({ length: 84 }, (_, index) => index < 80
    ? hex([index * 7 % 23 + 1, index * 11 % 23 + 1, index * 13 % 23 + 1])
    : "#203040");
  await checked("all 80 keys have exact dim RGB while extra scene slots stay outside Kick", () => paintAndRead("all-80-distinct", dense));

  const endpoints = Array(84).fill("#000000");
  endpoints[0] = "#100000";
  endpoints[79] = "#001000";
  endpoints.fill("#102030", 80);
  await checked("first and final Kick indices are unshifted and independent", () => paintAndRead("first-and-last-keys", endpoints));

  const changed = [...endpoints];
  for (const index of [0, 1, 13, 14, 39, 65, 79]) changed[index] = hex([index % 17 + 1, 8, 16]);
  await checked("ordinary acknowledged frame updates still read back every main key exactly", () => paintAndRead("changed-keys", changed, false));
  await checked("restore the original profile and side state after painting", restoreAndCheck);

  await checked("rearming proves the exact original global palette was restored", async () => {
    await hardware.arm();
    assert.deepEqual((await readColors()).slice(0, 80), originalPalette);
    await assertSideState();
    await restoreAndCheck();
  });

  for (let cycle = 1; cycle <= 2; cycle++) {
    await checked(`disconnect/reconnect ${cycle} preserves original state and palette`, async () => {
      await hardware.disconnect();
      const connected = await hardware.connect();
      assert.equal(connected.modelId, "kick75");
      assert.equal(connected.firmwareVersion ?? connected.firmware, "4.0.18.6");
      assert.deepEqual(connected.state, originalState);
      assert.equal(connected.recoveryPending, false);
      await hardware.arm();
      assert.deepEqual((await readColors()).slice(0, 80), originalPalette);
      await assertSideState();
      await restoreAndCheck();
    });
  }
  report.allChecksPassed = true;
} catch (error) {
  failure = error;
  report.error = { name: error.name, code: error.code ?? null, message: error.message, ...(error.expected === undefined ? {} : { expected: error.expected, actual: error.actual }) };
} finally {
  try {
    if (originalState && hardware.state.connected) {
      await restoreAndCheck();
      report.cleanup.restoreVerified = true;
    }
  } catch (error) {
    report.cleanup.restoreError = error.message;
    failure ??= error;
  }
  try {
    await hardware.close();
    report.cleanup.helperExitedCleanly = true;
  } catch (error) {
    report.cleanup.closeError = error.message;
    failure ??= error;
  }
  report.finishedAt = new Date().toISOString();
  report.passed = Boolean(report.allChecksPassed && report.cleanup.restoreVerified && report.cleanup.helperExitedCleanly && !failure);
  await persist();
}
console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, frames: report.frames.length, reportPath, cleanup: report.cleanup }, null, 2));
if (failure) throw failure;
