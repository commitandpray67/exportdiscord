const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { snowflakeFromTime, timeFromSnowflake, compareSnowflakes } = require('../src/lib/snowflake.js');
const { createZip } = require('../src/lib/zip.js');
const F = require('../src/lib/formatters.js');

test('snowflake round-trips timestamps', () => {
  const t = Date.UTC(2024, 0, 2, 3, 4, 5);
  assert.strictEqual(timeFromSnowflake(snowflakeFromTime(t)), t);
  // A known Discord ID: 175928847299117063 was created 2016-04-30T11:18:25.796Z
  assert.strictEqual(new Date(timeFromSnowflake('175928847299117063')).toISOString(), '2016-04-30T11:18:25.796Z');
  assert.strictEqual(snowflakeFromTime(0), 0n);
  assert.strictEqual(compareSnowflakes('99', '100'), -1);
});

test('zip is readable by unzip', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxzip-'));
  const file = path.join(dir, 'out.zip');
  fs.writeFileSync(file, createZip([
    { name: 'Server - général.txt', data: 'héllo 👋\n' },
    { name: 'b.json', data: '{"a":1}' },
  ]));
  const out = execFileSync('unzip', ['-t', file]).toString();
  assert.match(out, /No errors detected/);
  assert.strictEqual(execFileSync('unzip', ['-p', file, 'b.json']).toString(), '{"a":1}');
});

const raw = {
  id: '1', type: 0, timestamp: '2024-01-02T03:04:05.000Z', edited_timestamp: null,
  author: { id: '10', username: 'alice', global_name: 'Alice' },
  content: 'hi <@20>, see <#30> & "quotes", <b>',
  mentions: [{ id: '20', username: 'bob', global_name: null }],
  attachments: [{ id: 'a', filename: 'cat.png', url: 'https://cdn/cat.png', size: 5, content_type: 'image/png' }],
  reactions: [{ emoji: { id: null, name: '👍' }, count: 2 }],
  message_reference: { message_id: '0' },
  referenced_message: { id: '0', author: { id: '20', username: 'bob' }, content: 'earlier' },
};

const exp = () => ({
  guildName: 'Guild', channelName: 'general', channelId: '30',
  range: { from: null, to: null }, exportedAt: '2024-01-03T00:00:00.000Z',
  messages: [F.normalizeMessage(raw)], channelNames: { 30: 'general' },
});

test('normalizes messages', () => {
  const m = F.normalizeMessage(raw);
  assert.strictEqual(m.author.globalName, 'Alice');
  assert.deepStrictEqual(m.reactions, [{ emoji: '👍', count: 2 }]);
  assert.strictEqual(m.replyTo.author.username, 'bob');
});

test('text and csv resolve mentions and escape', () => {
  const txt = F.toText(exp());
  assert.match(txt, /hi @bob, see #general/);
  assert.match(txt, /replying to bob: earlier/);
  const csv = F.toCSV(exp());
  assert.match(csv, /"hi @bob, see #general & ""quotes"", <b>"/);
});

test('html escapes content', () => {
  const html = F.toHTML(exp());
  assert.match(html, /&lt;b&gt;/);
  assert.doesNotMatch(html, /<b>/);
  assert.match(html, /<img src="https:\/\/cdn\/cat.png"/);
});

test('json is valid', () => {
  const j = JSON.parse(F.toJSON(exp()));
  assert.strictEqual(j.messageCount, 1);
});
