// Native hosts can disappear without sending SIGTERM. Never let their worker
// keep a USB handle, held shortcut or RGB session alive after that happens.
export function watchNativeParent({parentPid, getParentPid = () => process.ppid,
  streams = [process.stdout, process.stderr], onLost, intervalMs = 250}) {
  if (parentPid === undefined) return () => {};
  const expected = /^\d+$/.test(String(parentPid)) ? Number(parentPid) : 0;
  let lost = false;
  const notify = () => { if (!lost) { lost = true; onLost(); } };
  const check = () => { if (!Number.isSafeInteger(expected) || expected <= 1 || getParentPid() !== expected) notify(); };
  // A closed host log pipe must not throw an unhandled EPIPE while cleanup is
  // restoring the keyboard. Keep these listeners installed until process exit.
  const brokenPipe = () => notify();
  for (const stream of streams) stream.on('error', brokenPipe);
  const timer = setInterval(check, intervalMs);
  timer.unref?.();
  queueMicrotask(check);
  return () => { clearInterval(timer); for (const stream of streams) stream.off('error', brokenPipe); };
}
