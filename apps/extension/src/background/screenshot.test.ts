import { describe, expect, it, vi } from 'vitest';
import { makeObservation } from '../../../../tests/fixtures.js';
import { ScreenshotService } from './screenshot.js';
import type { ScreenshotDependencies } from './screenshot.js';

function dependencies(): ScreenshotDependencies {
  return {
    assertActive: vi.fn(async () => undefined),
    observe: vi.fn(async () => ({ observation: makeObservation(), screenshotSafe: true })),
    capture: vi.fn(async () => 'data:image/jpeg;base64,YQ=='),
    dimensions: vi.fn(async () => ({ width: 1280, height: 720 })),
    now: () => 1_000,
  };
}

describe('fresh, local-only screenshot service', () => {
  it('returns bytes only after before/after state checks', async () => {
    const deps = dependencies();
    const result = await new ScreenshotService().capture(deps);
    expect(result.observation.screenshot.status).toBe('captured');
    expect(result.dataUrl).toBeDefined();
    expect(deps.assertActive).toHaveBeenCalledTimes(5);
    expect(deps.observe).toHaveBeenCalledTimes(3);
  });
  it('does not capture sensitive pages', async () => {
    const deps = dependencies();
    deps.observe = vi.fn(async () => ({ observation: makeObservation(), screenshotSafe: false }));
    const result = await new ScreenshotService().capture(deps);
    expect(result.observation.screenshot.status).toBe('omitted');
    expect(result.dataUrl).toBeUndefined();
    expect(deps.capture).not.toHaveBeenCalled();
  });
  it('drops captured bytes when the active tab changes', async () => {
    const deps = dependencies();
    let active = true;
    deps.capture = vi.fn(async () => { active = false; return 'data:image/jpeg;base64,YQ=='; });
    deps.assertActive = async () => { if (!active) throw new Error('Wrong tab'); };
    await expect(new ScreenshotService().capture(deps)).rejects.toThrow('Wrong tab');
    expect(deps.dimensions).not.toHaveBeenCalled();
  });
  it.each(['revision', 'documentId', 'viewport', 'scroll', 'privacy'])('drops bytes when %s changes during capture', async (field) => {
    const deps = dependencies();
    let count = 0;
    deps.observe = async () => {
      const observation = makeObservation();
      if (count++ > 0) {
        if (field === 'revision') observation.revision++;
        if (field === 'documentId') observation.documentId = 'new-document';
        if (field === 'viewport') observation.viewport.zoom = 1.25;
        if (field === 'scroll') observation.scroll.y = 100;
      }
      return { observation, screenshotSafe: !(field === 'privacy' && count > 1) };
    };
    await expect(new ScreenshotService().capture(deps)).rejects.toThrow('page changed');
  });
  it('bounds capture rate without sleeping', async () => {
    const deps = dependencies(); const service = new ScreenshotService();
    await service.capture(deps);
    const result = await service.capture(deps);
    expect(result.observation.screenshot.status).toBe('omitted');
    expect(deps.capture).toHaveBeenCalledTimes(1);
  });
  it('drops bytes if the document changes while the image is decoding', async () => {
    const deps = dependencies();
    let decoded = false;
    deps.dimensions = async () => { decoded = true; return { width: 1280, height: 720 }; };
    deps.observe = async () => {
      const observation = makeObservation();
      if (decoded) observation.revision++;
      return { observation, screenshotSafe: true };
    };
    await expect(new ScreenshotService().capture(deps)).rejects.toThrow('page changed');
  });
  it('reports missing Chrome permission without exposing browser errors', async () => {
    const deps = dependencies();
    deps.capture = async () => { throw new Error('browser error with sensitive internals'); };
    const result = await new ScreenshotService().capture(deps);
    expect(result.observation.screenshot.status).toBe('omitted');
    expect(JSON.stringify(result)).not.toContain('sensitive internals');
  });
  it('rejects oversized screenshot payloads', async () => {
    const deps = dependencies(); deps.capture = async () => `data:image/jpeg;base64,${'a'.repeat(2_000_000)}`;
    const result = await new ScreenshotService().capture(deps);
    expect(result.dataUrl).toBeUndefined();
    expect(deps.dimensions).not.toHaveBeenCalled();
  });
});
