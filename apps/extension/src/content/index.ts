import { contentCommandSchema, contentResponseSchema, isSupportedPageUrl } from '@clickflow/shared';
import { safeError } from '../browser/errors.js';
import { ContentRuntime } from './runtime.js';

const isolatedWorld = globalThis as typeof globalThis & { __clickflowPhase2Installed?: boolean };
if (isSupportedPageUrl(location.href) && window.top === window && !isolatedWorld.__clickflowPhase2Installed) {
  isolatedWorld.__clickflowPhase2Installed = true;
  const runtime = new ContentRuntime();
  chrome.runtime.onMessage.addListener((input: unknown, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || sender.tab) return false;
    const parsed = contentCommandSchema.safeParse(input);
    if (!parsed.success) { sendResponse({ kind: 'error', error: { code: 'INVALID_MESSAGE', message: 'Invalid content command.' } }); return false; }
    void (async () => {
      const command = parsed.data;
      if (command.kind === 'content_stop') { runtime.stop(command.sessionId); return { kind: 'stopped' as const }; }
      if (command.kind === 'content_result') return { kind: 'cached_result' as const, result: await runtime.cachedResult(command.sessionId, command.actionId) };
      if (command.kind === 'content_check_state') return { kind: 'checked_state' as const, ...runtime.checkState(command) };
      if (command.kind === 'content_check_criteria') return { kind: 'checked_criteria' as const, ...runtime.checkCriteria(command) };
      if (command.kind === 'content_observe') return { kind: 'observed' as const, frame: runtime.observe(command) };
      if (command.kind === 'content_prepare') return { kind: 'prepared' as const, confirmation: await runtime.prepare(command) };
      return { kind: 'executed' as const, result: await runtime.execute(command) };
    })().then(
      (response) => sendResponse(contentResponseSchema.parse(response)),
      (error: unknown) => sendResponse({ kind: 'error', error: safeError(error) }),
    );
    return true;
  });
}
