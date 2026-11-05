import type { Action } from '@clickflow/shared';
import { BrowserToolError } from './errors.js';
import { interactiveSelector, isEnabled, isSensitive, isVisible } from './dom.js';

export function setInput(element: HTMLElement, value: string): void {
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) throw new BrowserToolError('POLICY_BLOCKED');
  const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (!setter) throw new BrowserToolError('UNSUPPORTED_ACTION');
  element.focus(); setter.call(element, value);
  element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: null }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

export function pressKey(element: HTMLElement, action: Extract<Action, { type: 'press_key' }>): void {
  element.focus();
  const event = new KeyboardEvent('keydown', { key: action.key === 'Space' ? ' ' : action.key, bubbles: true, cancelable: true });
  if (element.dispatchEvent(event)) {
    if (element instanceof HTMLButtonElement && ['Enter', 'Space'].includes(action.key)) element.click();
    else if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      if (action.key === 'Enter' && element instanceof HTMLInputElement && element.form) element.form.requestSubmit();
      const start = element.selectionStart ?? element.value.length; const end = element.selectionEnd ?? start;
      if (action.key === 'Backspace' || action.key === 'Delete' || action.key === 'Space') {
        const from = action.key === 'Backspace' && start === end ? Math.max(0, start - 1) : start;
        const to = action.key === 'Delete' && start === end ? Math.min(element.value.length, end + 1) : end;
        setInput(element, element.value.slice(0, from) + (action.key === 'Space' ? ' ' : '') + element.value.slice(to));
      } else if (['Home', 'End', 'ArrowLeft', 'ArrowRight'].includes(action.key)) {
        const at = action.key === 'Home' ? 0 : action.key === 'End' ? element.value.length : Math.max(0, Math.min(element.value.length, start + (action.key === 'ArrowLeft' ? -1 : 1)));
        element.setSelectionRange(at, at);
      }
    }
    if (action.key === 'Tab') {
      const controls = Array.from(document.querySelectorAll<HTMLElement>(interactiveSelector)).filter((control) => isVisible(control) && isEnabled(control) && !isSensitive(control) && control.tabIndex >= 0);
      controls[(controls.indexOf(element) + 1) % controls.length]?.focus();
    }
  }
  element.dispatchEvent(new KeyboardEvent('keyup', { key: event.key, bubbles: true }));
}
