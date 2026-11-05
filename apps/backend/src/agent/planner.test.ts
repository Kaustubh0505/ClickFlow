import { describe, expect, it, vi } from 'vitest';
import { makeObservation, makePlan } from '../../../../tests/fixtures.js';
import { parseConfig } from '../config.js';
import { ModelClient } from './model-client.js';
import { Planner } from './planner.js';
import { ModelError } from './errors.js';
import { initialPlanningPrompt, semanticUpdatePrompt, recoveryPrompt, completionPrompt } from './prompts.js';

const config = () => parseConfig({ MODEL_API_KEY: 'test-secret-not-real', MODEL_MAX_RETRIES: '0' });
const input = () => ({ originalRequest: makePlan().goal, observation: { ...makeObservation(), capturedAt: new Date().toISOString() }, constraints: [] });
const capabilities = () => ({ data: { id: config().MODEL_NAME, architecture: { input_modalities: ['text', 'image'] }, endpoints: [{ status: 0, supported_parameters: ['response_format', 'structured_outputs'] }] } });
const reply = (content: string | null, finish_reason = 'stop') => ({ choices: [{ finish_reason, message: { role: 'assistant', content } }] });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

describe('inference retry budget integration', () => {
  it('charges every additional inference attempt before dispatch', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(capabilities())).mockResolvedValueOnce(json({}, 503)).mockResolvedValueOnce(json(reply(JSON.stringify(makePlan()))));
    const reserve = vi.fn(async () => undefined);
    await new Planner(new ModelClient({ ...config(), MODEL_MAX_RETRIES: 1 }, fetcher)).generate(input(), undefined, reserve);
    expect(reserve).toHaveBeenCalledTimes(1); expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('does not send a retry when its model-call budget is exhausted', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(capabilities())).mockResolvedValueOnce(json({}, 503));
    const reserve = vi.fn(async () => { throw new ModelError('LIMIT_REACHED'); });
    await expect(new Planner(new ModelClient({ ...config(), MODEL_MAX_RETRIES: 1 }, fetcher)).generate(input(), undefined, reserve)).rejects.toMatchObject({ code: 'LIMIT_REACHED' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
function setup(output: unknown = makePlan()) {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(capabilities())).mockResolvedValueOnce(json(reply(typeof output === 'string' ? output : JSON.stringify(output))));
  return { fetcher, planner: new Planner(new ModelClient(config(), fetcher)) };
}

describe('complete initial planning', () => {
  it('rejects unstable semantic targets in optional final-state goal checks', async () => {
    const plan = makePlan(); plan.goalCriteria[0]!.verification = { type: 'element_visible', target: { strategy: 'semantic', description: 'A future result control' } };
    await expect(setup(plan).planner.generate(input())).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
  });
  it('uses real SDK wire format with exact model, full schema, bounded context and bearer authentication', async () => {
    const { planner, fetcher } = setup();
    const plan = await planner.generate(input());
    expect(plan).toEqual(makePlan());
    const call = fetcher.mock.calls[1]!;
    const request = new Request(call[0], call[1]);
    expect(request.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(request.headers.get('authorization')).toBe('Bearer test-secret-not-real');
    const body = await request.json();
    expect(body.model).toBe(config().MODEL_NAME);
    expect(body.provider).toEqual({ require_parameters: true });
    expect(body.response_format.type).toBe('json_schema');
    expect(body.messages[0].content).toContain('ENTIRE ordered plan');
    expect(body.messages[1].content[0].text).toContain('originalRequest');
    expect(body.messages[1].content[0].text).not.toContain('test-secret-not-real');
  });
  it.each(['not JSON', '```json\n{}\n```', '{}', 'null'])('rejects malformed or incomplete output: %s', async (output) => {
    await expect(setup(output).planner.generate(input())).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
  });
  it.each(['goal', 'cycle', 'execution', 'unsupported', 'selector', 'ref', 'logical', 'order'])('rejects invalid plan semantics: %s', async (kind) => {
    const plan = structuredClone(makePlan()) as unknown as Record<string, unknown>;
    const steps = plan.steps as Array<Record<string, unknown>>;
    const first = steps[0]!; const last = steps[1]!;
    if (kind === 'goal') plan.goal = 'Changed goal';
    if (kind === 'cycle') first.dependencies = [last.id];
    if (kind === 'execution') first.status = 'completed';
    if (kind === 'unsupported') first.action = { type: 'eval', code: 'alert(1)' };
    if (kind === 'selector') first.action = { type: 'click', target: { strategy: 'selector', selector: '#invented' } };
    if (kind === 'ref') first.action = { type: 'click', target: { strategy: 'element_ref', observationId: 'invented', ref: 'unknown' } };
    if (kind === 'logical') last.logicalStepId = first.logicalStepId;
    if (kind === 'order') plan.steps = [last, first];
    await expect(setup(plan).planner.generate(input())).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
  });
  it('accepts semantic future-page targets without fabricated selectors', async () => {
    const plan = makePlan(); plan.steps[0]!.action = { type: 'click', target: { strategy: 'semantic', description: 'Product details link on the future results page' }, timeoutMs: 1000 };
    expect((await setup(plan).planner.generate(input())).steps[0]?.action).toEqual(plan.steps[0]?.action);
  });
  it('sends a bound PNG as a transient image_url content part', async () => {
    const context = input();
    const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQ0AAAAASUVORK5CYII=';
    context.observation.screenshot = { status: 'captured', id: 'image-1', capturedAt: context.observation.capturedAt, width: 1, height: 1, mimeType: 'image/png', redacted: false };
    const { planner, fetcher } = setup();
    await planner.generate({ ...context, screenshot: { id: 'image-1', dataUrl } });
    const call = fetcher.mock.calls[1]!;
    const body = await new Request(call[0], call[1]).json();
    expect(body.messages[1].content[1]).toEqual({ type: 'image_url', image_url: { url: dataUrl } });
    expect(body.messages[1].content[0].text).not.toContain(dataUrl);
  });
  it.each(['remote', 'oversize', 'mismatch', 'missing', 'bad-header'])('rejects invalid image transport: %s', async (kind) => {
    const context = input();
    context.observation.screenshot = { status: 'captured', id: 'image-1', capturedAt: context.observation.capturedAt, width: 1, height: 1, mimeType: 'image/png', redacted: false };
    const screenshot = kind === 'missing' ? undefined : { id: kind === 'mismatch' ? 'other' : 'image-1', dataUrl: kind === 'remote' ? 'https://example.com/image.png' : kind === 'oversize' ? 'data:image/png;base64,' + 'A'.repeat(2_000_000) : 'data:image/png;base64,YmFk' };
    const { planner, fetcher } = setup();
    await expect(planner.generate({ ...context, ...(screenshot ? { screenshot } : {}) })).rejects.toMatchObject({ code: 'INVALID_CONTEXT' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects stale observations before sending data', async () => {
    const { planner, fetcher } = setup(); const context = input(); context.observation.capturedAt = '2020-01-01T00:00:00Z';
    await expect(planner.generate(context)).rejects.toMatchObject({ code: 'INVALID_CONTEXT' }); expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not accept a late response after cancellation', async () => {
    const abort = new AbortController();
    const planner = new Planner({ initialPlan: async () => { abort.abort(); return JSON.stringify(makePlan()); } });
    await expect(planner.generate(input(), abort.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
  });
  it('keeps safety and distinct operation instructions in all templates', () => {
    for (const prompt of [initialPlanningPrompt, semanticUpdatePrompt, recoveryPrompt, completionPrompt]) expect(prompt).toContain('UNTRUSTED DATA');
    expect(recoveryPrompt).toContain('uncertain dispatch'); expect(completionPrompt).toContain('every ORIGINAL goal criterion');
  });
});

describe('model failures and capabilities', () => {
  it.each([401, 402, 403, 404, 429, 500])('normalizes provider status %i without leaking bodies', async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ error: { message: 'test-secret-not-real: private provider details' } }, status));
    await expect(new Planner(new ModelClient(config(), fetcher)).generate(input())).rejects.toMatchObject({ code: [401,402,403].includes(status) ? 'AUTH_FAILED' : status === 429 ? 'RATE_LIMITED' : status === 500 ? 'PROVIDER_UNAVAILABLE' : 'INVALID_REQUEST' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('refuses missing credentials without a network request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(new Planner(new ModelClient(parseConfig({}), fetcher)).generate(input())).rejects.toMatchObject({ code: 'NOT_CONFIGURED' }); expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['image', 'structured_outputs', 'id'])('fails closed when capability %s is missing', async (kind) => {
    const data = capabilities();
    if (kind === 'image') data.data.architecture.input_modalities = ['text'];
    if (kind === 'structured_outputs') data.data.endpoints[0]!.supported_parameters = ['response_format'];
    if (kind === 'id') data.data.id = 'some-other-model';
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(data));
    await expect(new Planner(new ModelClient(config(), fetcher)).generate(input())).rejects.toMatchObject({ code: 'UNSUPPORTED_MODEL' }); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('retries transient failures within the configured budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({}, 503)).mockResolvedValueOnce(json(capabilities())).mockResolvedValueOnce(json(reply(JSON.stringify(makePlan()))));
    const settings = { ...config(), MODEL_MAX_RETRIES: 1 };
    await expect(new Planner(new ModelClient(settings, fetcher)).generate(input())).resolves.toEqual(makePlan()); expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('stops after its retry budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({}, 503));
    await expect(new Planner(new ModelClient({ ...config(), MODEL_MAX_RETRIES: 1 }, fetcher)).generate(input())).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' }); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([null, '', '  '])('rejects empty model content', async (content) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(capabilities())).mockResolvedValueOnce(json(reply(content)));
    await expect(new Planner(new ModelClient(config(), fetcher)).generate(input())).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
  });
  it('rejects a malformed provider response envelope', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(capabilities())).mockResolvedValueOnce(json({ unexpected: 'value' }));
    await expect(new Planner(new ModelClient(config(), fetcher)).generate(input())).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
  });
  it('rejects truncated JSON even when it parses', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(capabilities())).mockResolvedValueOnce(json(reply(JSON.stringify(makePlan()), 'length')));
    await expect(new Planner(new ModelClient(config(), fetcher)).generate(input())).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
  });
  it('cancels during retry backoff before another request', async () => {
    const abort = new AbortController(); const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({}, 503));
    const request = new Planner(new ModelClient({ ...config(), MODEL_MAX_RETRIES: 2 }, fetcher)).generate(input(), abort.signal);
    setTimeout(() => abort.abort(), 30);
    await expect(request).rejects.toMatchObject({ code: 'CANCELLED' }); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('bounds a hanging SDK call with the overall deadline', async () => {
    const fetcher: typeof fetch = async (request, init) => new Promise((_resolve, reject) => {
      const signal = new Request(request, init).signal;
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    await expect(new Planner(new ModelClient({ ...config(), MODEL_TIMEOUT_MS: 1000 }, fetcher)).generate(input())).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
});
