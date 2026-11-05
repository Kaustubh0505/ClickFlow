const sensitiveWords = /password|passcode|secret|token|api[-_ ]?key|authorization|credit[-_ ]?card|card[-_ ]?number|\bcvv\b|\bcvc\b|\biban\b|social[-_ ]?security|one[-_ ]?time[-_ ]?code|\bssn\b/i;
const sensitiveAutocomplete = /^(?:current-password|new-password|one-time-code|cc-|email|tel|street-address|address-line)/;
const privateSelector = '[data-sensitive], [data-private], [data-secret], [data-clickflow-sensitive]';

export function redactText(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s<>]+/gi, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]')
    .replace(/\b(?:sk|pk|api)[-_][A-Za-z0-9_-]{12,}\b/g, '[redacted]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted]')
    .replace(/\b(?:\d[ -]?){13,19}\b/g, '[redacted]');
}

export function isSensitive(element: Element): boolean {
  if (element.closest(privateSelector)) return true;
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) return false;
  const attributes = [element.id, element.getAttribute('name'), element.getAttribute('aria-label'), element.getAttribute('placeholder'), ...Array.from(element.labels ?? [], (label) => label.textContent)].join(' ');
  return (element instanceof HTMLInputElement && ['password', 'hidden', 'file', 'email', 'tel'].includes(element.type))
    || sensitiveWords.test(attributes) || sensitiveAutocomplete.test(element.autocomplete);
}

export function isVisible(element: Element, viewportOnly = true): boolean {
  if (!(element instanceof HTMLElement) || !element.isConnected || element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
  const style = getComputedStyle(element);
  if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0 || element.getClientRects().length === 0) return false;
  // Ancestor opacity does not affect computed opacity on a child.
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const parentStyle = getComputedStyle(parent);
    if (parentStyle.display === 'none' || parentStyle.visibility === 'hidden' || Number(parentStyle.opacity) === 0) return false;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && (!viewportOnly || (rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth));
}

export function isEnabled(element: Element): boolean {
  return !element.matches(':disabled, [aria-disabled="true"], [readonly]') && !element.closest('[inert]');
}

export function roleOf(element: Element): string {
  const explicit = element.getAttribute('role');
  if (explicit) return explicit.split(/\s+/)[0] ?? '';
  if (element instanceof HTMLButtonElement) return 'button';
  if (element instanceof HTMLAnchorElement && element.hasAttribute('href')) return 'link';
  if (element instanceof HTMLSelectElement) return 'combobox';
  if (element instanceof HTMLTextAreaElement) return 'textbox';
  if (element instanceof HTMLInputElement) {
    if (element.type === 'search') return 'searchbox';
    if (['button', 'submit', 'reset'].includes(element.type)) return 'button';
    if (['checkbox', 'radio'].includes(element.type)) return element.type;
    return 'textbox';
  }
  return '';
}

export function accessibleName(element: Element): string {
  const labelledBy = element.getAttribute('aria-labelledby')?.split(/\s+/)
    .map((id) => document.getElementById(id)).filter((label): label is HTMLElement => !!label && !isSensitive(label))
    .map((label) => safeVisibleText(label, 500).text).join(' ').trim();
  const labels = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
    ? Array.from(element.labels ?? [], (label) => safeVisibleText(label, 500).text).join(' ').trim() : '';
  // Input values are never used as accessible names or observation text.
  const text = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? '' : safeVisibleText(element, 500).text;
  return redactText(labelledBy || element.getAttribute('aria-label') || labels || text || element.getAttribute('title') || '').trim().slice(0, 500);
}

export const interactiveSelector = 'button, a[href], input:not([type="hidden"]), textarea, select, [role], [tabindex]';

export function safeVisibleText(root: Element, maxCharacters = 20_000): { text: string; truncated: boolean } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const chunks: string[] = [];
  let length = 0;
  let examined = 0;
  let node: Node | null;
  let truncated = false;
  while ((node = walker.nextNode())) {
    if (++examined > 5_000 || length >= maxCharacters) { truncated = true; break; }
    const parent = node.parentElement;
    if (!parent || parent.closest('script, style, template, noscript, input, textarea') || isSensitive(parent) || !isVisible(parent)) continue;
    const text = redactText(node.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const remaining = maxCharacters - length;
    chunks.push(text.slice(0, remaining));
    length += Math.min(text.length, remaining) + 1;
    if (text.length > remaining) truncated = true;
  }
  return { text: chunks.join(' ').slice(0, maxCharacters), truncated };
}

export function screenshotIsSafe(): boolean {
  // Pixels in embedded/canvas content cannot be sanitized by the DOM observer.
  if (Array.from(document.querySelectorAll('iframe, canvas, video, object, embed')).some((element) => isVisible(element, false))) return false;
  const candidates = document.querySelectorAll(`${privateSelector}, input, textarea, select`);
  if (candidates.length > 2_000) return false;
  if (Array.from(candidates).some((element) => isVisible(element, false) && isSensitive(element))) return false;
  if (Array.from(candidates).some((element) => isVisible(element, false) && (element instanceof HTMLTextAreaElement
    || (element instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'submit', 'reset', 'image'].includes(element.type))) && element.value.length > 0)) return false;
  const visible = safeVisibleText(document.body);
  return !visible.truncated && !visible.text.includes('[redacted]');
}
