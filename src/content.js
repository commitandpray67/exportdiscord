// Content script (isolated world). Talks to Discord's API using the token
// observed by page-hook.js, and runs exports inside the Discord tab so they
// keep going after the popup closes.
(() => {
  const { snowflakeFromTime, compareSnowflakes } = globalThis.DXSnowflake;
  const { createZip } = globalThis.DXZip;
  const { normalizeMessage, FORMATS } = globalThis.DXFormatters;

  const API = `${location.origin}/api/v9`;
  const PAGE_DELAY_MS = 300;
  const TEXT_CHANNEL_TYPES = new Set([0, 2, 5]); // text, voice (text chat), announcement
  const DM_CHANNEL_TYPES = new Set([1, 3]);      // DM, group DM

  let token = null;
  let job = null;
  let abortController = null;
  const channelNames = {};

  document.addEventListener('discord-exporter:token', (e) => {
    if (typeof e.detail === 'string') token = e.detail;
  });
  const requestToken = () => document.dispatchEvent(new CustomEvent('discord-exporter:request-token'));
  requestToken();

  const sleep = (ms, signal) => new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal && signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });

  class ApiError extends Error {
    constructor(status, message) {
      super(message);
      this.status = status;
    }
  }

  async function api(path, signal) {
    if (!token) requestToken();
    if (!token) throw new ApiError(0, 'Not signed in yet — reload the Discord tab and try again.');
    for (let attempt = 0; attempt < 8; attempt++) {
      const res = await fetch(API + path, { headers: { Authorization: token }, signal });
      if (res.status === 429) {
        const body = await res.json().catch(() => ({}));
        const wait = (Number(body.retry_after) || Number(res.headers.get('retry-after')) || 1) * 1000;
        await sleep(wait + 250, signal);
        continue;
      }
      if (res.status >= 500 && attempt < 3) {
        await sleep(1000 * (attempt + 1), signal);
        continue;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new ApiError(res.status, body.message || `HTTP ${res.status}`);
      }
      return res.json();
    }
    throw new ApiError(429, 'Rate limited too many times');
  }

  // ---- listing ---------------------------------------------------------

  async function listGuilds() {
    const guilds = await api('/users/@me/guilds');
    return [
      { id: '@me', name: 'Direct Messages' },
      ...guilds.map((g) => ({ id: g.id, name: g.name })).sort((a, b) => a.name.localeCompare(b.name)),
    ];
  }

  async function listChannels(guildId) {
    if (guildId === '@me') {
      const dms = await api('/users/@me/channels');
      return dms
        .filter((c) => DM_CHANNEL_TYPES.has(c.type))
        .sort((a, b) => compareSnowflakes(b.last_message_id || '0', a.last_message_id || '0'))
        .map((c) => {
          const people = (c.recipients || []).map((r) => r.global_name || r.username);
          const name = c.name || people.join(', ') || 'Unknown';
          channelNames[c.id] = name;
          return { id: c.id, name, category: c.type === 3 ? 'Group DMs' : 'Direct Messages' };
        });
    }

    const all = await api(`/guilds/${guildId}/channels`);
    const categories = {};
    for (const c of all) {
      channelNames[c.id] = c.name;
      if (c.type === 4) categories[c.id] = c;
    }
    const catPos = (c) => (c.parent_id && categories[c.parent_id] ? categories[c.parent_id].position : -1);
    return all
      .filter((c) => TEXT_CHANNEL_TYPES.has(c.type))
      .sort((a, b) => catPos(a) - catPos(b) || a.position - b.position)
      .map((c) => ({
        id: c.id,
        name: c.name,
        category: c.parent_id && categories[c.parent_id] ? categories[c.parent_id].name : '',
      }));
  }

  // ---- export ----------------------------------------------------------

  // Fetches messages with timestamp in [fromMs, toMs], oldest first.
  async function fetchMessages(channelId, fromMs, toMs, signal, onPage) {
    let after = fromMs ? (snowflakeFromTime(fromMs) - 1n).toString() : '0';
    if (after === '-1') after = '0';
    const before = toMs ? snowflakeFromTime(toMs + 1) : null;
    const out = [];
    for (;;) {
      const batch = await api(`/channels/${channelId}/messages?limit=100&after=${after}`, signal);
      if (!batch.length) break;
      batch.sort((a, b) => compareSnowflakes(a.id, b.id));
      let reachedEnd = false;
      for (const m of batch) {
        if (before !== null && BigInt(m.id) >= before) { reachedEnd = true; break; }
        out.push(normalizeMessage(m));
      }
      onPage(out.length);
      if (reachedEnd || batch.length < 100) break;
      after = batch[batch.length - 1].id;
      await sleep(PAGE_DELAY_MS, signal);
    }
    return out;
  }

  const safeName = (s) => String(s).replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'untitled';
  const stamp = (d) => d.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');

  function broadcast() {
    chrome.runtime.sendMessage({ type: 'progress', job }).catch(() => { /* popup closed */ });
  }

  function log(text) {
    job.log.push(text);
    if (job.log.length > 200) job.log.shift();
  }

  function download(name, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    (document.body || document.documentElement).appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  async function runExport({ channels, from, to, format }) {
    const fmt = FORMATS[format] || FORMATS.json;
    abortController = new AbortController();
    const { signal } = abortController;
    const exportedAt = new Date();
    job = {
      state: 'running',
      channelCount: channels.length,
      channelIndex: 0,
      currentChannel: '',
      channelMessages: 0,
      totalMessages: 0,
      log: [],
      error: null,
      fileName: null,
    };
    broadcast();

    const files = [];
    try {
      for (const [i, ch] of channels.entries()) {
        const label = ch.guildName === 'Direct Messages' ? ch.name : `${ch.guildName} › #${ch.name}`;
        Object.assign(job, { channelIndex: i, currentChannel: label, channelMessages: 0 });
        broadcast();
        let messages;
        const before = job.totalMessages;
        try {
          messages = await fetchMessages(ch.id, from, to, signal, (n) => {
            job.channelMessages = n;
            job.totalMessages = before + n;
            broadcast();
          });
        } catch (e) {
          if (e.name === 'AbortError') throw e;
          const reason = e.status === 403 ? 'no access' : e.message;
          log(`⚠ ${label}: skipped (${reason})`);
          continue;
        }
        log(`✓ ${label}: ${messages.length} messages`);
        const rendered = fmt.render({
          guildName: ch.guildName,
          channelName: ch.name,
          channelId: ch.id,
          range: { from, to },
          exportedAt: exportedAt.toISOString(),
          messages,
          channelNames,
        });
        files.push({ name: `${safeName(ch.guildName)} - ${safeName(ch.name)}.${fmt.ext}`, data: rendered });
      }
    } catch (e) {
      if (e.name === 'AbortError') {
        job.state = 'cancelled';
        log('Export cancelled.');
      } else {
        job.state = 'error';
        job.error = e.message;
      }
      broadcast();
      return;
    }

    if (!files.length) {
      job.state = 'error';
      job.error = 'Nothing was exported.';
      broadcast();
      return;
    }

    // De-duplicate file names (e.g. two channels with the same name).
    const seen = {};
    for (const f of files) {
      const n = (seen[f.name] = (seen[f.name] || 0) + 1);
      if (n > 1) f.name = f.name.replace(/(\.\w+)$/, ` (${n})$1`);
    }

    if (files.length === 1) {
      job.fileName = files[0].name;
      download(files[0].name, new Blob([files[0].data], { type: `${fmt.mime};charset=utf-8` }));
    } else {
      job.fileName = `discord-export-${stamp(exportedAt)}.zip`;
      download(job.fileName, new Blob([createZip(files, exportedAt)], { type: 'application/zip' }));
    }
    job.state = 'done';
    broadcast();
  }

  // ---- messaging -------------------------------------------------------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const reply = (promise) => {
      promise.then(
        (data) => sendResponse({ ok: true, data }),
        (e) => sendResponse({ ok: false, error: e.message, status: e.status }),
      );
      return true;
    };
    switch (msg && msg.type) {
      case 'status':
        if (!token) requestToken();
        sendResponse({ ok: true, data: { hasToken: !!token, job } });
        return false;
      case 'listGuilds':
        return reply(listGuilds());
      case 'listChannels':
        return reply(listChannels(msg.guildId));
      case 'startExport':
        if (job && job.state === 'running') {
          sendResponse({ ok: false, error: 'An export is already running.' });
          return false;
        }
        runExport(msg).catch((e) => {
          job = { ...(job || { log: [] }), state: 'error', error: e.message };
          broadcast();
        });
        sendResponse({ ok: true });
        return false;
      case 'cancel':
        if (abortController) abortController.abort();
        sendResponse({ ok: true });
        return false;
      default:
        return false;
    }
  });
})();
