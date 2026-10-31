import {CodexLights,resolveWholeTask} from './codex-lighting.mjs';
import {ClaudeLights,resolveClaudeWholeTask} from './claude-lighting.mjs';

const object = value => value && typeof value === 'object' ? value : {};
const emptyColors = () => Array(84).fill('#000000');

// Presentation facts are separate from whether task lights currently own USB.
// In particular, a different AI source or scene must not be labelled as this AI.
export function resolveAgentLightingView(source, state, {serviceUnknown = false} = {}) {
  const settings = object(state?.settings), integration = object(state?.[source]);
  const tasks = Array.isArray(integration.tasks) ? integration.tasks : [];
  const slots = (Array.isArray(integration.slots) ? integration.slots : []).map(task => task && typeof task === 'object' ? task : null);
  const lighting = object(integration.lighting), selectedId = typeof lighting.selectedId === 'string' ? lighting.selectedId : '';
  const selectedTask = tasks.find(task => task.id === selectedId) ?? null;
  const ambientTask = slots.find(task => task?.id === selectedId) ?? null;
  const whole = settings[`${source}LightMode`] === 'whole';
  const wholeTask = (source === 'claude' ? resolveClaudeWholeTask : resolveWholeTask)(tasks, settings, selectedId);
  const activeSource = settings.agentSource === 'claude' ? 'claude' : 'codex';
  const enabled = settings[`${source}Enabled`] === true;
  const connected = state?.device?.connected === true;
  const capable = state?.device?.capabilities?.perKey !== false && state?.device?.readOnly !== true && state?.firmware?.compatible !== false;
  const ready = integration.available === true && object(integration.taskSource).available !== false;
  const owner = object(lighting.outputOwner);
  const currentSession = state?.device?.connectionSessionId;
  const pausedReason = typeof lighting.pausedReason === 'string' ? lighting.pausedReason : null;
  const ownsOutput = !serviceUnknown && connected && capable && enabled && activeSource === source && state?.device?.armed === true
    && lighting.ownsOutput === true && owner.source === source && typeof currentSession === 'string'
    && owner.connectionSessionId === currentSession && owner.mode === (whole ? 'whole' : 'keys')
    && Number.isFinite(owner.frameCommittedAt) && pausedReason === null && !['game','trigger'].includes(state?.playback?.mode);
  // Global sleep controls ordinary artwork. A committed AI overlay stays on
  // until its mode is disabled; never turn its preview black from that timer.
  const sleeping = ownsOutput ? false : lighting.sleeping === true;
  const backgroundSleeping = lighting.backgroundSleeping === true || state?.lightPower?.sleeping === true;
  const showing = ownsOutput;
  const pulseTask = whole ? wholeTask : ambientTask;
  const animated = Boolean(pulseTask && pulseTask.id === selectedId && settings[`${source}SelectedPulse`] !== false)
    || Boolean(!whole && settings[`${source}Ambient`] === true && ambientTask?.status === 'running');
  const blockedReason = serviceUnknown || !state ? 'serviceUnknown' : !connected ? 'disconnected' : !capable ? 'unsupported' : !ready ? 'integrationUnavailable' : '';
  return {tasks,slots,settings,selectedId,selectedTask,ambientTask,wholeTask,whole,activeSource,enabled,connected,capable,ready,sleeping,backgroundSleeping,pausedReason,ownsOutput,showing,animated,blockedReason};
}

// Preserve the selected palette on screen. Global output dimming is for LEDs;
// applying it to monitor RGB makes a valid blue look nearly black. Explicit
// zero remains dark. Status, bindings, source brightness and pulses still use
// the same renderer; elapsed never chooses a task.
export function renderAgentLightingPreview(source, slots, settings, tasks, selectedId = '', elapsed = 0) {
  let clock = 0;
  const lights = new (source === 'claude' ? ClaudeLights : CodexLights)(() => clock);
  if (selectedId) lights.select(selectedId);
  clock = Math.max(0, Number.isFinite(elapsed) ? elapsed : 0);
  const colors = lights.render(emptyColors(), slots, settings, tasks);
  return Number(settings.brightness ?? 100) === 0 ? emptyColors() : colors;
}
