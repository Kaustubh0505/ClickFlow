import type { Observation, ObservationFrame } from '@clickflow/shared';
import { BrowserToolError } from '../browser/errors.js';

export interface ScreenshotDependencies {
  assertActive(): Promise<void>;
  observe(): Promise<ObservationFrame>;
  capture(): Promise<string>;
  dimensions(dataUrl: string): Promise<{ width: number; height: number }>;
  now(): number;
}

export class ScreenshotService {
  private lastCaptureAt = -Infinity;

  async capture(deps: ScreenshotDependencies): Promise<{ observation: Observation; dataUrl?: string }> {
    await deps.assertActive();
    const before = await deps.observe();
    const omitted = (reason: string) => ({ observation: { ...before.observation, screenshot: { status: 'omitted' as const, reason } } });
    if (!before.screenshotSafe) return omitted('Screenshot blocked because sensitive or unbounded page content may be visible.');
    if (deps.now() - this.lastCaptureAt < 600) return omitted('Screenshot capture is throttled. Re-observe later.');
    await deps.assertActive();
    this.lastCaptureAt = deps.now();
    let dataUrl: string;
    try { dataUrl = await deps.capture(); }
    catch { return omitted('Chrome did not permit capture. Invoke the extension on the fixture tab, then retry.'); }
    await deps.assertActive(); // Drop bytes without returning them if a different tab became active.
    const after = await deps.observe();
    const a = before.observation; const b = after.observation;
    if (!after.screenshotSafe || a.documentId !== b.documentId || a.revision !== b.revision || a.url !== b.url
      || a.scroll.x !== b.scroll.x || a.scroll.y !== b.scroll.y || JSON.stringify(a.viewport) !== JSON.stringify(b.viewport)) {
      throw new BrowserToolError('STALE_OBSERVATION');
    }
    if (dataUrl.length > 2_000_000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(dataUrl)) return {
      observation: { ...b, screenshot: { status: 'omitted', reason: 'Capture exceeded the image payload limit or used an unsupported format.' } },
    };
    const dimensions = await deps.dimensions(dataUrl);
    if (dimensions.width < 1 || dimensions.height < 1 || dimensions.width > 16_384 || dimensions.height > 16_384) throw new BrowserToolError('STALE_OBSERVATION');
    await deps.assertActive();
    const final = await deps.observe();
    const c = final.observation;
    if (!final.screenshotSafe || b.documentId !== c.documentId || b.revision !== c.revision || b.url !== c.url
      || b.scroll.x !== c.scroll.x || b.scroll.y !== c.scroll.y || JSON.stringify(b.viewport) !== JSON.stringify(c.viewport)) throw new BrowserToolError('STALE_OBSERVATION');
    await deps.assertActive();
    return {
      observation: { ...c, screenshot: { status: 'captured', id: crypto.randomUUID(), capturedAt: new Date().toISOString(), ...dimensions, mimeType: 'image/jpeg', redacted: false } },
      dataUrl,
    };
  }
}

export async function jpegDimensions(dataUrl: string) {
  const encoded = dataUrl.split(',')[1];
  if (!encoded) throw new BrowserToolError('INVALID_MESSAGE');
  const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
  const result = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return result;
}
