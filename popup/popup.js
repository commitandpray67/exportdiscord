const $ = (id) => document.getElementById(id);
const DISCORD_URL = /^https:\/\/(?:ptb\.|canary\.)?discord\.com\//;

let tabId = null;
let guilds = [];
let channels = [];
const selected = new Map(); // channel id -> { id, name, guildName }

// ---- helpers -----------------------------------------------------------

function send(message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!response) return reject(new Error('No response from the Discord tab.'));
      if (!response.ok) return reject(new Error(response.error));
      resolve(response.data);
    });
  });
}

function show(section) {
  for (const id of ['notice', 'form', 'progress']) $(id).hidden = id !== section;
}

function notice(text, actionLabel, action) {
  $('notice-text').textContent = text;
  const button = $('notice-action');
  button.hidden = !actionLabel;
  button.textContent = actionLabel || '';
  button.onclick = action || null;
  show('notice');
}

function toLocalInput(date) {
  const off = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - off).toISOString().slice(0, 16);
}

const prefs = {
  async load() {
    try { return (await chrome.storage.local.get('prefs')).prefs || {}; } catch { return {}; }
  },
  save() {
    const value = { format: $('format').value, preset: $('preset').value, guild: $('guild').value };
    chrome.storage.local.set({ prefs: value }).catch(() => {});
  },
};

// ---- channel list --------------------------------------------------------

function renderChannels() {
  const box = $('channels');
  box.replaceChildren();
  const q = $('filter').value.trim().toLowerCase();
  const visible = channels.filter((c) => !q || c.name.toLowerCase().includes(q) || c.category.toLowerCase().includes(q));
  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = channels.length ? 'No channels match.' : 'No text channels.';
    box.append(empty);
  }
  let lastCategory = null;
  const guildName = guilds.find((g) => g.id === $('guild').value)?.name || '';
  for (const c of visible) {
    if (c.category !== lastCategory) {
      lastCategory = c.category;
      if (c.category) {
        const head = document.createElement('div');
        head.className = 'category';
        head.textContent = c.category;
        box.append(head);
      }
    }
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = selected.has(c.id);
    input.addEventListener('change', () => {
      if (input.checked) selected.set(c.id, { id: c.id, name: c.name, guildName });
      else selected.delete(c.id);
      renderSummary();
    });
    const name = document.createElement('span');
    name.textContent = guildName === 'Direct Messages' ? c.name : `# ${c.name}`;
    label.append(input, name);
    box.append(label);
  }
  renderSummary();
}

function renderSummary() {
  const servers = new Set([...selected.values()].map((c) => c.guildName));
  $('selected-summary').textContent = selected.size
    ? `${selected.size} channel${selected.size === 1 ? '' : 's'} selected` +
      (servers.size > 1 ? ` across ${servers.size} servers` : '')
    : 'No channels selected';
  $('export').disabled = selected.size === 0;
}

function setVisibleChecked(checked) {
  const guildName = guilds.find((g) => g.id === $('guild').value)?.name || '';
  const q = $('filter').value.trim().toLowerCase();
  for (const c of channels) {
    if (q && !c.name.toLowerCase().includes(q) && !c.category.toLowerCase().includes(q)) continue;
    if (checked) selected.set(c.id, { id: c.id, name: c.name, guildName });
    else selected.delete(c.id);
  }
  renderChannels();
}

async function loadChannels() {
  const box = $('channels');
  box.replaceChildren(Object.assign(document.createElement('div'), { className: 'empty', textContent: 'Loading…' }));
  channels = [];
  try {
    channels = await send({ type: 'listChannels', guildId: $('guild').value });
  } catch (e) {
    box.firstChild.textContent = `Couldn't load channels: ${e.message}`;
    return;
  }
  renderChannels();
}

// ---- time range ------------------------------------------------------------

function updatePreset() {
  $('custom-range').hidden = $('preset').value !== 'custom';
}

function getRange() {
  const preset = $('preset').value;
  if (preset === 'all') return { from: null, to: null };
  if (preset !== 'custom') return { from: Date.now() - Number(preset) * 86400000, to: null };
  const from = $('from').value ? new Date($('from').value).getTime() : null;
  const to = $('to').value ? new Date($('to').value).getTime() : null;
  return { from, to };
}

// ---- progress --------------------------------------------------------------

function renderJob(job) {
  show('progress');
  const running = job.state === 'running';
  $('cancel').hidden = !running;
  $('again').hidden = running;

  const done = job.state === 'done' ? job.channelCount : job.channelIndex;
  $('bar-fill').style.width = `${Math.round((done / Math.max(job.channelCount, 1)) * 100)}%`;

  if (running) {
    $('progress-title').textContent = `Exporting ${job.channelIndex + 1} of ${job.channelCount}: ${job.currentChannel}`;
    $('progress-detail').textContent = `${job.channelMessages.toLocaleString()} messages in this channel · ` +
      `${job.totalMessages.toLocaleString()} total. You can close this popup; the export keeps running in the Discord tab.`;
  } else if (job.state === 'done') {
    $('progress-title').textContent = 'Export complete';
    $('progress-detail').textContent = `${job.totalMessages.toLocaleString()} messages saved to ${job.fileName}`;
  } else if (job.state === 'cancelled') {
    $('progress-title').textContent = 'Export cancelled';
    $('progress-detail').textContent = '';
  } else {
    $('progress-title').textContent = 'Export failed';
    $('progress-detail').textContent = job.error || '';
  }

  const list = $('log');
  list.replaceChildren(...(job.log || []).map((line) => Object.assign(document.createElement('li'), { textContent: line })));
  list.scrollTop = list.scrollHeight;
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === 'progress' && sender.tab?.id === tabId && msg.job) renderJob(msg.job);
});

// ---- startup ---------------------------------------------------------------

async function showForm() {
  show('form');
  if (guilds.length) return;
  const saved = await prefs.load();
  if (saved.format) $('format').value = saved.format;
  if (saved.preset) $('preset').value = saved.preset;
  updatePreset();
  $('to').value = toLocalInput(new Date());
  $('from').value = toLocalInput(new Date(Date.now() - 7 * 86400000));

  try {
    guilds = await send({ type: 'listGuilds' });
  } catch (e) {
    notice(`Couldn't load your servers: ${e.message}`, 'Retry', init);
    return;
  }
  $('guild').replaceChildren(...guilds.map((g) => Object.assign(document.createElement('option'), { value: g.id, textContent: g.name })));
  if (saved.guild && guilds.some((g) => g.id === saved.guild)) $('guild').value = saved.guild;
  await loadChannels();
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !DISCORD_URL.test(tab.url || '')) {
    notice('Open Discord in your browser (discord.com) and sign in, then click the extension again.',
      'Open Discord', () => chrome.tabs.create({ url: 'https://discord.com/channels/@me' }));
    return;
  }
  tabId = tab.id;

  let status;
  try {
    status = await send({ type: 'status' });
  } catch {
    notice('The Discord tab needs to be reloaded so the exporter can connect to it.',
      'Reload Discord', () => { chrome.tabs.reload(tabId); window.close(); });
    return;
  }
  if (status.job && status.job.state === 'running') return renderJob(status.job);
  if (!status.hasToken) {
    notice("Couldn't detect your Discord session yet. Make sure you're signed in, then reload the tab.",
      'Reload Discord', () => { chrome.tabs.reload(tabId); window.close(); });
    return;
  }
  await showForm();
}

$('guild').addEventListener('change', () => { prefs.save(); $('filter').value = ''; loadChannels(); });
$('filter').addEventListener('input', renderChannels);
$('select-all').addEventListener('click', () => setVisibleChecked(true));
$('select-none').addEventListener('click', () => setVisibleChecked(false));
$('preset').addEventListener('change', () => { updatePreset(); prefs.save(); });
$('format').addEventListener('change', () => prefs.save());
$('cancel').addEventListener('click', () => send({ type: 'cancel' }).catch(() => {}));
$('again').addEventListener('click', () => showForm());

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const error = $('form-error');
  error.hidden = true;
  const range = getRange();
  if (range.from && range.to && range.from > range.to) {
    error.textContent = '"From" must be before "To".';
    error.hidden = false;
    return;
  }
  if (!selected.size) return;
  try {
    await send({ type: 'startExport', channels: [...selected.values()], format: $('format').value, ...range });
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
  }
});

init();
