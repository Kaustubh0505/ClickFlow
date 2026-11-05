import { installBrowserTools } from './tools.js';

// Browser tools and prepared task dispatch; the backend owns planning and authorization.
installBrowserTools();
chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {
    console.error('ClickFlow could not configure its side panel. Reload the extension.');
  });
});
