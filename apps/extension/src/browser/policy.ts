import { isFixtureUrl, isSupportedPageUrl } from '@clickflow/shared';
import type { Action } from '@clickflow/shared';
import { accessibleName, isSensitive, redactText } from './dom.js';
import { BrowserToolError } from './errors.js';

const safeControlIds = new Set(['fixture-search', 'fixture-controlled', 'fixture-reveal', 'fixture-delay', 'fixture-no-change', 'fixture-duplicate-a', 'fixture-duplicate-b', 'fixture-select', 'fixture-notes', 'fixture-extract']);
const consequential = /\b(buy|purchase|pay|payment|checkout|send|submit|delete|remove|publish|security|password|account|subscribe|transfer)\b/i;

/** Independent of model risk labels. Unknown clicks can have side effects and require review. */
export function actionReasons(action: Action, element?: HTMLElement): string[] {
  if (!isSupportedPageUrl(location.href)) throw new BrowserToolError('UNSUPPORTED_PAGE');
  if (/captcha|challenge-platform|verify (?:you are|your identity)|access denied/i.test(`${document.title} ${document.querySelector('h1')?.textContent ?? ''}`)
    || document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], [data-sitekey]')) throw new BrowserToolError('POLICY_BLOCKED');
  if (['observe', 'wait', 'scroll', 'finish'].includes(action.type)) return [];
  if (!element || isSensitive(element)) throw new BrowserToolError('POLICY_BLOCKED');
  if (action.type === 'extract_text') return [];
  if (!(element instanceof HTMLButtonElement || element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement || element instanceof HTMLAnchorElement || element.getAttribute('role'))) throw new BrowserToolError('POLICY_BLOCKED');
  if (element instanceof HTMLInputElement && !['text', 'search'].includes(element.type)) throw new BrowserToolError('POLICY_BLOCKED');
  if (action.type === 'type' && (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) || redactText(action.text) !== action.text)) throw new BrowserToolError('POLICY_BLOCKED');
  if (action.type === 'clear_input' && !(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) throw new BrowserToolError('POLICY_BLOCKED');
  if (action.type === 'select_option' && !(element instanceof HTMLSelectElement)) throw new BrowserToolError('POLICY_BLOCKED');
  if (action.type === 'select_option' && redactText(action.value) !== action.value) throw new BrowserToolError('POLICY_BLOCKED');
  const submit = action.type === 'click' || (action.type === 'press_key' && ['Enter', 'Space'].includes(action.key));
  if (submit && element.closest('form') && Array.from(element.closest('form')!.querySelectorAll('input, textarea, select')).some(isSensitive)) throw new BrowserToolError('POLICY_BLOCKED');
  if (element instanceof HTMLAnchorElement && !isSupportedPageUrl(element.href)) throw new BrowserToolError('POLICY_BLOCKED');
  if (action.type === 'press_key' && !(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLButtonElement)) throw new BrowserToolError('POLICY_BLOCKED');
  const reasons: string[] = [];
  if (consequential.test(`${accessibleName(element)} ${element.getAttribute('title') ?? ''}`)) reasons.push('This control may perform a consequential operation.');
  if (submit && element.closest('form')) reasons.push('This action may submit form contents to the website.');
  const safeFixture = isFixtureUrl(location.href) && safeControlIds.has(element.id);
  if (!isFixtureUrl(location.href) && ['click', 'type', 'clear_input', 'select_option', 'press_key'].includes(action.type)) reasons.push('Website controls may save or transmit data immediately. Review this interaction before dispatch.');
  if (action.type === 'click' && !safeFixture && !(element instanceof HTMLInputElement && ['text', 'search'].includes(element.type)) && !(element instanceof HTMLTextAreaElement)) reasons.push('This click may change website data or navigate. Review its target and effect.');
  if (action.type === 'press_key' && submit && !safeFixture) reasons.push('This key may activate a control or submit website data.');
  return reasons;
}

export function assertSafeAction(action: Action, element?: HTMLElement, approved = false): void {
  if (actionReasons(action, element).length && !approved) throw new BrowserToolError('POLICY_BLOCKED');
}
