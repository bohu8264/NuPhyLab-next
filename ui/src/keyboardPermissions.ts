type PermissionState = 'ready' | 'allowed' | 'unknown' | 'denied';

export function keyboardPermissions(native?: Record<string, unknown>, runtime = native) {
  const system = native?.systemPermissions ?? native?.host ?? runtime;
  const granted = system && typeof system === 'object' ? system as Record<string, unknown> : {};
  const inputReady = runtime?.inputMonitoring === true;
  const accessReady = runtime?.accessibility === true && runtime?.canPostEvents === true;
  const input: PermissionState = inputReady ? 'ready' : granted.inputMonitoring === true ? 'allowed' :
    typeof runtime?.inputMonitoring === 'boolean' ? 'denied' : 'unknown';
  const access: PermissionState = accessReady ? 'ready' : granted.accessibility === true ? 'allowed' :
    typeof runtime?.accessibility === 'boolean' && typeof runtime?.canPostEvents === 'boolean' ? 'denied' : 'unknown';
  const waiting = input === 'allowed' || access === 'allowed';
  const applying = native?.permissionRecoveryPending === true;
  const needsReopen = waiting && !applying && input !== 'denied' && input !== 'unknown' &&
    access !== 'denied' && access !== 'unknown';
  return {input, access, inputReady, accessReady, applying, needsReopen};
}
