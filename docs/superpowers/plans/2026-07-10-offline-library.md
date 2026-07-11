# WatchTime Offline Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nightly yt-dlp job on the Mac uploads a small curated video library to Vercel Blob; devices with a PIN-gated opt-in toggle sync it ahead of car trips (iPhone PWA via OPFS, Fire 7 via Capacitor Filesystem) and play local files through a `<video>` tag, while unconfigured devices keep today's exact YouTube experience.

**Architecture:** Three phases sharing one contract (`manifest.json` in the Blob store). Phase 1: Mac downloader → Blob. Phase 2: PWA sync + hybrid player. Phase 3: Fire native adapter. The wife-invariant rules everything: the feature is dead code unless `localStorage.wt_offline_enabled === '1'` on that specific device.

**Tech Stack:** Node 18+ (`scripts/library-sync.mjs`, ESM), yt-dlp (installed, pyenv shim) + ffmpeg, `@vercel/blob` SDK, launchd, OPFS (`navigator.storage.getDirectory`), Capacitor 8 Filesystem plugin.

**Spec:** `docs/superpowers/specs/2026-07-10-offline-library-design.md`

**Verification style:** No test framework exists in this repo (per CLAUDE.md, single-file app, no build step). Tasks verify via `--dry-run` modes, `node --check`, curl, and scripted assertions specified exactly. On-device steps are collaborative (David).

---

### Task 0: Merge reviewed branch work and start the offline-library branch

The `capacitor-app` branch holds completed, reviewed, production-deployed work (CORS, IS_NATIVE/API_BASE, Capacitor scaffold, .vercelignore, both specs). The offline work builds on it.

**Files:** none (git only)

- [x] **Step 1: Merge and branch**

```bash
cd /Users/davidhague/source/pwa-watchtime-youtube
git checkout main
git merge --no-ff capacitor-app -m "Merge capacitor-app: CORS, API_BASE plumbing, Capacitor scaffold, specs"
git checkout -b offline-library
```

Expected: clean merge (main has no divergent commits), new branch `offline-library`.

- [x] **Step 2: Verify**

```bash
git log --oneline -3 && git branch --show-current
```

Expected: merge commit on top, branch `offline-library`.

---

### Task 1: Vercel Blob store + config contract

**Files:**
- Create: `scripts/library-config.json` (public base URL — not a secret)
- Modify: `.env.local` (gains `BLOB_READ_WRITE_TOKEN` via `vercel env pull` — never committed)

- [x] **Step 1: Create the Blob store and connect it to this project**

```bash
npx vercel blob store add watchtime-library
```

Follow the CLI prompts to connect it to the linked project (`pwa-watchtime-youtube`). If the CLI version doesn't support store creation, report BLOCKED with instructions for David: Vercel dashboard → Storage → Create → Blob → name `watchtime-library` → Connect to project.

- [x] **Step 2: Pull the token locally**

```bash
npx vercel env pull .env.local
grep -c "BLOB_READ_WRITE_TOKEN" .env.local
```

Expected: `1`.

- [x] **Step 3: Discover the store's public base URL and record it**

```bash
node --input-type=module -e "
import { put } from '@vercel/blob';
import fs from 'node:fs';
const env = fs.readFileSync('.env.local','utf8');
const token = env.match(/BLOB_READ_WRITE_TOKEN=\"?([^\"\n]+)/)[1];
const b = await put('probe.txt', 'watchtime', { access: 'public', addRandomSuffix: false, allowOverwrite: true, token });
console.log(b.url);
"
```

(`@vercel/blob` must be installed first: `npm install @vercel/blob`.) Take the printed URL, strip the `/probe.txt` suffix, and write `scripts/library-config.json`:

```json
{
  "blobBaseUrl": "https://<store-id>.public.blob.vercel-storage.com"
}
```

- [x] **Step 4: Verify public access + CORS (the PWA depends on this)**

```bash
curl -sI "<blobBaseUrl>/probe.txt" | grep -iE "access-control-allow-origin|content-type|accept-ranges"
```

Expected: `access-control-allow-origin: *` present. If the CORS header is absent, STOP and report BLOCKED — the whole device-sync design assumes public blobs are CORS-readable; the controller must revisit serving before Phase 2.

- [x] **Step 5: Clean up probe, commit**

```bash
node --input-type=module -e "
import { del } from '@vercel/blob';
import fs from 'node:fs';
const token = fs.readFileSync('.env.local','utf8').match(/BLOB_READ_WRITE_TOKEN=\"?([^\"\n]+)/)[1];
await del('<blobBaseUrl>/probe.txt', { token });
"
git add scripts/library-config.json package.json package-lock.json
git commit -m "Add Vercel Blob store config for offline library"
```

---

### Task 2: Downloader script (`scripts/library-sync.mjs`)

**Files:**
- Create: `scripts/library-sync.mjs`

The complete script. Selection rules from the spec: channels → newest 3 from `/videos` tab (Shorts-free by construction); playlists → 3 persistent picks, replaced only when the pick disappears upstream, is detected watched-to-completion (was in watch-history last run, absent now), or `--rotate` is passed.

- [x] **Step 1: Write the script**

```js
#!/usr/bin/env node
// WatchTime offline library builder. Downloads a small curated set of videos
// with yt-dlp, uploads to Vercel Blob, regenerates manifest.json.
// Usage: node scripts/library-sync.mjs [--dry-run] [--rotate]
// Env: BLOB_READ_WRITE_TOKEN (read from .env.local if unset), WT_LIBRARY_DIR
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { put, list, del } from '@vercel/blob';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API = 'https://pwa-watchtime-youtube.vercel.app';
const PER_FEED = 3;
const MAX_TOTAL_BYTES = 10 * 1024 ** 3;
const LIB = process.env.WT_LIBRARY_DIR || path.join(os.homedir(), 'WatchTime-Library');
const VIDEOS_DIR = path.join(LIB, 'videos');
const STATE_FILE = path.join(LIB, 'state.json');
const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'library-config.json'), 'utf8'));
const DRY = process.argv.includes('--dry-run');
const ROTATE = process.argv.includes('--rotate');
// launchd has a bare PATH; make sure yt-dlp's pyenv shim and ffmpeg are findable.
process.env.PATH = `${os.homedir()}/.pyenv/shims:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}`;

function token() {
  if (process.env.BLOB_READ_WRITE_TOKEN) return process.env.BLOB_READ_WRITE_TOKEN;
  const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
  return env.match(/BLOB_READ_WRITE_TOKEN="?([^"\n]+)/)[1];
}
const TOKEN = token();

const log = (...a) => console.log(new Date().toISOString(), ...a);

function ytdlp(args) {
  return execFileSync('yt-dlp', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function listFeed(feedId, limit) {
  const base = feedId.startsWith('PL')
    ? `https://www.youtube.com/playlist?list=${feedId}`
    : `https://www.youtube.com/channel/${feedId}/videos`;
  const args = ['--flat-playlist', '--print', '%(id)s\t%(title)s', base];
  if (limit) args.splice(1, 0, '--playlist-end', String(limit));
  return ytdlp(args).trim().split('\n').filter(Boolean).map(line => {
    const [id, ...t] = line.split('\t');
    return { videoId: id, title: t.join('\t') };
  });
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { playlistPicks: {}, trackedHistory: [] }; }
}

async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

function choosePlaylistPicks(feedId, upstream, state, completedIds) {
  const upstreamIds = new Set(upstream.map(v => v.videoId));
  let picks = (state.playlistPicks[feedId] || []).filter(id =>
    upstreamIds.has(id) && !completedIds.has(id) && !ROTATE);
  const pool = upstream.filter(v => !picks.includes(v.videoId));
  while (picks.length < PER_FEED && pool.length) {
    const i = Math.floor(Math.random() * pool.length);
    picks.push(pool.splice(i, 1)[0].videoId);
  }
  state.playlistPicks[feedId] = picks;
  return upstream.filter(v => picks.includes(v.videoId));
}

function download(videoId) {
  const mp4 = path.join(VIDEOS_DIR, `${videoId}.mp4`);
  if (!fs.existsSync(mp4)) {
    log('downloading', videoId);
    ytdlp([
      '-f', 'bv*[height<=720][vcodec^=avc1]+ba[acodec^=mp4a]/b[height<=720]',
      '--merge-output-format', 'mp4', '--write-info-json',
      '--write-thumbnail', '--convert-thumbnails', 'jpg', '--no-progress',
      '-o', path.join(VIDEOS_DIR, '%(id)s.%(ext)s'),
      `https://www.youtube.com/watch?v=${videoId}`,
    ]);
  }
  const info = JSON.parse(fs.readFileSync(path.join(VIDEOS_DIR, `${videoId}.info.json`), 'utf8'));
  return { size: fs.statSync(mp4).size, duration: Math.floor(info.duration || 0) };
}

async function uploadIfMissing(pathname, filePath, contentType, existing) {
  if (existing.has(pathname)) return `${CONFIG.blobBaseUrl}/${pathname}`;
  log('uploading', pathname);
  const b = await put(pathname, fs.createReadStream(filePath), {
    access: 'public', addRandomSuffix: false, allowOverwrite: true,
    contentType, multipart: true, token: TOKEN,
  });
  return b.url;
}

async function listAllBlobs() {
  const out = new Map();
  let cursor;
  do {
    const page = await list({ token: TOKEN, cursor, limit: 1000 });
    for (const b of page.blobs) out.set(b.pathname, b.url);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return out;
}

async function main() {
  fs.mkdirSync(VIDEOS_DIR, { recursive: true });
  try { log('yt-dlp self-update:', ytdlp(['-U']).trim().split('\n').pop()); }
  catch (e) { log('yt-dlp -U failed (non-fatal):', e.message.slice(0, 200)); }
  log('yt-dlp version:', ytdlp(['--version']).trim());

  const cfg = await getJson(`${API}/api/config`);
  const history = await getJson(`${API}/api/watch-history`);
  const state = loadState();
  // Entries we saw in history last run but are gone now = watched to completion.
  const completedIds = new Set(state.trackedHistory.filter(id => !(id in history)));

  const desired = []; // { videoId, title, channelId, channelName }
  for (const feed of cfg.channels) {
    try {
      const isPlaylist = feed.id.startsWith('PL');
      const upstream = listFeed(feed.id, isPlaylist ? 0 : PER_FEED);
      const picks = isPlaylist
        ? choosePlaylistPicks(feed.id, upstream, state, completedIds)
        : upstream.slice(0, PER_FEED);
      for (const v of picks) desired.push({ ...v, channelId: feed.id, channelName: feed.name });
    } catch (e) {
      log(`FEED FAILED ${feed.name} (${feed.id}):`, e.message.slice(0, 300));
    }
  }
  log(`selected ${desired.length} videos:`, desired.map(v => v.videoId).join(', '));
  if (DRY) { console.log(JSON.stringify(desired, null, 2)); return; }

  const manifest = { generatedAt: new Date().toISOString(), videos: [] };
  let totalBytes = 0;
  const existing = await listAllBlobs();
  for (const v of desired) {
    try {
      const { size, duration } = download(v.videoId);
      if (totalBytes + size > MAX_TOTAL_BYTES) { log('SKIP (cap reached)', v.videoId); continue; }
      totalBytes += size;
      const url = await uploadIfMissing(`videos/${v.videoId}.mp4`, path.join(VIDEOS_DIR, `${v.videoId}.mp4`), 'video/mp4', existing);
      const thumbFile = path.join(VIDEOS_DIR, `${v.videoId}.jpg`);
      const thumbUrl = fs.existsSync(thumbFile)
        ? await uploadIfMissing(`thumbs/${v.videoId}.jpg`, thumbFile, 'image/jpeg', existing)
        : null;
      manifest.videos.push({ ...v, duration, size, url, thumbUrl, downloadedAt: new Date().toISOString() });
    } catch (e) {
      log(`VIDEO FAILED ${v.videoId}:`, e.message.slice(0, 300));
    }
  }

  await put('manifest.json', JSON.stringify(manifest, null, 2), {
    access: 'public', addRandomSuffix: false, allowOverwrite: true,
    contentType: 'application/json', cacheControlMaxAge: 60, token: TOKEN,
  });
  log(`manifest uploaded: ${manifest.videos.length} videos, ${(totalBytes / 1e9).toFixed(2)} GB`);

  // Evict blobs and local files no longer desired.
  const keep = new Set(['manifest.json',
    ...manifest.videos.map(v => `videos/${v.videoId}.mp4`),
    ...manifest.videos.filter(v => v.thumbUrl).map(v => `thumbs/${v.videoId}.jpg`)]);
  for (const [pathname, url] of existing) {
    if (!keep.has(pathname)) { log('evicting blob', pathname); await del(url, { token: TOKEN }); }
  }
  const keepIds = new Set(manifest.videos.map(v => v.videoId));
  for (const f of fs.readdirSync(VIDEOS_DIR)) {
    const id = f.replace(/\.(mp4|jpg|info\.json)$/, '');
    if (!keepIds.has(id)) fs.rmSync(path.join(VIDEOS_DIR, f));
  }

  state.trackedHistory = Object.keys(history);
  fs.mkdirSync(LIB, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  log('done');
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
```

- [x] **Step 2: Syntax check + dry run**

```bash
node --check scripts/library-sync.mjs
ffmpeg -version | head -1   # prereq: if missing, report BLOCKED (David: brew install ffmpeg)
node scripts/library-sync.mjs --dry-run
```

Expected: dry run logs yt-dlp version, prints ~9 selected videos (3 per configured feed) as JSON, uploads nothing. Feed listing failures print `FEED FAILED` but don't crash.

- [x] **Step 3: First real run**

```bash
node scripts/library-sync.mjs
```

Expected (several minutes): downloads to `~/WatchTime-Library/videos/`, uploads each mp4 + jpg, uploads manifest, logs total GB, evicts nothing (first run). Then verify the contract:

```bash
curl -s "$(node -p "JSON.parse(require('fs').readFileSync('scripts/library-config.json')).blobBaseUrl")/manifest.json" | node -p "const m=JSON.parse(require('fs').readFileSync(0)); m.videos.length + ' videos, first: ' + m.videos[0].title + ' @ ' + m.videos[0].url"
curl -sI "$(node -p "JSON.parse(require('fs').readFileSync('scripts/library-config.json')).blobBaseUrl")/manifest.json" | grep -i cache-control
```

Expected: video count ≥ 1 with real title/URL; manifest cache-control max-age=60. Spot-check one video URL with `curl -sI` → `200`, `content-type: video/mp4`, `accept-ranges: bytes`.

- [x] **Step 4: Idempotency check**

Re-run `node scripts/library-sync.mjs`. Expected: no re-downloads (files exist), no re-uploads (`existing` map hits), same manifest count, `done`.

- [x] **Step 5: Commit**

```bash
git add scripts/library-sync.mjs
git commit -m "Add nightly library downloader: yt-dlp -> Vercel Blob + manifest"
```

---

### Task 3: launchd schedule + logs + dashboard registration

**Files:**
- Create: `~/Library/LaunchAgents/com.davidhague.watchtime-library.plist` (outside repo)
- Create: `scripts/library-sync-launchd.sh` (repo — wrapper so launchd has env + logging)

- [x] **Step 1: Wrapper script**

```bash
#!/usr/bin/env bash
# launchd entrypoint for the nightly WatchTime library sync.
set -uo pipefail
cd "$(dirname "$0")/.."
mkdir -p "$HOME/WatchTime-Library/logs"
LOG="$HOME/WatchTime-Library/logs/$(date +%Y-%m-%d).log"
/usr/bin/env node scripts/library-sync.mjs >> "$LOG" 2>&1
echo "exit=$? $(date -u +%FT%TZ)" >> "$LOG"
```

`chmod +x scripts/library-sync-launchd.sh`

- [x] **Step 2: launchd plist** (write to `~/Library/LaunchAgents/com.davidhague.watchtime-library.plist`)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.davidhague.watchtime-library</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string>
    <string>/Users/davidhague/source/pwa-watchtime-youtube/scripts/library-sync-launchd.sh</string>
  </array>
  <key>StartCalendarInterval</key><dict>
    <key>Hour</key><integer>3</integer><key>Minute</key><integer>30</integer>
  </dict>
  <key>StandardOutPath</key><string>/tmp/watchtime-library.launchd.log</string>
  <key>StandardErrorPath</key><string>/tmp/watchtime-library.launchd.log</string>
</dict></plist>
```

Load: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.davidhague.watchtime-library.plist` (if already loaded, `launchctl bootout` first).

- [x] **Step 3: Kick a manual run through launchd and verify**

```bash
launchctl kickstart gui/$(id -u)/com.davidhague.watchtime-library
sleep 90 && tail -5 ~/WatchTime-Library/logs/$(date +%Y-%m-%d).log
```

Expected: log ends with `done` and `exit=0` (fast because idempotent).

- [x] **Step 4: Register in the jobs dashboard**

If `~/source/local-dashboard` exists and has a jobs registry (`jobs.yml` or similar), add an entry for `com.davidhague.watchtime-library` (nightly 03:30, log path above) following the registry's existing format; otherwise note in the report that David should run his `/local-dashboard-update` flow.

- [x] **Step 5: Commit**

```bash
git add scripts/library-sync-launchd.sh
git commit -m "Add launchd wrapper for nightly library sync"
```

---

### Task 4: Offline toggle + settings UI (PWA, feature invisible by default)

**Files:**
- Modify: `index.html` (settings screen markup + JS)

- [x] **Step 1: Constants** — in the CONFIG section of `index.html`, directly under the `API_BASE` line, add (substituting the real base URL from `scripts/library-config.json`):

```js
const LIB_BASE = 'https://<store-id>.public.blob.vercel-storage.com';
const MANIFEST_URL = LIB_BASE + '/manifest.json';
const offlineEnabled = () => localStorage.getItem('wt_offline_enabled') === '1';
```

- [x] **Step 2: Settings markup** — in the settings screen, after the `s-group` div containing "Parent PIN" and before the "Channels" group, add:

```html
<div class="s-group">
  <h3>Offline Library (this device only)</h3>
  <div class="s-row">
    <span class="label">Enable offline videos</span>
    <input type="checkbox" id="offlineToggle" style="width:auto;margin:0;transform:scale(1.4);">
  </div>
  <div id="offlinePanel" class="hidden">
    <button class="btn btn-primary btn-block" id="syncBtn" style="margin:6px 0;">⬇ Sync now</button>
    <div class="s-hint" id="syncStatus">Not synced yet</div>
    <div class="s-hint" id="syncUsage"></div>
  </div>
</div>
```

- [x] **Step 3: Wire the toggle** — in the settings JS (near `openSettings`), add:

```js
function renderOfflinePanel() {
  $('offlineToggle').checked = offlineEnabled();
  $('offlinePanel').classList.toggle('hidden', !offlineEnabled());
  const at = +localStorage.getItem('wt_lib_synced_at') || 0;
  $('syncStatus').textContent = at ? `Last synced ${new Date(at).toLocaleString()}` : 'Not synced yet';
  if (offlineEnabled()) updateSyncUsage();
}
async function updateSyncUsage() {
  try {
    const n = (await libStore.names()).filter(x => x.endsWith('.mp4')).length;
    const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
    $('syncUsage').textContent = `${n} videos on device` + (est ? ` · ${(est.usage / 1e9).toFixed(2)} GB used` : '');
  } catch(e) { $('syncUsage').textContent = ''; }
}
$('offlineToggle').onchange = function() {
  localStorage.setItem('wt_offline_enabled', this.checked ? '1' : '0');
  renderOfflinePanel();
};
```

and call `renderOfflinePanel();` inside `openSettings()` after `renderSettingsChannels();`. (`libStore` arrives in Task 5; until then Step 4's verification only covers the toggle row.)

- [x] **Step 4: Verify invariant + no web regression**

With `vercel dev`: settings shows the new group; toggle off (default) hides the panel; nothing else in the app changes (grid/player untouched — grep that `wt_offline_enabled` is only read via `offlineEnabled()` and only used in settings so far). `node --check` on the extracted inline script passes.

- [x] **Step 5: Commit**

```bash
git add index.html && git commit -m "Add per-device offline library toggle in PIN-gated settings"
```

---

### Task 5: OPFS storage adapter + sync engine (PWA)

**Files:**
- Modify: `index.html`

- [x] **Step 1: Adapter + in-memory index** — add a new `// OFFLINE LIBRARY` section in the JS before the `// SETTINGS` section:

```js
let libIds = new Set(); // videoIds present on this device

const opfsStore = {
  supported: () => !!(navigator.storage && navigator.storage.getDirectory),
  async dir() {
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle('library', { create: true });
  },
  async names() {
    if (!this.supported()) return [];
    const d = await this.dir(); const out = [];
    for await (const name of d.keys()) out.push(name);
    return out;
  },
  async save(name, url, onProgress) {
    const d = await this.dir();
    const fh = await d.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    const resp = await fetch(url);
    if (!resp.ok) { await w.abort(); throw new Error('HTTP ' + resp.status); }
    const total = +resp.headers.get('Content-Length') || 0;
    const reader = resp.body.getReader();
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await w.write(value);
      got += value.length;
      if (onProgress && total) onProgress(got / total);
    }
    await w.close();
  },
  async fileUrl(name) {
    const d = await this.dir();
    const fh = await d.getFileHandle(name);
    return URL.createObjectURL(await fh.getFile());
  },
  async remove(name) { const d = await this.dir(); await d.removeEntry(name).catch(() => {}); },
};
let libStore = opfsStore; // Task 9 swaps in the Capacitor adapter when IS_NATIVE

function getLibManifest() {
  try { return JSON.parse(localStorage.getItem('wt_lib_manifest')); } catch(e) { return null; }
}
async function refreshLibIds() {
  libIds = new Set((await libStore.names()).filter(n => n.endsWith('.mp4')).map(n => n.slice(0, -4)));
}
```

- [x] **Step 2: Sync engine** (same section):

```js
async function syncLibrary(onStatus) {
  if (!libStore.supported()) throw new Error('Offline storage not supported on this device');
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  const resp = await fetch(MANIFEST_URL + '?t=' + Date.now());
  if (!resp.ok) throw new Error('Could not reach library (' + resp.status + ')');
  const manifest = await resp.json();
  localStorage.setItem('wt_lib_manifest', JSON.stringify(manifest));
  const want = new Set(manifest.videos.flatMap(v => [`${v.videoId}.mp4`, `${v.videoId}.jpg`]));
  for (const name of await libStore.names()) {
    if (!want.has(name)) await libStore.remove(name);
  }
  let done = 0;
  for (const v of manifest.videos) {
    done++;
    const label = `${done}/${manifest.videos.length} ${v.title.slice(0, 40)}`;
    if (!libIds.has(v.videoId)) {
      onStatus(`⬇ ${label}`);
      await libStore.save(`${v.videoId}.mp4`, v.url, p => onStatus(`⬇ ${label} — ${Math.round(p * 100)}%`));
      if (v.thumbUrl) await libStore.save(`${v.videoId}.jpg`, v.thumbUrl).catch(() => {});
    }
  }
  await refreshLibIds();
  localStorage.setItem('wt_lib_synced_at', String(Date.now()));
  onStatus('Up to date ✓');
}
```

- [x] **Step 3: Wire the Sync button** (in the settings JS from Task 4):

```js
$('syncBtn').onclick = async () => {
  $('syncBtn').disabled = true;
  try {
    await syncLibrary(msg => { $('syncStatus').textContent = msg; });
  } catch(e) {
    $('syncStatus').textContent = '⚠ ' + e.message;
  }
  $('syncBtn').disabled = false;
  updateSyncUsage();
};
```

Also call `refreshLibIds().catch(() => {})` when offline is enabled, inside the init IIFE (after `watchHistory = wh || {};`):

```js
if (offlineEnabled()) refreshLibIds().catch(() => {});
```

- [x] **Step 4: Verify in a desktop browser** (Chrome supports OPFS; `vercel dev`): enable toggle in settings → Sync now → status advances per video → "Up to date ✓" → usage line shows N videos. DevTools → Application → Storage shows OPFS `library/` entries. Re-click Sync → completes in ~1s (no re-downloads). Disable network (DevTools offline) → Sync shows `⚠ Could not reach library` and existing files remain.

- [x] **Step 5: Commit**

```bash
git add index.html && git commit -m "Add OPFS storage adapter and library sync engine"
```

---

### Task 6: Local `<video>` player path + card badges

**Files:**
- Modify: `index.html`

- [x] **Step 1: Position-sampling abstraction** — `startSession()`'s interval and `saveCurrentVideoProgress()` both read `ytPlayer` directly today. Add near the player code:

```js
let localVideoEl = null;
function getPlaybackState() {
  if (localVideoEl) {
    return { pos: localVideoEl.currentTime || 0, dur: localVideoEl.duration || 0 };
  }
  if (ytPlayer) {
    try { return { pos: ytPlayer.getCurrentTime() || 0, dur: ytPlayer.getDuration() || 0 }; } catch(e) {}
  }
  return null;
}
```

Replace the sampling block inside `startSession()`'s interval:

```js
    const st = getPlaybackState();
    if (st && currentVideo) {
      if (st.pos > 0) currentVideo.lastPosition = Math.max(currentVideo.lastPosition, Math.floor(st.pos));
      if (st.dur > 0) currentVideo.duration = Math.floor(st.dur);
    }
```

and the equivalent block at the top of `saveCurrentVideoProgress()` (same replacement, using `getPlaybackState()` instead of direct `ytPlayer` access).

- [x] **Step 2: Local player** — add alongside `createPlayer`:

```js
async function playLocalVideo(v, startSeconds) {
  const url = await libStore.fileUrl(`${v.videoId}.mp4`);
  $('playerWrapper').innerHTML = '<video id="localPlayer" playsinline autoplay style="width:100%;height:100%;background:#000;"></video><div class="player-shield"></div>';
  localVideoEl = document.getElementById('localPlayer');
  localVideoEl.src = url;
  // Seek only once metadata is ready — Safari ignores currentTime set before loadedmetadata.
  if (startSeconds > 0) {
    localVideoEl.addEventListener('loadedmetadata', () => {
      localVideoEl.currentTime = Math.floor(startSeconds);
    }, { once: true });
  }
  localVideoEl.onended = () => {
    if (currentVideo && currentVideo.duration > 0) currentVideo.lastPosition = currentVideo.duration;
    saveCurrentVideoProgress();
    if (timer.remaining > 0) showUpNext();
  };
  localVideoEl.play().catch(() => {});
}
```

Route in `playVideo()` — after `showOnly('playerScreen');` replace the existing destroy-and-create block with:

```js
  // Tear down whichever player was active.
  if (ytPlayer) { try { ytPlayer.destroy(); } catch(e) {} ytPlayer = null; }
  if (localVideoEl) { try { URL.revokeObjectURL(localVideoEl.src); } catch(e) {} localVideoEl = null; }
  $('playerWrapper').innerHTML = '<div id="ytPlayer"></div><div class="player-shield"></div>';

  if (offlineEnabled() && libIds.has(v.videoId)) {
    playLocalVideo(v, startSeconds);
    return;
  }
  if (ytReady) {
    createPlayer(v.videoId, startSeconds);
  } else { /* existing setInterval ytReady wait, unchanged */ }
```

Update `destroyPlayer()` to also clear the local element:

```js
function destroyPlayer() {
  if (ytPlayer) { try { ytPlayer.destroy(); } catch(e) {} ytPlayer = null; }
  if (localVideoEl) { try { localVideoEl.pause(); URL.revokeObjectURL(localVideoEl.src); } catch(e) {} localVideoEl = null; }
  $('playerWrapper').innerHTML = '<div id="ytPlayer"></div><div class="player-shield" id="playerShield"></div>';
}
```

Update the shield tap handler to handle both players:

```js
$('playerWrapper').addEventListener('click', (e) => {
  if (!e.target.classList.contains('player-shield')) return;
  if (localVideoEl) { localVideoEl.paused ? localVideoEl.play() : localVideoEl.pause(); return; }
  if (ytPlayer) { /* existing YT toggle, unchanged */ }
});
```

- [x] **Step 3: ⬇ badge on cards** — in `makeVideoCard`, after the `progressBar` computation add:

```js
  const offBadge = (offlineEnabled() && libIds.has(v.videoId))
    ? '<div style="position:absolute;top:4px;right:4px;background:rgba(0,0,0,0.7);border-radius:8px;padding:2px 6px;font-size:11px;">⬇</div>'
    : '';
```

and include `${offBadge}` inside the `thumb-wrap` div in the card's innerHTML.

- [x] **Step 4: Verify** (desktop Chrome, `vercel dev`, toggle ON, library synced from Task 5): synced cards show ⬇; tapping one plays instantly via `<video>` (check DevTools: no youtube.com iframe created); shield tap pauses/resumes; leaving with Back records progress (progress strip appears; Continue card resumes at position through the LOCAL player); video end → Up Next. Toggle OFF → same card plays via YouTube embed exactly as before (wife-invariant at the player level). `node --check` passes.

- [x] **Step 5: Commit**

```bash
git add index.html && git commit -m "Play synced videos through local <video> path with offline badges"
```

---

### Task 7: Offline boot / library mode

**Files:**
- Modify: `index.html`

- [x] **Step 1: Library mode flag + fetchVideos override** — add at the top of `fetchVideos`:

```js
let libraryMode = false;

async function fetchVideos(channelId) {
  if (libraryMode) {
    const m = getLibManifest();
    if (!m) return [];
    const vids = m.videos.filter(v => v.channelId === channelId && libIds.has(v.videoId));
    return Promise.all(vids.map(async v => ({
      videoId: v.videoId, title: v.title,
      thumb: await libStore.fileUrl(`${v.videoId}.jpg`).catch(() => '') ,
      channelId: v.channelId, channelName: v.channelName,
    })));
  }
  /* existing implementation unchanged */
}
```

(`fileUrl` rejects for missing thumbs; `.catch(() => '')` keeps the card with the surface-colored fallback that `onerror` already provides.)

- [x] **Step 2: Enter library mode on offline boot** — in the init IIFE, after `watchHistory = wh || {};` and the existing `if (offlineEnabled()) refreshLibIds()` line (make the refresh awaited now), decide the mode:

```js
  if (offlineEnabled()) {
    await refreshLibIds().catch(() => {});
    const m = getLibManifest();
    // Offline (or API unreachable) with a synced library -> library mode.
    let online = navigator.onLine;
    if (online) {
      try { await fetch(API_BASE + '/api/config', { method: 'HEAD', signal: AbortSignal.timeout(3000) }); }
      catch(e) { online = false; }
    }
    if (!online && m && libIds.size > 0) {
      libraryMode = true;
      cfg.channels = cfg.channels.filter(ch => m.videos.some(v => v.channelId === ch.id && libIds.has(v.videoId)));
    }
  }
```

(`cfg` at that point is the localStorage-cached config — available offline since `loadConfig` already falls back. Filtering channels hides feeds with no offline content.)

- [x] **Step 3: Verify** (desktop Chrome): normal online boot → unchanged. DevTools → Network → Offline → reload: app boots into grid of synced videos with local thumbnails; sidebar shows only feeds with content; videos play; timer, time's-up lock, PIN unlock all function; Continue Watching card appears for a partially-watched local video. Toggle OFF device (localStorage cleared) + offline reload → today's existing behavior (loading spinner/empty feeds — unchanged degradation). `node --check` passes.

- [x] **Step 4: Commit**

```bash
git add index.html && git commit -m "Boot into offline library mode when synced and unreachable"
```

---

### Task 8: Deploy + iPhone field test (collaborative)

**Files:** none (deploy + checklist)

- [x] **Step 1: Deploy**

```bash
vercel --prod
```

- [x] **Step 2: David's iPhone checklist** (present to David; installed home-screen PWA required for eviction exemption):

1. Open the PWA (or re-add to home screen), Settings (PIN) → enable "Offline videos" → Sync now → watch it pull ~9 videos (Wi-Fi recommended; expect a few minutes first time).
2. Airplane mode → relaunch from home screen → library grid appears → play → timer/lock/PIN → Continue Watching resumes.
3. Back online → app behaves exactly as before (grid from YouTube, ⬇ badges on synced cards, those play instantly without ads).
4. Wife-invariant spot check on her phone: nothing changed anywhere; settings shows the toggle only if she opens PIN settings.

- [x] **Step 3: Record results** — append outcomes (including OPFS quota behavior observed on iOS) to this plan file, fix anything broken before Phase 3.

---

### Task 9: Fire 7 — Capacitor Filesystem adapter + APK (Phase 3) — NOT NEEDED (2026-07-11: Fire runs the PWA; Silk's OPFS + service worker passed the field test, so the native APK path is retired)

> **ON HOLD (2026-07-11):** not started. David wants to test whether the plain PWA (already
> working on iPhone) is good enough on the Fire 7 tablet before reviving the Capacitor
> Android scaffold and building a native adapter + APK. `ios/`, `android/`, and
> `capacitor.config.json` remain in the repo for when/if this resumes.

**Files:**
- Modify: `index.html` (Capacitor adapter, native guards)
- Modify: `package.json` (add `@capacitor/filesystem`)

- [ ] **Step 1: Install the plugin**

```bash
npm install @capacitor/filesystem
npm run sync
```

Expected: `npx cap sync` now reports 4 plugins.

- [ ] **Step 2: Capacitor adapter** — in the `// OFFLINE LIBRARY` section, after `opfsStore`, add and swap:

```js
const capStore = {
  base: 'wt-library',
  P: () => window.Capacitor.Plugins.Filesystem,
  supported: () => IS_NATIVE,
  async names() {
    try { const { files } = await this.P().readdir({ path: this.base, directory: 'DATA' }); return files.map(f => f.name); }
    catch(e) { return []; }
  },
  async save(name, url, onProgress) {
    await this.P().downloadFile({ url, path: `${this.base}/${name}`, directory: 'DATA', recursive: true });
    if (onProgress) onProgress(1);
  },
  async fileUrl(name) {
    const { uri } = await this.P().getUri({ path: `${this.base}/${name}`, directory: 'DATA' });
    return window.Capacitor.convertFileSrc(uri);
  },
  async remove(name) { await this.P().deleteFile({ path: `${this.base}/${name}` , directory: 'DATA' }).catch(() => {}); },
};
if (IS_NATIVE) libStore = capStore;
```

(`fileUrl` returns a `capacitor://` asset URL — no object-URL revocation needed; guard the `URL.revokeObjectURL` calls from Task 6 with `if (localVideoEl.src.startsWith('blob:'))`.)

- [ ] **Step 3: Native guards** (the surviving slice of the old plan's Task 5) — service worker registration becomes `if (!IS_NATIVE && 'serviceWorker' in navigator)`, and wake lock routes through KeepAwake:

```js
async function acquireWakeLock() {
  if (IS_NATIVE) { try { await window.Capacitor.Plugins.KeepAwake.keepAwake(); } catch(e) {} return; }
  if ('wakeLock' in navigator) {
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch(e) {}
  }
}
function releaseWakeLock() {
  if (IS_NATIVE) { try { window.Capacitor.Plugins.KeepAwake.allowSleep(); } catch(e) {} return; }
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}
```

Hide the fullscreen button natively: extend its display-none condition with `IS_NATIVE ||`, and extend the auto-fullscreen guard with `!IS_NATIVE &&`.

- [ ] **Step 4: Build the APK**

```bash
npm run sync
cd android && ./gradlew assembleDebug && cd ..
ls android/app/build/outputs/apk/debug/app-debug.apk
```

If gradle fails on missing Android SDK, report BLOCKED (David: install Android Studio, or `brew install --cask android-studio` needs his go-ahead).

- [ ] **Step 5: Sideload + Fire field test (collaborative, David)**

Enable ADB on the Fire (Settings → Device Options → tap serial 7× → Developer Options → ADB), then `adb install -r android/app/build/outputs/apk/debug/app-debug.apk`. Checklist: enable toggle + sync on Fire; airplane mode → library mode works; local playback with screen staying awake through a session; app pinning (Settings → Security) blocks escape; online behavior identical to web.

- [ ] **Step 6: Commit**

```bash
git add index.html package.json package-lock.json android/ ios/
git commit -m "Add Capacitor Filesystem adapter and native guards for Fire offline build"
```

---

### Task 10: Documentation

**Files:**
- Modify: `CLAUDE.md`, `README.md`

- [ ] **Step 1: CLAUDE.md** — add to file structure: `api/watch-history.js` (per-video resume positions, Redis), `scripts/library-sync.mjs` + `scripts/library-sync-launchd.sh` + `scripts/library-config.json` (offline library pipeline), `capacitor.config.json`/`android/`/`ios/`/`www/` (native shells; `www/` generated, never edit). Add a section:

```markdown
## Offline library

- Nightly launchd job `com.davidhague.watchtime-library` runs `scripts/library-sync.mjs`:
  yt-dlp downloads 3 newest videos per channel (3 persistent picks per playlist) at 720p,
  uploads to Vercel Blob, regenerates `manifest.json`. Logs: `~/WatchTime-Library/logs/`.
- Devices opt in per-device via the PIN-gated settings toggle (`wt_offline_enabled` in
  localStorage — deliberately NOT in shared Redis config). Unconfigured devices are
  byte-for-byte unchanged.
- Synced videos play via a local `<video>` tag (no YouTube at watch time); everything
  else uses the existing IFrame embed. Storage: OPFS on web/PWA, Capacitor Filesystem
  when native (`libStore` adapter pair in index.html).
- Personal/family use only — the yt-dlp pipeline forecloses app-store distribution.
```

Also update "What NOT to do": add "Don't put device-local settings (like the offline toggle) into the shared Redis config — it syncs to every device."

- [ ] **Step 2: README.md** — short "Offline videos for car trips" section: what it does, how to sync before a trip, where the nightly job lives.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "Document offline library pipeline and per-device opt-in"
```

---

## Deferred follow-ups (from Task 2/3 code review — accepted, not blocking)

- **Timeout-stack headroom:** worst case 24 videos × 15-min yt-dlp timeout (6h) exceeds
  the wrapper's `JOB_TIMEOUT_SECONDS=14400` (4h). Real runs finish in ~10 min; the Slack
  timeout alert makes the pathological case visible. Revisit if a timeout alert ever fires.
- **Truncated-mp4 guard:** a SIGKILL landing mid-ffmpeg-merge could leave a non-empty
  truncated mp4 that later runs treat as complete. Narrow window; fix shape if needed:
  download to temp name + rename, or ffprobe-vs-info.json duration check in `download()`.

## Out of scope (from spec)

App-store distribution; iOS native/TestFlight; background sync on iOS; LAN streaming; ffmpeg post-processing beyond yt-dlp's own merge; playlist rotation beyond watched-replacement + `--rotate`.

## As-executed notes

Tasks 0–8 are complete and deployed; Task 9 (Fire native path) is on hold, see the note at its
heading above; Task 10 (this documentation pass) is in progress. Several implementation details
diverged from the plan above as written (curation numbers, sync-engine eviction ordering, iOS
player teardown, the offline-boot reachability signal, and more) — see the
"## As built (2026-07-11)" addendum at the end of
`docs/superpowers/specs/2026-07-10-offline-library-design.md` for the authoritative list of
deltas, rather than treating this plan's original code snippets as current.
