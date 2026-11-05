import { initialPlanSchema, observationSchema, taskStateSchema } from '@clickflow/shared';
import taskFixture from './fixtures/task.json' with { type: 'json' };

export const target = { strategy: 'role' as const, role: 'searchbox' as const, name: 'Search', exact: true };
export const capturedAt = '2026-10-28T12:00:00.000Z';

export function makeTask() {
  return taskStateSchema.parse(structuredClone(taskFixture));
}

export function makePlan() {
  return initialPlanSchema.parse({
    goal: taskFixture.originalRequest,
    version: 1,
    currentStepId: null,
    goalCriteria: [{ id: 'criterion-1', description: 'The search field is focused' }],
    steps: [
      { id: 'step-1', logicalStepId: 'step-1', description: 'Focus the search field', action: { type: 'click', target }, preconditions: [], expectedResult: 'Search field is focused', verification: { type: 'element_focused', target }, dependencies: [], risk: 'low', status: 'pending', evidenceIds: [] },
      { id: 'step-2', logicalStepId: 'step-2', description: 'Assess goal completion', action: { type: 'finish' }, preconditions: [], expectedResult: 'Goal is supported by evidence', verification: { type: 'semantic_assessment_required', criterion: 'Search field is focused' }, dependencies: ['step-1'], risk: 'low', status: 'pending', evidenceIds: [] },
    ],
  });
}

export function makeObservation() {
  return observationSchema.parse({
    id: 'observation-1', capturedAt, tabId: 1, windowId: 1, frameId: 0, documentId: 'document-1', revision: 1,
    url: 'http://localhost:4173/fixture', title: 'Local test fixture',
    viewport: { width: 1280, height: 720, devicePixelRatio: 1, zoom: 1 }, scroll: { x: 0, y: 0 },
    visibleText: 'Search', elements: [], loading: 'complete', truncated: false,
    screenshot: { status: 'omitted', reason: 'DOM evidence is sufficient' },
  });
}

export const evidence = {
  id: 'evidence-1', observationId: 'observation-1', capturedAt,
  sourceUrl: 'http://localhost:4173/fixture', kind: 'dom' as const, summary: 'Search input is the active element',
};
