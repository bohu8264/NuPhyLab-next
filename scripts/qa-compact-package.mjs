// Exercise the existing offline suite with the candidate app's Node and code.
// The real app and HID device are never opened. Only the temporary test mirror
// created here is removed; candidate, original app and reports stay untouched.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, cp, link, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [appArg, originalArg, reportArg] = process.argv.slice(2);
if (!appArg) throw new Error('Usage: node scripts/qa-compact-package.mjs <candidate.app> [original.app|-] [report-directory]');
const app = path.resolve(appArg);
const original = originalArg && originalArg !== '-' ? path.resolve(originalArg) : null;
const resources = path.join(app, 'Contents/Resources');
const runtime = path.join(resources, 'runtime/node');
const reportDir = path.resolve(reportArg ?? path.join(root, 'release', `compact-package-qa-${Date.now()}`));
const reportFile = path.join(reportDir, 'COMPACT_PACKAGE_QA.json');
if (!app.endsWith('.app') || (original && !original.endsWith('.app'))) throw new Error('Expected .app paths.');
if (reportDir === app || reportDir.startsWith(app + path.sep) || (original && (reportDir === original || reportDir.startsWith(original + path.sep))))
  throw new Error('Reports must be outside both app bundles.');
await mkdir(reportDir, { recursive: true });
for (const name of ['COMPACT_PACKAGE_QA.json', 'compact-runtime.stdout.log', 'compact-runtime.stderr.log', 'compact-hardlink.stdout.log', 'compact-hardlink.stderr.log', 'compact-tests.tap.log', 'compact-tests.stderr.log', 'compact-native.stdout.log', 'compact-native.stderr.log']) {
  try { await access(path.join(reportDir, name)); throw new Error(`Refusing to overwrite an existing QA report: ${name}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

const report = { startedAt: new Date().toISOString(), app, original, reportDir, passed: false, realAppLaunched: false, realHIDOpened: false };
const hash = data => createHash('sha256').update(data).digest('hex');
async function fileHash(file) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}
async function files(directory, prefix = '') {
  const entries = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name), full = path.join(directory, entry.name);
    if (entry.isDirectory()) entries.push(...await files(full, relative));
    else if (entry.isFile()) entries.push(relative);
    else throw new Error(`Unexpected resource type: ${full}`);
  }
  return entries.sort();
}
async function requireFile(file) {
  if (!(await stat(file)).isFile()) throw new Error(`Required package file is missing: ${file}`);
}
// CMS timestamps and stripped symbol tables can change outside Mach-O sections.
// Hash every loadable section, including its size/type; zero-fill sections have
// no file bytes, so compare their metadata. Reject malformed/out-of-bounds data.
async function sections(file) {
  const data = await readFile(file);
  if (data.length < 32 || data.readUInt32LE(0) !== 0xfeedfacf) throw new Error(`Expected thin 64-bit Mach-O: ${file}`);
  const commandCount = data.readUInt32LE(16), commandsEnd = 32 + data.readUInt32LE(20);
  if (commandsEnd > data.length) throw new Error(`Invalid Mach-O commands: ${file}`);
  let offset = 32;
  const result = [];
  for (let index = 0; index < commandCount; index++) {
    if (offset + 8 > commandsEnd) throw new Error(`Truncated Mach-O command: ${file}`);
    const command = data.readUInt32LE(offset), size = data.readUInt32LE(offset + 4);
    if (size < 8 || offset + size > commandsEnd) throw new Error(`Invalid Mach-O command size: ${file}`);
    if (command === 0x19) {
      if (size < 72) throw new Error(`Truncated Mach-O segment: ${file}`);
      const count = data.readUInt32LE(offset + 64);
      if (72 + count * 80 > size) throw new Error(`Invalid Mach-O section table: ${file}`);
      for (let section = 0; section < count; section++) {
        const at = offset + 72 + section * 80;
        const name = data.subarray(at, at + 16).toString().replace(/\0.*$/s, '');
        const segment = data.subarray(at + 16, at + 32).toString().replace(/\0.*$/s, '');
        const bytes = Number(data.readBigUInt64LE(at + 40)), start = data.readUInt32LE(at + 48);
        const flags = data.readUInt32LE(at + 64), zeroFill = [1, 12, 18].includes(flags & 0xff);
        if (!Number.isSafeInteger(bytes) || (!zeroFill && start + bytes > data.length)) throw new Error(`Invalid Mach-O section bounds: ${file}`);
        result.push({ segment, name, bytes, flags, sha256: zeroFill ? null : hash(data.subarray(start, start + bytes)) });
      }
    }
    offset += size;
  }
  if (!result.length || offset !== commandsEnd) throw new Error(`Missing or inconsistent Mach-O sections: ${file}`);
  return result;
}
async function compareOriginal() {
  const unchanged = [];
  for (const directory of ['server', 'shared', 'ui', 'hooks']) {
    const before = path.join(original, 'Contents/Resources', directory), after = path.join(resources, directory);
    const expected = await files(before), actual = await files(after);
    if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error(`Functional resource inventory changed: ${directory}`);
    for (const file of actual) {
      const sourceHash = hash(await readFile(path.join(before, file))), candidateHash = hash(await readFile(path.join(after, file)));
      if (sourceHash !== candidateHash) throw new Error(`Functional resource bytes changed: ${directory}/${file}`);
      unchanged.push({ file: `${directory}/${file}`, sha256: candidateHash });
    }
  }
  const executableSections = [];
  for (const file of ['Contents/MacOS/AirStudio', 'Contents/Resources/bin/HIDBridge', 'Contents/Resources/runtime/node']) {
    const before = await sections(path.join(original, file)), after = await sections(path.join(app, file));
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error(`Executable sections changed: ${file}`);
    executableSections.push({ file, sections: after });
  }
  return { resourceFilesCompared: unchanged.length, resourcesByteIdentical: true, unchanged, executableSectionsUnchanged: true, executableSections };
}

let work, linkDirectory, temporaryDirectory;
try {
  for (const file of ['Contents/Info.plist', 'Contents/MacOS/AirStudio', 'Contents/Resources/runtime/node', 'Contents/Resources/bin/HIDBridge', 'Contents/Resources/server/main.mjs', 'Contents/Resources/shared/air75-v3-ansi.json', 'Contents/Resources/shared/kick75-ansi.json', 'Contents/Resources/ui/dist/index.html', 'Contents/Resources/hooks/nuphylab-claude-hook.sh', 'Contents/Resources/hooks/nuphylab-claude-hook.mjs'])
    await requireFile(path.join(app, file));
  const html = await readFile(path.join(resources, 'ui/dist/index.html'), 'utf8');
  for (const [, url] of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
    if (/^(?:[a-z]+:|\/\/|#|data:)/i.test(url)) continue;
    const relative = url.split(/[?#]/)[0].replace(/^\//, '');
    const asset = path.resolve(resources, 'ui/dist', relative);
    if (!asset.startsWith(path.join(resources, 'ui/dist') + path.sep)) throw new Error(`Invalid UI resource path: ${url}`);
    await requireFile(asset);
  }
  report.resourceComparison = original ? await compareOriginal() : { skipped: true, reason: 'No original app supplied.' };
  await mkdir(path.join(root, 'release'), { recursive: true });
  work = await mkdtemp(path.join(root, 'release/.compact-package-qa-'));
  await rename(work, work + '.noindex');
  work += '.noindex';
  report.temporaryMirror = work;
  for (const directory of ['server', 'shared', 'hooks', 'ui'])
    await cp(path.join(resources, directory), path.join(work, directory), { recursive: true, errorOnExist: true, force: false });
  for (const directory of ['tests', 'native', 'scripts'])
    await cp(path.join(root, directory), path.join(work, directory), { recursive: true, errorOnExist: true, force: false });
  await cp(path.join(root, 'package.json'), path.join(work, 'package.json'));
  await cp(path.join(resources, 'signing.json'), path.join(work, 'signing.json'));
  // Apple's swiftc launcher traps before emitting diagnostics when TMPDIR is
  // too long. Keep the test HOME/code mirror isolated in the project, and use
  // a separate short, QA-owned directory for compiler/test temporary files.
  temporaryDirectory = await mkdtemp('/private/tmp/nuphylab-qa-tmp-');
  const home = path.join(work, 'isolated-home'), temporary = temporaryDirectory;
  report.isolatedTemporaryDirectory = temporaryDirectory;
  for (const directory of [home, temporary, path.join(home, '.codex'), path.join(home, '.claude'), path.join(home, 'claude-desktop'), path.join(home, 'data')])
    await mkdir(directory, { recursive: true, mode: 0o700 });
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(?:AIR_STUDIO_|CODEX_|CLAUDE_|NODE_)/.test(key)) delete env[key];
  Object.assign(env, { HOME: home, CFFIXED_USER_HOME: home, TMPDIR: temporary + path.sep, TMP: temporary, TEMP: temporary,
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'),
    CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CLAUDE_DESKTOP_SUPPORT: path.join(home, 'claude-desktop'),
    AIR_STUDIO_DATA: path.join(home, 'data'), AIR_STUDIO_HID: path.join(work, 'REAL_HID_DISABLED'), AIR_STUDIO_UI: path.join(work, 'ui/dist') });
  async function run(file, args, stdoutName, stderrName, timeoutMs = 600000) {
    const stdoutLog = path.join(reportDir, stdoutName), stderrLog = path.join(reportDir, stderrName);
    const output = createWriteStream(stdoutLog, { flags: 'wx' }), errors = createWriteStream(stderrLog, { flags: 'wx' });
    const outputFinished = finished(output), errorsFinished = finished(errors);
    const started = Date.now();
    const child = spawn(file, args, { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let tail = '', spawnError = null, timedOut = false, forceKill;
    child.stdout.on('data', chunk => { tail = (tail + chunk.toString()).slice(-262144); });
    child.stdout.pipe(output); child.stderr.pipe(errors);
    child.once('error', error => { spawnError = error.message; });
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      forceKill = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 5000);
      forceKill.unref();
    }, timeoutMs);
    timer.unref();
    const [exitCode, signal] = await new Promise(resolve => child.once('close', (...result) => resolve(result)));
    clearTimeout(timer); clearTimeout(forceKill);
    await Promise.all([outputFinished, errorsFinished]);
    const result = { file, args, exitCode, signal, timedOut, spawnError, durationMs: Date.now() - started, stdoutLog, stderrLog };
    console.log(`${stdoutName}: exit=${exitCode}, duration=${result.durationMs} ms`);
    return { ...result, tail };
  }
  const info = await run(runtime, ['--input-type=module', '-e', 'console.log(JSON.stringify({execPath:process.execPath,version:process.version,arch:process.arch,platform:process.platform}))'], 'compact-runtime.stdout.log', 'compact-runtime.stderr.log', 30000);
  if (info.exitCode !== 0) throw new Error('Candidate Node runtime could not start.');
  report.runtime = { ...JSON.parse(info.tail.trim()), stdoutLog: info.stdoutLog, stderrLog: info.stderrLog, exitCode: info.exitCode };
  if (report.runtime.execPath !== runtime) throw new Error('Tests would use a runtime outside the candidate app.');
  // Existing fake-HID fixtures use #!${process.execPath}. A space in the .app
  // filename makes that interpreter line invalid, so execute this exact Node
  // inode through a QA-owned path without spaces. Never substitute or copy a
  // system runtime, and never change or re-sign the candidate executable.
  let suiteRuntime = path.join(work, 'runtime-node');
  if (/\s/.test(suiteRuntime)) {
    linkDirectory = await mkdtemp('/private/tmp/nuphylab-compact-qa-node-');
    suiteRuntime = path.join(linkDirectory, 'runtime-node');
  }
  if (/\s/.test(suiteRuntime)) throw new Error('Could not create a whitespace-free QA runtime path.');
  try { await link(runtime, suiteRuntime); }
  catch (error) { throw new Error(`Could not hardlink the bundled runtime; no replacement runtime will be used: ${error.message}`); }
  const [bundledStat, linkedStat, bundledHash, linkedHash] = await Promise.all([
    stat(runtime, { bigint: true }), stat(suiteRuntime, { bigint: true }), fileHash(runtime), fileHash(suiteRuntime),
  ]);
  if (bundledStat.dev !== linkedStat.dev || bundledStat.ino !== linkedStat.ino || bundledHash !== linkedHash)
    throw new Error('QA runtime hardlink is not the exact bundled Node inode and bytes.');
  const linkedInfo = await run(suiteRuntime, ['--input-type=module', '-e', 'console.log(JSON.stringify({execPath:process.execPath,version:process.version,arch:process.arch,platform:process.platform}))'], 'compact-hardlink.stdout.log', 'compact-hardlink.stderr.log', 30000);
  if (linkedInfo.exitCode !== 0) throw new Error('Bundled Node could not start through its QA hardlink.');
  const linkedIdentity = JSON.parse(linkedInfo.tail.trim());
  if (linkedIdentity.execPath !== suiteRuntime || /\s/.test(linkedIdentity.execPath) || linkedIdentity.version !== report.runtime.version || linkedIdentity.arch !== report.runtime.arch)
    throw new Error('QA runtime identity or whitespace-free process.execPath verification failed.');
  report.suiteRuntime = { ...linkedIdentity, hardlinkToBundledRuntime: true, bundledPath: runtime, device: String(linkedStat.dev), inode: String(linkedStat.ino), sha256: linkedHash,
    sameInodeVerified: true, sameSHA256Verified: true, executableCopied: false, executableResigned: false, stdoutLog: linkedInfo.stdoutLog, stderrLog: linkedInfo.stderrLog };
  const testFiles = (await readdir(path.join(work, 'tests'))).filter(name => name.endsWith('.test.mjs')).sort().map(name => path.join(work, 'tests', name));
  if (!testFiles.length) throw new Error('No existing tests found.');
  const tests = await run(suiteRuntime, ['--test', '--test-concurrency=2', '--test-reporter=tap', ...testFiles], 'compact-tests.tap.log', 'compact-tests.stderr.log');
  const summary = {};
  for (const [, name, value] of tests.tail.matchAll(/^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\s+([\d.]+)\s*$/gm)) summary[name] = Number(value);
  const { tail: _testTail, ...testRun } = tests;
  report.tests = { ...testRun, fileCount: testFiles.length, summary, hardlinkToBundledRuntime: true, codeSource: 'Candidate app Resources copied without rebuilding or source-code replacement; hardlinkToBundledRuntime uses the same verified Node inode and SHA256.' };
  const native = await run(path.join(resources, 'bin/HIDBridge'), ['--self-test'], 'compact-native.stdout.log', 'compact-native.stderr.log', 120000);
  const { tail: nativeTail, ...nativeRun } = native;
  report.nativeSelfTest = { ...nativeRun, summary: nativeTail.trim() };
  if (tests.exitCode !== 0 || tests.timedOut || !(summary.tests > 0) || summary.fail !== 0 || summary.cancelled !== 0)
    throw new Error('Candidate runtime/full existing test suite failed; inspect the complete TAP and stderr logs.');
  if (native.exitCode !== 0 || native.timedOut) throw new Error('Packaged HIDBridge offline self-test failed.');
  report.passed = true;
} catch (error) {
  report.error = { message: error.message, stack: error.stack };
  process.exitCode = 1;
} finally {
  if (work) {
    await rm(work, { recursive: true, force: true });
    report.temporaryMirrorRemoved = true;
  }
  if (linkDirectory) {
    await rm(linkDirectory, { recursive: true, force: true });
    report.temporaryRuntimeDirectoryRemoved = true;
  }
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    report.isolatedTemporaryDirectoryRemoved = true;
  }
  report.temporaryRuntimeHardlinkRemoved = true;
  report.completedAt = new Date().toISOString();
  await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ passed: report.passed, tests: report.tests?.summary, reportFile, error: report.error?.message }));
}
