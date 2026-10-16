# Discord Exporter

A Chrome extension that exports Discord messages from the channels you pick, for the time range you pick.

- Pick channels from any of your servers, or your DMs and group DMs. Your picks are kept when you switch servers, so one export can cover several servers.
- Time range: all time, last 24 hours / 7 days / 30 days / year, or custom start and end dates.
- Formats: **HTML** (a page you can read), **plain text**, **JSON** (all the data) and **CSV** (for spreadsheets).
- One channel downloads as a single file. Several channels download as one `.zip` with a file per channel.
- The export runs inside the Discord tab, so you can close the popup while it works. Reopen the popup to check progress or cancel.

## Install (unpacked)

1. Clone or download this repository.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and choose this folder (the one with `manifest.json`).
4. Open or reload <https://discord.com/app> and sign in.

## Use

1. With a Discord tab active, click the extension icon.
2. Choose a server, then tick the channels you want (use the filter box, **All** or **None**).
3. Choose a time range and a format, then click **Export**.

If the popup says it can't detect your session, reload the Discord tab. This happens when the extension was installed or updated after the tab was opened.

## How it works

- `src/page-hook.js` runs in Discord's page and reads the `Authorization` header that Discord's own web client sends with its API requests.
- `src/content.js` uses that token to call Discord's API (`/api/v9`) from the same tab. It turns the start and end times into message IDs ("snowflakes") and pages through each channel 100 messages at a time, waiting between requests and backing off when Discord rate-limits it.
- `popup/` is the interface. It only sends messages to the content script.

Your token stays in the Discord tab. It is only sent to discord.com, and the extension never stores it.

## Limitations

- Threads and forum posts are not listed yet. Only text, announcement and voice-channel text chats are.
- Channels you can't read are skipped and noted in the log.
- Attachment and image links point to Discord's CDN. Those links expire after a while, so the exported files don't contain copies of the images.
- Automating a user account goes against Discord's Terms of Service. The extension paces its requests like a person scrolling back through history, but use it at your own risk and only on conversations you're allowed to keep.

## Development

```sh
npm test            # unit tests: snowflakes, zip writer, formatters
npm run test:e2e    # loads the extension in Chromium against a mocked Discord (needs Playwright)
npm run package     # builds discord-exporter.zip for the Chrome Web Store
```
