// A settings return can arrive through both the native host and web focus.
// Share the same read-only refresh rather than running those requests together.
const pendingRefreshes = new WeakMap();
export function coalescePermissionRefresh(owner, refresh) {
  const pending = pendingRefreshes.get(owner);
  if (pending) return pending;
  const next = Promise.resolve().then(refresh);
  pendingRefreshes.set(owner, next);
  const clear = () => { if (pendingRefreshes.get(owner) === next) pendingRefreshes.delete(owner); };
  next.then(clear, clear);
  return next;
}

// Carry the native reply into the same server operation that reads the helper.
// Waiting for WKScriptMessage completion alone did not wait for the host's
// separate HTTP POST, so the returned state could still contain its old grant.
export function refreshPermissionSession(command, readNative) {
  return coalescePermissionRefresh(command, async () => {
    const reply = await readNative();
    return command({op:'refreshPermissions', ...(reply.available ? {hostPermissions:reply.result} : {})});
  });
}

// Only used while permission setup is incomplete. It never requests trust,
// opens settings, changes a keyboard, or restarts an application.
export function watchPermissionRefresh({ refresh, isVisible, windowTarget, documentTarget,
  interval = 2000, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let stopped = false, pending = false, timer;
  const cancelTimer = () => { if (timer !== undefined) clearTimer(timer); timer = undefined; };
  const schedule = () => {
    if (!stopped) timer = setTimer(() => { timer = undefined; void check(); }, interval);
  };
  const check = async () => {
    if (stopped || pending) return;
    cancelTimer();
    if (!isVisible()) { schedule(); return; }
    pending = true;
    try { await refresh(); } catch { /* Retry quietly while setup is visible. */ }
    finally { pending = false; schedule(); }
  };
  const wake = () => { if (isVisible()) void check(); };
  windowTarget.addEventListener('focus', wake);
  documentTarget.addEventListener('visibilitychange', wake);
  void check();
  return () => {
    stopped = true; cancelTimer();
    windowTarget.removeEventListener('focus', wake);
    documentTarget.removeEventListener('visibilitychange', wake);
  };
}
