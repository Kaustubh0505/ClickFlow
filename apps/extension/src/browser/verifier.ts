import type { VerificationCondition, VerificationResult } from '@clickflow/shared';
import { BrowserToolError } from './errors.js';
import { isSensitive, safeVisibleText } from './dom.js';
import type { PageObserver } from './observation.js';
import { resolveTargets } from './targets.js';

export type VerificationContext = { scrollX: number; scrollY: number; extraction?: { outputKey: string; text: string; schemaId: string } };
export function assertSupportedVerification(condition: VerificationCondition): void {
  if (condition.type === 'semantic_assessment_required' || (condition.type === 'extracted_data_matches_schema' && condition.schemaId !== 'text-v1')) throw new BrowserToolError('UNSUPPORTED_ACTION');
  if ('target' in condition && condition.target?.strategy === 'semantic') throw new BrowserToolError('TARGET_UNRESOLVED');
}

export function evaluateVerification(condition: VerificationCondition, observer: PageObserver, context: VerificationContext): boolean | null {
  if (condition.type === 'url_matches') return condition.match === 'exact' ? location.href === condition.url : location.href.startsWith(condition.url);
  if (condition.type === 'scroll_position_changed') return Math.abs((condition.axis === 'x' ? scrollX - context.scrollX : scrollY - context.scrollY)) >= condition.minDelta;
  if (condition.type === 'extracted_data_matches_schema') return context.extraction?.outputKey === condition.outputKey && context.extraction.schemaId === condition.schemaId && !!context.extraction.text.trim();
  if (condition.type === 'element_count') {
    const elements = resolveTargets(condition.target, observer);
    if (elements.some(isSensitive)) throw new BrowserToolError('POLICY_BLOCKED');
    return elements.length === condition.count;
  }
  if (condition.type === 'text_present' && !condition.target) return safeVisibleText(document.body).text.includes(condition.text);
  if (!('target' in condition) || !condition.target) return null;
  const elements = resolveTargets(condition.target, observer);
  if (elements.length > 1) throw new BrowserToolError('TARGET_AMBIGUOUS');
  const element = elements[0];
  if (element && isSensitive(element)) throw new BrowserToolError('POLICY_BLOCKED');
  if (condition.type === 'element_hidden') return !element;
  if (!element) return false;
  if (condition.type === 'element_visible') return true;
  if (condition.type === 'element_focused') return document.activeElement === element;
  if (condition.type === 'input_value_equals') return (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) && element.value === condition.value;
  if (condition.type === 'selected_option_equals') return element instanceof HTMLSelectElement && element.value === condition.value;
  if (condition.type === 'text_present') return safeVisibleText(element).text.includes(condition.text);
  return null;
}

export async function waitForVerification(condition: VerificationCondition, observer: PageObserver, signal: AbortSignal, timeoutMs: number, context: VerificationContext = { scrollX, scrollY }): Promise<Pick<VerificationResult, 'status' | 'explanation'>> {
  if (signal.aborted) throw new BrowserToolError('CANCELLED');
  return new Promise((resolve, reject) => {
    let done = false;
    const events = ['input', 'change', 'focusin', 'scroll', 'resize'];
    function cleanup() {
      mutation?.disconnect();
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      events.forEach((event) => window.removeEventListener(event, check, true));
    }
    function finish(status: 'passed' | 'failed' | 'unknown', explanation: string) {
      if (done) return;
      done = true; cleanup(); resolve({ status, explanation });
    }
    function abort() { if (!done) { done = true; cleanup(); reject(new BrowserToolError('CANCELLED')); } }
    function check() {
      if (done) return;
      try {
        const result = evaluateVerification(condition, observer, context);
        if (result === true) finish('passed', 'The expected DOM condition was observed.');
        else if (result === null) finish('unknown', 'This verification requires a later phase or model assessment.');
      } catch (error) { done = true; cleanup(); reject(error); }
    }
    const mutation = new MutationObserver(check);
    mutation.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    const timer = setTimeout(() => finish('failed', 'The expected condition was not observed before the action timeout.'), timeoutMs);
    events.forEach((event) => window.addEventListener(event, check, true));
    signal.addEventListener('abort', abort, { once: true });
    check();
  });
}
