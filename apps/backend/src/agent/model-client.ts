import OpenAI from 'openai';
import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import type { BackendConfig } from '../config.js';
import { ModelError } from './errors.js';

const capabilitySchema = z.object({ data: z.object({
  id: z.string(), architecture: z.object({ input_modalities: z.array(z.string()) }),
  endpoints: z.array(z.object({ supported_parameters: z.array(z.string()), status: z.number().optional() })),
}) });
const completionSchema = z.object({ choices: z.array(z.object({
  finish_reason: z.literal('stop'), message: z.object({ content: z.string().trim().min(1).max(500_000), refusal: z.null().optional() }),
})).min(1) });
export type ModelConfig = Pick<BackendConfig, 'MODEL_API_KEY' | 'MODEL_BASE_URL' | 'MODEL_NAME' | 'MODEL_TIMEOUT_MS' | 'MODEL_MAX_RETRIES'>;

/** SDK retries are disabled so the outer deadline and bounded retry policy own every attempt. */
export class ModelClient {
  private readonly sdk: OpenAI;
  constructor(private readonly config: ModelConfig, fetcher?: typeof fetch) {
    this.sdk = new OpenAI({ apiKey: config.MODEL_API_KEY || 'not-configured', baseURL: config.MODEL_BASE_URL,
      maxRetries: 0, timeout: config.MODEL_TIMEOUT_MS, ...(fetcher ? { fetch: fetcher } : {}) });
  }
  async initialPlan(system: string, user: string, schema: Record<string, unknown>, image: string | undefined, signal?: AbortSignal, onRetry?: () => Promise<void>): Promise<string> {
    return this.json(system, user, schema, image, signal, onRetry);
  }
  async json(system: string, user: string, schema: Record<string, unknown>, image: string | undefined, signal?: AbortSignal, onRetry?: () => Promise<void>, schemaName = 'clickflow_initial_plan'): Promise<string> {
    if (!this.config.MODEL_API_KEY) throw new ModelError('NOT_CONFIGURED');
    const deadline = AbortSignal.timeout(this.config.MODEL_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      // Refresh each planning call: endpoint support and availability can change.
      const path = `/models/${this.config.MODEL_NAME.split('/').map(encodeURIComponent).join('/')}/endpoints`;
      const raw = await this.retry(() => this.sdk.get<unknown>(path, { signal: combined }), combined);
      const parsed = capabilitySchema.safeParse(raw);
      if (!parsed.success || parsed.data.data.id !== this.config.MODEL_NAME || !parsed.data.data.architecture.input_modalities.includes('image') || !parsed.data.data.endpoints.some((endpoint) => (endpoint.status === undefined || endpoint.status === 0) && endpoint.supported_parameters.includes('response_format') && endpoint.supported_parameters.includes('structured_outputs'))) throw new ModelError('UNSUPPORTED_MODEL');
      let first = true;
      const result = await this.retry(async () => {
        if (!first) await onRetry?.(); first = false;
        return this.sdk.chat.completions.create({
        model: this.config.MODEL_NAME,
        messages: [{ role: 'system', content: system }, { role: 'user', content: [
          { type: 'text', text: user }, ...(image ? [{ type: 'image_url' as const, image_url: { url: image } }] : []),
        ] }],
        response_format: { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } },
        max_tokens: 12_000,
        // OpenRouter extension; never route a request to an endpoint that ignores JSON requirements.
        ...{ provider: { require_parameters: true } },
      }, { signal: combined }); }, combined);
      combined.throwIfAborted();
      const completion = completionSchema.safeParse(result);
      if (!completion.success) throw new ModelError('INVALID_OUTPUT');
      return completion.data.choices[0]!.message.content;
    } catch (error) {
      if (signal?.aborted) throw new ModelError('CANCELLED');
      if (deadline.aborted || error instanceof OpenAI.APIConnectionTimeoutError) throw new ModelError('TIMEOUT');
      if (error instanceof ModelError) throw error;
      if (error instanceof OpenAI.APIError) {
        if (error.status === 401 || error.status === 402 || error.status === 403) throw new ModelError('AUTH_FAILED');
        if (error.status === 429) throw new ModelError('RATE_LIMITED');
        if (error.status && error.status < 500) throw new ModelError('INVALID_REQUEST');
      }
      throw new ModelError('PROVIDER_UNAVAILABLE');
    }
  }
  private async retry<T>(operation: () => PromiseLike<T>, signal: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      try { return await operation(); } catch (error) {
        const status = error instanceof OpenAI.APIError ? error.status : undefined;
        const transient = error instanceof OpenAI.APIConnectionError || status === 408 || status === 429 || (status !== undefined && status >= 500);
        if (!transient || signal.aborted || attempt >= this.config.MODEL_MAX_RETRIES) throw error;
        const retryAfter = error instanceof OpenAI.APIError ? Number(error.headers?.get('retry-after')) : 0;
        // A long provider cooldown should be reported to the user, not ignored with a premature retry.
        if (retryAfter > 10) throw error;
        const waitMs = Math.max(500 * 2 ** attempt + Math.random() * 150, retryAfter * 1000 || 0);
        await delay(waitMs, undefined, { signal });
      }
    }
  }
}
