import type { Target } from '@clickflow/shared';
import { accessibleName, interactiveSelector, isEnabled, isVisible, roleOf, safeVisibleText } from './dom.js';
import { BrowserToolError } from './errors.js';
import type { PageObserver } from './observation.js';

function matches(actual: string, expected: string, exact: boolean): boolean {
  const normalized = actual.trim().replace(/\s+/g, ' ');
  return exact ? normalized === expected : normalized.toLocaleLowerCase().includes(expected.toLocaleLowerCase());
}

export function resolveTargets(target: Target, observer: PageObserver): Element[] {
  if (target.strategy === 'semantic') throw new BrowserToolError('TARGET_UNRESOLVED');
  if (target.strategy === 'element_ref') return observer.resolveReference(target).filter((element) => isVisible(element));
  if (target.strategy === 'selector') {
    if (!/^(?:#[A-Za-z][\w-]{0,95}|\[(?:name|data-testid)="[A-Za-z0-9_-]{1,96}"\])$/.test(target.selector)) throw new BrowserToolError('UNSUPPORTED_SELECTOR');
    return Array.from(document.querySelectorAll(target.selector)).filter((element) => isVisible(element));
  }
  if (target.strategy === 'text') return Array.from(document.querySelectorAll('button,a,input,textarea,select,p,output,h1,h2,h3,li,td')).slice(0, 2000).filter((element) => isVisible(element) && matches(accessibleName(element) || safeVisibleText(element, 500).text, target.text, target.exact));
  const candidates = Array.from(document.querySelectorAll(interactiveSelector)).slice(0, 2_000).filter((element) => isVisible(element));
  if (target.strategy === 'role') return candidates.filter((element) => roleOf(element) === target.role && matches(accessibleName(element), target.name, target.exact));
  if (target.strategy === 'label') return candidates.filter((element) =>
    (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)
    && matches(Array.from(element.labels ?? [], (label) => safeVisibleText(label, 500).text).join(' ').trim(), target.label, target.exact));
  return [];
}

export function resolveOne(target: Target, observer: PageObserver): HTMLElement {
  const matches = resolveTargets(target, observer);
  if (matches.length === 0) throw new BrowserToolError('TARGET_NOT_FOUND');
  if (matches.length > 1) throw new BrowserToolError('TARGET_AMBIGUOUS');
  const element = matches[0];
  if (!(element instanceof HTMLElement) || !isEnabled(element)) throw new BrowserToolError('TARGET_DISABLED');
  const rect = element.getBoundingClientRect();
  const x = Math.max(0, rect.left) + Math.min(rect.width, innerWidth - Math.max(0, rect.left)) / 2;
  const y = Math.max(0, rect.top) + Math.min(rect.height, innerHeight - Math.max(0, rect.top)) / 2;
  const covering = document.elementFromPoint(x, y);
  if (!covering || !(element === covering || element.contains(covering))) throw new BrowserToolError('TARGET_DISABLED');
  return element;
}
