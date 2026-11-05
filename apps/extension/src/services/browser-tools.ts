import { browserToolCommandSchema, browserToolResponseSchema } from '@clickflow/shared';
import type { BrowserToolCommand, BrowserToolResponse } from '@clickflow/shared';

export function hasExtensionRuntime(): boolean {
  return typeof chrome !== 'undefined' && !!chrome.runtime?.id;
}

export async function browserTool(command: BrowserToolCommand): Promise<BrowserToolResponse> {
  return browserToolResponseSchema.parse(await chrome.runtime.sendMessage(browserToolCommandSchema.parse(command)));
}
