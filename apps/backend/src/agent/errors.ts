export type ModelErrorCode = 'NOT_CONFIGURED' | 'UNSUPPORTED_MODEL' | 'AUTH_FAILED' | 'RATE_LIMITED' | 'PROVIDER_UNAVAILABLE' | 'INVALID_REQUEST' | 'TIMEOUT' | 'CANCELLED' | 'INVALID_OUTPUT' | 'INVALID_CONTEXT' | 'LIMIT_REACHED';
const messages: Record<ModelErrorCode, string> = {
  LIMIT_REACHED: 'The task model-call or duration budget is exhausted. No further model request was sent.',
  NOT_CONFIGURED: 'Set MODEL_API_KEY in the backend .env before planning.',
  UNSUPPORTED_MODEL: 'The configured model endpoint does not advertise image input and structured JSON output. Check MODEL_NAME and MODEL_BASE_URL; no replacement model was selected.',
  AUTH_FAILED: 'The provider rejected authentication or credits. Check the backend API key and provider account.',
  RATE_LIMITED: 'The provider rate limit was reached. Wait and retry; free endpoints have limited capacity.',
  PROVIDER_UNAVAILABLE: 'The provider is unavailable or unreachable. Retry later and check MODEL_BASE_URL.',
  INVALID_REQUEST: 'The provider rejected this request. Check model availability, image support and JSON-schema support for the configured endpoint.',
  TIMEOUT: 'The model request exceeded MODEL_TIMEOUT_MS. Retry later or adjust the backend timeout.',
  CANCELLED: 'Planning was cancelled. No plan was accepted.',
  INVALID_OUTPUT: 'The model returned empty, truncated, malformed or invalid structured output. No action or completion claim was accepted.',
  INVALID_CONTEXT: 'Planning context is invalid, stale, oversized or contains unsupported screenshot metadata.',
};
export class ModelError extends Error {
  constructor(readonly code: ModelErrorCode) { super(messages[code]); this.name = 'ModelError'; }
}
