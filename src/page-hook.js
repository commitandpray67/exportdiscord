// Runs in Discord's own page context (MAIN world) at document_start.
//
// Discord's web client sends the user's auth token in the Authorization
// header of its own API requests. We observe that header so the extension's
// content script can make the same API calls on the user's behalf. The token
// is handed only to our content script on this same page; it is never stored
// or sent anywhere other than discord.com.
(() => {
  if (window.__discordExporterHooked) return;
  window.__discordExporterHooked = true;

  let token = null;

  const publish = () => {
    if (token) {
      document.dispatchEvent(new CustomEvent('discord-exporter:token', { detail: token }));
    }
  };

  const capture = (name, value) => {
    if (typeof name === 'string' && name.toLowerCase() === 'authorization' &&
        typeof value === 'string' && value && value !== token) {
      token = value;
      publish();
    }
  };

  const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    try { capture(name, value); } catch (_) { /* never break Discord */ }
    return originalSetRequestHeader.apply(this, arguments);
  };

  const originalFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const headers = (init && init.headers) || (input instanceof Request ? input.headers : null);
      if (headers instanceof Headers) {
        capture('authorization', headers.get('authorization'));
      } else if (Array.isArray(headers)) {
        for (const [k, v] of headers) capture(k, v);
      } else if (headers && typeof headers === 'object') {
        for (const k of Object.keys(headers)) capture(k, headers[k]);
      }
    } catch (_) { /* never break Discord */ }
    return originalFetch.apply(this, arguments);
  };

  document.addEventListener('discord-exporter:request-token', publish);
})();
