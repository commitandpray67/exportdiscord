const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const EXT = path.resolve(__dirname, '..');
const OUT = path.join(require('os').tmpdir(), 'discord-exporter-e2e');
const { snowflakeFromTime } = require(EXT + '/src/lib/snowflake.js');

const DAY = 86400000;
const now = Date.now();
// 250 messages in c1, one every hour going back; 5 in c2
const msgs = { c1: [], c2: [] };
for (let i = 0; i < 250; i++) {
  const t = now - (250 - i) * 3600000;
  msgs.c1.push({ id: (snowflakeFromTime(t) + BigInt(i)).toString(), type: 0, timestamp: new Date(t).toISOString(),
    author: { id: 'u1', username: 'alice', global_name: 'Alice' }, content: `message ${i}`, mentions: [], attachments: [], embeds: [] });
}
for (let i = 0; i < 5; i++) {
  const t = now - (5 - i) * 60000;
  msgs.c2.push({ id: (snowflakeFromTime(t) + BigInt(i)).toString(), type: 0, timestamp: new Date(t).toISOString(),
    author: { id: 'u2', username: 'bob' }, content: `random ${i}`, mentions: [], attachments: [], embeds: [] });
}
let hits = 0, sawAuth = true;

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT);
  const ctx = await chromium.launchPersistentContext('', {
    headless: true, channel: 'chromium', acceptDownloads: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  await ctx.route('https://discord.com/**', async (route) => {
    const url = new URL(route.request().url());
    const json = (b, s = 200) => route.fulfill({ status: s, contentType: 'application/json', body: JSON.stringify(b) });
    if (!url.pathname.startsWith('/api/')) {
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><body>fake discord<script>
        fetch('/api/v9/users/@me', { headers: { Authorization: 'TOKEN123' } });</script></body>` });
    }
    hits++;
    if (route.request().headers()['authorization'] !== 'TOKEN123') sawAuth = false;
    const p = url.pathname.replace('/api/v9', '');
    if (p === '/users/@me') return json({ id: 'me' });
    if (p === '/users/@me/guilds') return json([{ id: 'g1', name: 'Test Server' }]);
    if (p === '/users/@me/channels') return json([]);
    if (p === '/guilds/g1/channels') return json([
      { id: 'cat', type: 4, name: 'Text', position: 0 },
      { id: 'c1', type: 0, name: 'general', position: 0, parent_id: 'cat' },
      { id: 'c2', type: 0, name: 'random', position: 1, parent_id: 'cat' },
      { id: 'c3', type: 0, name: 'secret', position: 2, parent_id: 'cat' },
    ]);
    const m = p.match(/^\/channels\/(\w+)\/messages$/);
    if (m) {
      if (m[1] === 'c3') return json({ message: 'Missing Access' }, 403);
      const after = BigInt(url.searchParams.get('after') || '0');
      const list = msgs[m[1]].filter((x) => BigInt(x.id) > after).slice(0, 100).reverse();
      return json(list);
    }
    return json({ message: 'not found' }, 404);
  });

  const discord = await ctx.newPage();
  await discord.goto('https://discord.com/channels/@me');
  console.log('hooked:', await discord.evaluate(() => !!window.__discordExporterHooked));
  const extId = require('crypto').createHash('sha256').update(EXT).digest('hex').slice(0, 32)
    .split('').map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');

  const popup = await ctx.newPage();
  await popup.addInitScript(() => {
    const orig = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async () => (await orig({ url: 'https://discord.com/*' }));
  });
  await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
  await popup.selectOption('#guild', 'g1');
  await popup.waitForSelector('#channels label');
  const labels = await popup.$$eval('#channels label', (els) => els.map((e) => e.textContent));
  console.log('channels:', labels);

  // Export 1: general + random + secret, last 7 days, txt -> zip
  await popup.click('#select-all');
  console.log('summary:', await popup.textContent('#selected-summary'));
  await popup.selectOption('#preset', '7');
  await popup.selectOption('#format', 'txt');
  let dl = discord.waitForEvent('download');
  await popup.click('#export');
  let d = await dl;
  let file = path.join(OUT, d.suggestedFilename()); await d.saveAs(file);
  await popup.waitForSelector('#again:not([hidden])');
  console.log('title:', await popup.textContent('#progress-title'), '|', await popup.textContent('#progress-detail'));
  console.log('log:', await popup.$$eval('#log li', (els) => els.map((e) => e.textContent)));
  console.log(execFileSync('unzip', ['-l', file]).toString());
  const general = execFileSync('unzip', ['-p', file, 'Test Server - general.txt']).toString();
  const count = (general.match(/^\[/gm) || []).length;
  console.log('general messages in last 7d:', count, '(expected 168 or 169)');
  console.log(general.split('\n').slice(0, 9).join('\n'));

  // Export 2: only general, custom range, json single file
  await popup.click('#again');
  await popup.click('#select-none');
  await popup.click('#channels label:first-of-type input');
  await popup.selectOption('#preset', 'custom');
  const toLocal = (t) => new Date(t - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  await popup.fill('#from', toLocal(now - 3 * DAY));
  await popup.fill('#to', toLocal(now - 2 * DAY));
  await popup.selectOption('#format', 'json');
  dl = discord.waitForEvent('download');
  await popup.click('#export');
  d = await dl;
  file = path.join(OUT, d.suggestedFilename()); await d.saveAs(file);
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log('json file:', d.suggestedFilename(), 'count', j.messageCount, 'first', j.messages[0].timestamp, 'last', j.messages.at(-1).timestamp);

  // Export 3: html all time
  await popup.waitForSelector('#again:not([hidden])');
  await popup.click('#again');
  await popup.selectOption('#preset', 'all');
  await popup.selectOption('#format', 'html');
  dl = discord.waitForEvent('download');
  await popup.click('#export');
  d = await dl; file = path.join(OUT, d.suggestedFilename()); await d.saveAs(file);
  console.log('html', d.suggestedFilename(), (fs.readFileSync(file, 'utf8').match(/<article/g) || []).length, 'articles');
  await popup.setViewportSize({ width: 360, height: 600 });
  await popup.click('#again');
  await popup.screenshot({ path: path.join(OUT, 'popup.png') });

  console.log('api hits', hits, 'auth always present', sawAuth);
  await ctx.close();
})().catch((e) => { console.error(e); process.exit(1); });
