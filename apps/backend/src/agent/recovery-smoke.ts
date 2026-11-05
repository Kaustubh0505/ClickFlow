import { DEFAULT_LIMITS, taskStateSchema } from '@clickflow/shared';
import { loadConfig } from '../config.js';
import { ModelClient } from './model-client.js';
import { RecoveryPlanner } from './recovery.js';
import { ModelError } from './errors.js';
import { applyRecoveryPatch, PatchError } from '../execution/plan-patcher.js';

const config = loadConfig();
if (process.env.RUN_LIVE_MODEL !== '1' || !config.MODEL_API_KEY) {
  console.log('SKIPPED: set RUN_LIVE_MODEL=1 and backend MODEL_API_KEY for a synthetic non-sensitive recovery test.');
} else {
  const at = new Date().toISOString();
  const target = { strategy: 'role', role: 'searchbox', name: 'Search', exact: true };
  const observation = { id: 'recovery-observation', capturedAt: at, tabId: 0, windowId: 0, frameId: 0, documentId: 'synthetic-document', revision: 1,
    url: 'http://127.0.0.1:5173/fixtures/browser.html', title: 'Synthetic recovery fixture', viewport: { width: 1280, height: 720, devicePixelRatio: 1, zoom: 1 }, scroll: { x: 0, y: 0 }, visibleText: 'Search',
    elements: [{ ref: 'search', role: 'searchbox', name: 'Search', tagName: 'input', inputType: 'search', visible: true, enabled: true, bounds: { x: 10, y: 10, width: 200, height: 32 } }], loading: 'complete', truncated: false, screenshot: { status: 'omitted', reason: 'Synthetic non-sensitive DOM-only test.' } };
  const common = { preconditions: [], evidenceIds: [], risk: 'low', expectedResult: 'Search is focused', dependencies: [], verification: { type: 'element_focused', target } };
  const task = taskStateSchema.parse({ schemaVersion: 1, id: 'synthetic-recovery', revision: 0, originalRequest: 'Focus the Search field', status: 'paused', initialContext: observation, currentContext: observation,
    plan: { goal: 'Focus the Search field', version: 1, currentStepId: null, goalCriteria: [{ id: 'focus', description: 'Search is focused' }], steps: [
      { ...common, id: 'search-step', logicalStepId: 'search-step', description: 'Focus Search', status: 'failed', action: { type: 'click', target: { ...target, name: 'Old Search' } } },
      { ...common, id: 'finish-step', logicalStepId: 'finish-step', description: 'Assess completion', status: 'pending', action: { type: 'finish' }, dependencies: ['search-step'], verification: { type: 'semantic_assessment_required', criterion: 'Search is focused' } },
    ] }, actionHistory: [], verificationResults: [], recoveryHistory: [], errors: [{ at, code: 'TARGET_NOT_FOUND', message: 'Old Search is absent; Search is now the visible accessible name.' }], retryCounts: { 'search-step': 1 }, limits: DEFAULT_LIMITS, cancellationRequested: false, createdAt: at, updatedAt: at, result: null });
  try {
    const patch = await new RecoveryPlanner(new ModelClient(config)).update(task, { originalRequest: task.originalRequest, observation });
    const result = applyRecoveryPatch(task, patch);
    if (!result.plan.steps.some((step) => step.id === 'search-step' && step.status === 'pending')) throw new PatchError('The smoke test requires an actionable update to the existing failed step.');
    console.log(`PASS: live recovery produced a validated patch for plan v${result.plan.version}; original IDs and attempt lineage retained. No browser action was executed.`);
  } catch (error) {
    const safe = error instanceof ModelError || error instanceof PatchError ? error : new ModelError('INVALID_OUTPUT');
    console.error(`${safe.code}: ${safe.message}`); process.exitCode = 1;
  }
}
