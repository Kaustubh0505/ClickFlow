export const messages = {
  UNSUPPORTED_PAGE: 'Open a normal HTTP or HTTPS page. Browser pages, extension stores and secret-bearing URLs are unsupported.',
  PERMISSION_REQUIRED: 'Allow this site in Website access, then bind it again. No browser action was dispatched.',
  CONFIRMATION_REQUIRED: 'Review and approve this exact action before it can run.',
  APPROVAL_STALE: 'The action, page or form changed, or approval expired. Observe and review again.',
  FIXTURE_ONLY: 'Use the local test page or explicitly allow and bind a supported website.',
  WRONG_TAB: 'The bound page is no longer the active tab. Return to it and rebind.',
  DOCUMENT_CHANGED: 'The page document changed. Bind it again before continuing.',
  STALE_OBSERVATION: 'The page changed after observation. Observe it again before acting.',
  TARGET_NOT_FOUND: 'No visible target matched. Observe the page and check the target.',
  TARGET_AMBIGUOUS: 'Multiple visible elements match. Use a more specific target.',
  TARGET_DISABLED: 'The target is disabled, read-only, covered, or not interactable.',
  TARGET_UNRESOLVED: 'This target needs fresh resolution through Recover plan.',
  UNSUPPORTED_SELECTOR: 'Only a single ID, name, or data-testid selector is permitted.',
  POLICY_BLOCKED: 'This interaction is sensitive, unsupported, or requires an exact-action review before dispatch.',
  UNSUPPORTED_ACTION: 'This action or verification cannot be executed safely by the current browser adapter.',
  BUSY: 'An action is already running. Wait for its outcome or press Stop.',
  STOPPED: 'Browser tools are stopped. Bind the page again to start a new session.',
  CANCELLED: 'Stopped locally. An already dispatched action may have taken effect.',
  DUPLICATE_ACTION: 'This action ID was already attempted. It will not be dispatched again.',
  ACTION_LIMIT: 'This browser session reached its action limit. Bind again to start a new session.',
  INVALID_MESSAGE: 'The tool request or response did not pass validation.',
  CONNECTION_FAILED: 'The page could not be reached. Reload the extension and bind the page again.',
  INTERRUPTED: 'The browser worker was interrupted. Rebind and observe before attempting another action.',
  VERIFICATION_TIMEOUT: 'The action was dispatched, but its expected outcome was not observed before the timeout.',
} as const;

export type BrowserErrorCode = keyof typeof messages;
export class BrowserToolError extends Error {
  constructor(readonly code: BrowserErrorCode) { super(messages[code]); this.name = 'BrowserToolError'; }
}
export function safeError(error: unknown) {
  const code = error instanceof BrowserToolError ? error.code : 'CONNECTION_FAILED';
  return { code, message: messages[code] };
}
