// Turns Discord API messages into a normalized shape and renders exports
// as JSON, plain text, CSV or standalone HTML.
(function (root) {
  function normalizeMessage(m) {
    const user = (u) => u && {
      id: u.id,
      username: u.username,
      globalName: u.global_name ?? null,
      bot: !!u.bot,
    };
    const ref = m.referenced_message;
    return {
      id: m.id,
      type: m.type,
      timestamp: m.timestamp,
      editedTimestamp: m.edited_timestamp ?? null,
      pinned: !!m.pinned,
      author: user(m.author),
      content: m.content ?? '',
      attachments: (m.attachments || []).map((a) => ({
        id: a.id,
        filename: a.filename,
        url: a.url,
        size: a.size,
        contentType: a.content_type ?? null,
      })),
      embeds: m.embeds || [],
      stickers: (m.sticker_items || []).map((s) => ({ id: s.id, name: s.name })),
      reactions: (m.reactions || []).map((r) => ({
        emoji: r.emoji && r.emoji.id ? `:${r.emoji.name}:` : (r.emoji && r.emoji.name) || '?',
        count: r.count,
      })),
      mentions: (m.mentions || []).map(user),
      replyTo: m.message_reference && m.message_reference.message_id
        ? {
            id: m.message_reference.message_id,
            author: ref ? user(ref.author) : null,
            content: ref ? (ref.content || '').slice(0, 200) : null,
          }
        : null,
    };
  }

  const displayName = (u) => (u ? u.globalName || u.username : 'Unknown');

  // Replace <@id> / <#id> tokens with readable names where we know them.
  function resolveMentions(text, message, channelNames = {}) {
    const users = {};
    for (const u of message.mentions || []) if (u) users[u.id] = displayName(u);
    return text
      .replace(/<@!?(\d+)>/g, (s, id) => (users[id] ? `@${users[id]}` : s))
      .replace(/<#(\d+)>/g, (s, id) => (channelNames[id] ? `#${channelNames[id]}` : s));
  }

  const pad = (n) => String(n).padStart(2, '0');
  function formatDate(value) {
    const d = new Date(value);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
      `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function describeRange(range) {
    const from = range.from ? formatDate(range.from) : 'the beginning';
    const to = range.to ? formatDate(range.to) : 'now';
    return `${from} → ${to}`;
  }

  // export: { guildName, channelName, channelId, range: {from, to}, exportedAt, messages, channelNames }
  function toJSON(exp) {
    return JSON.stringify({
      exportedAt: exp.exportedAt,
      guild: exp.guildName,
      channel: { id: exp.channelId, name: exp.channelName },
      range: {
        from: exp.range.from ? new Date(exp.range.from).toISOString() : null,
        to: exp.range.to ? new Date(exp.range.to).toISOString() : null,
      },
      messageCount: exp.messages.length,
      messages: exp.messages,
    }, null, 2);
  }

  function toText(exp) {
    const lines = [
      `Server:   ${exp.guildName}`,
      `Channel:  ${exp.channelName}`,
      `Range:    ${describeRange(exp.range)}`,
      `Exported: ${formatDate(exp.exportedAt)}`,
      `Messages: ${exp.messages.length}`,
      '='.repeat(60),
      '',
    ];
    for (const m of exp.messages) {
      let header = `[${formatDate(m.timestamp)}] ${displayName(m.author)}`;
      if (m.author && m.author.globalName && m.author.globalName !== m.author.username) {
        header += ` (@${m.author.username})`;
      }
      if (m.editedTimestamp) header += ' (edited)';
      if (m.pinned) header += ' (pinned)';
      lines.push(header);
      if (m.replyTo) {
        const who = m.replyTo.author ? displayName(m.replyTo.author) : 'a message';
        lines.push(`  ↪ replying to ${who}${m.replyTo.content ? `: ${m.replyTo.content.split('\n')[0]}` : ''}`);
      }
      if (m.content) {
        for (const l of resolveMentions(m.content, m, exp.channelNames).split('\n')) lines.push(`  ${l}`);
      }
      for (const a of m.attachments) lines.push(`  [Attachment: ${a.filename}] ${a.url}`);
      for (const s of m.stickers) lines.push(`  [Sticker: ${s.name}]`);
      if (m.embeds.length) lines.push(`  [${m.embeds.length} embed(s)]`);
      if (m.reactions.length) {
        lines.push(`  Reactions: ${m.reactions.map((r) => `${r.emoji} ${r.count}`).join('  ')}`);
      }
      lines.push('');
    }
    return lines.join('\n');
  }

  function csvCell(value) {
    const s = value == null ? '' : String(value);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function toCSV(exp) {
    const header = ['message_id', 'timestamp', 'author_id', 'author_username', 'author_display_name',
      'content', 'attachments', 'reactions', 'edited_timestamp', 'reply_to_message_id', 'pinned'];
    const rows = exp.messages.map((m) => [
      m.id,
      m.timestamp,
      m.author && m.author.id,
      m.author && m.author.username,
      displayName(m.author),
      resolveMentions(m.content, m, exp.channelNames),
      m.attachments.map((a) => a.url).join(' '),
      m.reactions.map((r) => `${r.emoji} ${r.count}`).join(' '),
      m.editedTimestamp,
      m.replyTo && m.replyTo.id,
      m.pinned,
    ]);
    // Leading BOM so Excel opens the file as UTF-8.
    return '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
  }

  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
  }

  function linkify(escaped) {
    return escaped.replace(/https?:\/\/[^\s<]+/g, (url) => `<a href="${url}" target="_blank" rel="noopener">${url}</a>`);
  }

  function toHTML(exp) {
    const body = exp.messages.map((m) => {
      const parts = [];
      parts.push(`<div class="meta"><span class="author">${escapeHTML(displayName(m.author))}</span>` +
        (m.author && m.author.bot ? '<span class="bot">BOT</span>' : '') +
        `<time datetime="${escapeHTML(m.timestamp)}">${escapeHTML(formatDate(m.timestamp))}</time>` +
        (m.editedTimestamp ? '<span class="dim">(edited)</span>' : '') + '</div>');
      if (m.replyTo) {
        const who = m.replyTo.author ? displayName(m.replyTo.author) : 'a message';
        parts.push(`<div class="reply">↪ ${escapeHTML(who)}${m.replyTo.content ? `: ${escapeHTML(m.replyTo.content.split('\n')[0])}` : ''}</div>`);
      }
      if (m.content) {
        parts.push(`<div class="content">${linkify(escapeHTML(resolveMentions(m.content, m, exp.channelNames))).replace(/\n/g, '<br>')}</div>`);
      }
      for (const a of m.attachments) {
        const url = escapeHTML(a.url);
        if (a.contentType && a.contentType.startsWith('image/')) {
          parts.push(`<a href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="${escapeHTML(a.filename)}" loading="lazy"></a>`);
        } else {
          parts.push(`<div class="attachment">📎 <a href="${url}" target="_blank" rel="noopener">${escapeHTML(a.filename)}</a></div>`);
        }
      }
      if (m.reactions.length) {
        parts.push(`<div class="reactions">${m.reactions.map((r) => `<span>${escapeHTML(r.emoji)} ${r.count}</span>`).join('')}</div>`);
      }
      return `<article id="m${m.id}">${parts.join('')}</article>`;
    }).join('\n');

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHTML(exp.guildName)} – #${escapeHTML(exp.channelName)}</title>
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#2e3338; --dim:#747f8d; --line:#e3e5e8; --accent:#5865f2; }
  @media (prefers-color-scheme: dark) { :root { --bg:#313338; --fg:#dbdee1; --dim:#949ba4; --line:#3f4147; --accent:#949cf7; } }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.45 system-ui, sans-serif; }
  header { padding:16px 20px; border-bottom:1px solid var(--line); }
  header h1 { margin:0 0 4px; font-size:18px; }
  header p { margin:0; color:var(--dim); font-size:13px; }
  main { padding:8px 20px 40px; max-width:900px; }
  article { padding:8px 0; border-bottom:1px solid var(--line); overflow-wrap:anywhere; }
  .meta { display:flex; gap:8px; align-items:baseline; }
  .author { font-weight:600; }
  .bot { background:var(--accent); color:#fff; font-size:10px; padding:0 4px; border-radius:3px; }
  time, .dim { color:var(--dim); font-size:12px; }
  .reply { color:var(--dim); font-size:13px; }
  .content { margin-top:2px; }
  img { max-width:min(400px,100%); max-height:300px; border-radius:4px; margin-top:4px; display:block; }
  a { color:var(--accent); }
  .reactions span { display:inline-block; margin:4px 4px 0 0; padding:0 6px; border:1px solid var(--line); border-radius:8px; font-size:13px; }
</style>
</head>
<body>
<header>
  <h1>${escapeHTML(exp.guildName)} – #${escapeHTML(exp.channelName)}</h1>
  <p>${escapeHTML(describeRange(exp.range))} · ${exp.messages.length} messages · exported ${escapeHTML(formatDate(exp.exportedAt))}</p>
</header>
<main>
${body}
</main>
</body>
</html>
`;
  }

  const FORMATS = {
    json: { ext: 'json', mime: 'application/json', render: toJSON },
    txt: { ext: 'txt', mime: 'text/plain', render: toText },
    csv: { ext: 'csv', mime: 'text/csv', render: toCSV },
    html: { ext: 'html', mime: 'text/html', render: toHTML },
  };

  const api = { normalizeMessage, resolveMentions, formatDate, FORMATS, toJSON, toText, toCSV, toHTML };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DXFormatters = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
