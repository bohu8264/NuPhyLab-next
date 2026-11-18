// A batch is work observed since monitoring began, not the six visible slots or
// historical unread badges. Only explicit successful terminal events can green.
export class AgentCohort {
  constructor({now = Date.now, freshMs = 5000, settleMs = 750} = {}) {
    Object.assign(this, {now, freshMs, settleMs}); this.reset();
  }
  reset() {
    this.members = new Map(); this.seen = new Map(); this.startedAt = this.now();
    this.lastSnapshotAt = null; this.complete = false; this.settledAt = null;
  }
  observe({tasks = [], complete = false, observedAt = this.now()} = {}) {
    if (!Number.isFinite(observedAt) || observedAt > this.now() + 1000 ||
        this.lastSnapshotAt !== null && observedAt <= this.lastSnapshotAt) return this.snapshot();
    const initial = this.lastSnapshotAt === null;
    const valid = Array.isArray(tasks) && tasks.length <= 4096 && tasks.every(t => typeof t?.id === 'string' && t.id &&
      typeof t.signature === 'string' && Number.isFinite(t.eventAt) && t.eventAt <= observedAt + 1000);
    const unique = valid && new Set(tasks.map(t => t.id)).size === tasks.length;
    this.complete = complete === true && unique;
    this.lastSnapshotAt = observedAt;
    const visible = new Set();
    // Decide the next batch once, before iterating. Row order cannot revive the
    // previous batch or clear a newly observed task from the same snapshot. A
    // short job can start and finish between polls, so terminal evidence also
    // starts a new batch and a fresh stabilization window.
    if (valid && unique && this.members.size && [...this.members.values()].every(t =>
      ['succeeded','cancelled','error'].includes(t.status)) && tasks.some(t =>
        !initial && this.seen.get(t.id)?.signature !== t.signature &&
        t.eventAt > (this.seen.get(t.id)?.eventAt ?? this.startedAt))) {
      this.members.clear(); this.settledAt = null;
    }
    if (valid && unique) for (const task of tasks) {
      visible.add(task.id);
      const previous = this.seen.get(task.id), member = this.members.get(task.id);
      // A late/replayed event must not resurrect an earlier success after retry.
      if (previous && task.eventAt < previous.eventAt) { this.complete = false; continue; }
      const changed = previous?.signature !== task.signature;
      const active = ['running','queued','waiting'].includes(task.status);
      const newlyObserved = changed && (initial ? task.eventAt > this.startedAt : task.eventAt >= this.startedAt);
      if (member || active || newlyObserved) {
        const status = task.status === 'succeeded' && task.explicitSuccess !== true ? 'unknown' : task.status;
        this.members.set(task.id, {...task, status});
      }
      this.seen.set(task.id, {...task});
    }
    for (const id of this.seen.keys()) if (!visible.has(id) && !this.members.has(id)) this.seen.delete(id);
    if (this.members.size > 4096) { this.members.clear(); this.seen.clear(); this.complete = false; }
    for (const [id, task] of this.members) if (!visible.has(id)) this.members.set(id, {...task, status:'unknown'});
    const allSucceeded = this.complete && this.members.size > 0 && [...this.members.values()].every(t => t.status === 'succeeded');
    if (!allSucceeded) this.settledAt = null;
    else this.settledAt ??= observedAt;
    return this.snapshot();
  }
  snapshot() {
    const now = this.now(), fresh = this.lastSnapshotAt !== null && now >= this.lastSnapshotAt && now - this.lastSnapshotAt <= this.freshMs;
    const values = [...this.members.values()];
    let status = 'idle';
    if (!fresh) status = 'unknown';
    else if (values.some(t => t.status === 'error')) status = 'error';
    else if (values.some(t => t.status === 'waiting')) status = 'waiting';
    else if (values.some(t => ['running','queued'].includes(t.status))) status = 'running';
    else if (!this.complete || values.some(t => !['succeeded'].includes(t.status))) status = 'unknown';
    else if (values.length) status = this.settledAt !== null && this.lastSnapshotAt - this.settledAt >= this.settleMs ? 'completed' : 'running';
    return {status, count:values.length, complete:this.complete, fresh, observedAt:this.lastSnapshotAt,
      succeeded:values.filter(t => t.status === 'succeeded').length};
  }
}

export const AGENT_COHORT_COLORS = Object.freeze({running:'#3976da',waiting:'#d6ac60',completed:'#6f9e85',idle:'#ffffff',error:'#c86d6d'});
export const agentLightZone = (settings, source, modelId = 'air75-v3') => modelId === 'air75-v3' && settings?.[`${source}LightZone`] === 'side' ? 'side' : 'backlight';
export function enabledAgentBindings(settings, source, bindings, modelId = 'air75-v3') {
  return bindings.filter(binding => binding.index < 6 ? agentLightZone(settings, source, modelId) === 'backlight'
    : settings?.[`${source}CommandKeysEnabled`] !== false);
}
