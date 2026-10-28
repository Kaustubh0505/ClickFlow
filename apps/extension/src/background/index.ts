// Phase 1 only opens the panel. No tab observation, task scheduling, or execution.
chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {
    console.error('ClickFlow could not configure its side panel. Reload the extension.');
  });
});
