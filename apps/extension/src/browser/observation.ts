import { isSupportedPageUrl, observationSchema } from '@clickflow/shared';
import type { ContentCommand, Observation, ObservationFrame, Target } from '@clickflow/shared';
import { accessibleName, interactiveSelector, isEnabled, isSensitive, isVisible, redactText, roleOf, safeVisibleText, screenshotIsSafe } from './dom.js';
import { BrowserToolError } from './errors.js';

export type BrowserIdentity = Extract<ContentCommand, { kind: 'content_observe' }>;

export class PageObserver {
  private revision = 0;
  private readonly mutationObserver: MutationObserver;
  private references = new Map<string, Element>();
  private last: Observation | null = null;
  private readonly changed = (event?: Event) => {
    // A queued scroll notification can arrive after observe() captured that exact position.
    // Actual new scroll positions remain guarded both here and by assertFresh().
    if (event?.type === 'scroll' && this.last?.scroll.x === scrollX && this.last.scroll.y === scrollY) return;
    this.revision++;
  };

  constructor() {
    this.mutationObserver = new MutationObserver(() => this.changed());
    this.mutationObserver.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
    for (const event of ['input', 'change', 'focusin', 'scroll', 'resize']) window.addEventListener(event, this.changed, true);
    window.addEventListener('pagehide', () => this.dispose());
    window.addEventListener('pageshow', (event) => {
      if (!event.persisted) return;
      this.last = null; this.revision++;
      this.mutationObserver.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
      for (const name of ['input', 'change', 'focusin', 'scroll', 'resize']) window.addEventListener(name, this.changed, true);
    });
  }

  private flush(): void {
    if (this.mutationObserver.takeRecords().length) this.revision++;
  }

  assertFresh(observationId: string, revision: number): void {
    this.flush();
    const last = this.last;
    if (!last || last.id !== observationId || last.revision !== revision || revision !== this.revision
      || last.url !== location.href || last.scroll.x !== scrollX || last.scroll.y !== scrollY
      || last.viewport.width !== innerWidth || last.viewport.height !== innerHeight
      || last.viewport.devicePixelRatio !== devicePixelRatio) throw new BrowserToolError('STALE_OBSERVATION');
  }

  resolveReference(target: Extract<Target, { strategy: 'element_ref' }>): Element[] {
    if (!this.last) throw new BrowserToolError('STALE_OBSERVATION');
    this.assertFresh(target.observationId, this.last.revision);
    const element = this.references.get(target.ref);
    if (!element?.isConnected) throw new BrowserToolError('STALE_OBSERVATION');
    return [element];
  }

  observe(identity: BrowserIdentity): ObservationFrame {
    if (!isSupportedPageUrl(location.href) || window.top !== window) throw new BrowserToolError('UNSUPPORTED_PAGE');
    this.flush();
    const references = new Map<string, Element>();
    const matches = Array.from(document.querySelectorAll(interactiveSelector));
    const visible = matches.slice(0, 2_000).filter((element) => isVisible(element) && !isSensitive(element));
    const elements = visible.slice(0, 100).map((element, index) => {
      const ref = `element-${index + 1}`;
      references.set(ref, element);
      const rect = element.getBoundingClientRect();
      return {
        ref, role: roleOf(element), name: accessibleName(element), tagName: element.tagName.toLowerCase(),
        ...(element instanceof HTMLInputElement ? { inputType: element.type } : {}),
        visible: true, enabled: isEnabled(element),
        bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      };
    });
    const text = safeVisibleText(document.body);
    const observation = observationSchema.parse({
      id: crypto.randomUUID(), capturedAt: new Date().toISOString(),
      tabId: identity.tabId, windowId: identity.windowId, frameId: 0, documentId: identity.documentId, revision: this.revision,
      url: location.href, title: redactText(document.title).slice(0, 1_000),
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio, zoom: identity.zoom },
      scroll: { x: scrollX, y: scrollY }, visibleText: text.text, elements,
      loading: document.readyState, truncated: text.truncated || visible.length > 100 || matches.length > 2_000,
      screenshot: { status: 'omitted', reason: 'DOM observation only; screenshots are optional.' },
    });
    this.references = references;
    this.last = observation;
    return { observation, screenshotSafe: screenshotIsSafe() };
  }

  dispose(): void {
    this.mutationObserver.disconnect();
    for (const event of ['input', 'change', 'focusin', 'scroll', 'resize']) window.removeEventListener(event, this.changed, true);
    this.references.clear();
  }
}
