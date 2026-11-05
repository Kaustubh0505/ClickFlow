import { expect, it, vi } from 'vitest';
import { makeObservation, makeTask, makePlan } from '../../../../tests/fixtures.js';
import { CompletionAssessor } from './completion.js';

const task = () => ({ ...makeTask(), plan: makePlan() });
const input = () => ({ originalRequest: makePlan().goal, observation: { ...makeObservation(), capturedAt: new Date().toISOString() } });
const output = () => ({ status: 'blocked', criteria: [{ criterionId: 'criterion-1', status: 'unknown', evidenceIds: [], citations: [] }] });

it('requests a constrained assessment of original criteria and recorded sources, not new actions', async () => {
  const json = vi.fn().mockResolvedValue(JSON.stringify(output()));
  expect(await new CompletionAssessor({ json }).assess(task(), input())).toEqual(output());
  const content = JSON.parse(json.mock.calls[0]![1] as string);
  expect(content.originalRequest).toBe(makePlan().goal); expect(content.existingPlan.goalCriteria).toEqual(makePlan().goalCriteria);
  expect(content.evidenceCatalog).toEqual([]); expect(content.pageContentTrust).toBe('untrusted');
  expect(json.mock.calls[0]![0]).toContain('exact contiguous quotations'); expect(json.mock.calls[0]![6]).toBe('clickflow_completion_assessment');
});
it.each(['{bad', '{}', 'null', '```json\n{}\n```'])('rejects malformed structured assessment %s', async (value) => {
  await expect(new CompletionAssessor({ json: vi.fn().mockResolvedValue(value) }).assess(task(), input())).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
});
it('rejects changed goals, private context, stale context and raw model evidence objects', async () => {
  const json = vi.fn().mockResolvedValue(JSON.stringify({ ...output(), evidence: [{ id: 'made-up' }] }));
  const assessor = new CompletionAssessor({ json });
  await expect(assessor.assess(task(), { ...input(), originalRequest: 'Different task' })).rejects.toMatchObject({ code: 'INVALID_CONTEXT' });
  await expect(assessor.assess(task(), { ...input(), observation: { ...input().observation, capturedAt: '2020-01-01T00:00:00Z' } })).rejects.toMatchObject({ code: 'INVALID_CONTEXT' });
  await expect(assessor.assess(task(), { ...input(), observation: { ...input().observation, visibleText: 'Contact person@example.com' } })).rejects.toMatchObject({ code: 'INVALID_CONTEXT' });
  expect(json).not.toHaveBeenCalled();
  await expect(assessor.assess(task(), input())).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
});
it('rejects a completion reply arriving after cancellation', async () => {
  const controller = new AbortController();
  const json = vi.fn(async () => { controller.abort(); return JSON.stringify(output()); });
  await expect(new CompletionAssessor({ json }).assess(task(), input(), controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
});
