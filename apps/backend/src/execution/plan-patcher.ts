import { planPatchSchema, planSchema, targetSchema, type TaskState, type Action, type Observation } from '@clickflow/shared';

export class PatchError extends Error {
  readonly code = 'INVALID_PATCH';
}
function check(value: unknown, message: string): asserts value { if (!value) throw new PatchError(message); }

function normalize(value: unknown, observation: Observation): unknown {
  if (Array.isArray(value)) return value.map((entry) => normalize(entry, observation));
  if (!value || typeof value !== 'object') return value;
  if ('strategy' in value) {
    const target = targetSchema.parse(value);
    check(target.strategy !== 'selector', 'Recovery cannot invent selectors.');
    if (target.strategy === 'element_ref') {
      const element = observation.elements.find((entry) => target.observationId === observation.id && entry.ref === target.ref && entry.visible && entry.enabled);
      check(element && element.name, 'A reference must belong to the fresh observation.');
      return targetSchema.parse({ strategy: 'role', role: element.role, name: element.name, exact: true });
    }
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, normalize(child, observation)]));
}
function fingerprint(action: Action, observation: Observation) {
  const { timeoutMs: _timeout, ...rest } = action; void _timeout;
  if (!('target' in rest)) return JSON.stringify(rest);
  const target = rest.target;
  const matches = observation.elements.filter((element) => target.strategy === 'role' ? element.role === target.role && element.name === target.name : target.strategy === 'label' ? (element.label ?? element.name) === target.label : target.strategy === 'text' ? element.name === target.text : false);
  return JSON.stringify({ ...rest, target: matches.length === 1 ? { ref: matches[0]!.ref } : target });
}

export function applyRecoveryPatch(task: TaskState, raw: unknown) {
  const parsed = planPatchSchema.safeParse(raw);
  check(parsed.success && task.plan && task.currentContext && !task.pendingAction, 'A valid patch and resolved dispatch checkpoint are required.');
  const patch = planPatchSchema.parse(normalize(parsed.data, task.currentContext));
  const plan = task.plan;
  check(patch.basePlanVersion === plan.version, 'The patch targets a stale plan version.');
  const evidence = new Set(task.verificationResults.flatMap((result) => result.status === 'passed' ? result.evidence.map((entry) => entry.id) : []));
  check(patch.evidenceIds.every((id) => evidence.has(id)), 'Recovery cannot fabricate evidence.');
  const known = new Map(plan.steps.map((step) => [step.id, step]));
  const rank = { low: 0, medium: 1, high: 2 };
  const idempotent = new Set(['observe', 'wait', 'type', 'clear_input', 'select_option', 'extract_text']);
  const invalid = (step: typeof plan.steps[number]) => {
    if (['failed', 'blocked'].includes(step.status)) return true;
    if (step.status !== 'pending' || !('target' in step.action)) return false;
    const target = step.action.target;
    if (target.strategy === 'semantic' || target.strategy === 'element_ref') return true;
    return !task.currentContext!.elements.some((element) => target.strategy === 'role' ? element.role === target.role && element.name === target.name : target.strategy === 'label' ? (element.label ?? element.name) === target.label : target.strategy === 'text' ? element.name === target.text || task.currentContext!.visibleText.includes(target.text) : false);
  };
  const validate = (step: typeof plan.steps[number]) => {
    check(['pending', 'blocked'].includes(step.status) && step.evidenceIds.length === 0, 'Changed steps cannot claim execution or evidence.');
    if ('target' in step.action && step.action.target.strategy === 'semantic') check(step.status === 'blocked', 'Unresolved semantic targets must remain blocked.');
    check((task.retryCounts[step.logicalStepId] ?? 0) < task.limits.maxAttemptsPerStep, 'Logical step attempt budget is exhausted.');
    const last = task.actionHistory.filter((entry) => known.get(entry.authorization.stepId)?.logicalStepId === step.logicalStepId).at(-1);
    check(last?.dispatchStatus !== 'uncertain', 'Uncertain dispatch requires reconciliation.');
    if (last?.dispatchStatus === 'dispatched' && last.verification?.status !== 'passed' && !idempotent.has(step.action.type)) check(fingerprint(last.authorization.action, task.currentContext!) !== fingerprint(step.action, task.currentContext!), 'An unverified non-idempotent action cannot be repeated blindly.');
    if (!idempotent.has(step.action.type)) check(!task.actionHistory.some((entry) => entry.dispatchStatus === 'dispatched' && entry.verification?.status !== 'passed' && fingerprint(entry.authorization.action, task.currentContext!) === fingerprint(step.action, task.currentContext!)), 'Changing step IDs cannot reset an uncertain side-effect budget.');
  };
  for (const step of patch.modifiedSteps) {
    const old = known.get(step.id);
    check(old && !['completed', 'skipped', 'in_progress'].includes(old.status), 'Resolved steps are immutable.');
    check(step.logicalStepId === old.logicalStepId && rank[step.risk] >= rank[old.risk], 'Existing logical IDs and risk cannot be downgraded.');
    check(invalid(old) || (old.action.type === 'finish' && JSON.stringify({ ...old, dependencies: [] }) === JSON.stringify({ ...step, dependencies: [] })), 'Valid pending work must be preserved.');
    validate(step);
  }
  for (const { step } of patch.insertedSteps) {
    check(!known.has(step.id), 'New work requires a new stable ID.');
    check(plan.steps.some((old) => old.logicalStepId === step.logicalStepId && invalid(old) && rank[step.risk] >= rank[old.risk]), 'Inserted work must inherit an invalid existing logical budget and risk.');
    validate(step);
  }
  for (const update of patch.stepUpdates) check(known.has(update.stepId) && invalid(known.get(update.stepId)!), 'Valid or resolved work cannot be rewritten.');
  let steps = plan.steps.map((step) => patch.modifiedSteps.find((entry) => entry.id === step.id) ?? step);
  for (const entry of patch.insertedSteps) {
    const position = entry.afterStepId === null ? 0 : steps.findIndex((step) => step.id === entry.afterStepId) + 1;
    check(entry.afterStepId === null || position > 0, 'Insertion anchor does not exist.'); steps.splice(position, 0, entry.step);
  }
  steps = steps.map((step) => { const update = patch.stepUpdates.find((entry) => entry.stepId === step.id); return update ? { ...step, status: update.status } : step; });
  const candidate = planSchema.safeParse({ ...plan, version: plan.version + 1, currentStepId: null, steps });
  check(candidate.success, 'Invalid dependency or finish structure.');
  const earlier = new Set<string>();
  for (const step of candidate.data.steps) { check(step.dependencies.every((id) => earlier.has(id)), 'Dependencies must precede their steps.'); earlier.add(step.id); }
  return { plan: candidate.data, patch };
}
