#!/usr/bin/env node
// WatchTime offline library builder. Downloads a small curated set of videos
// with yt-dlp, uploads to Vercel Blob, regenerates manifest.json.
// Usage: node scripts/library-sync.mjs [--dry-run] [--rotate] [--publish-existing]
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
// Publish whatever's already downloaded locally without kicking off new yt-dlp
// downloads (and without evicting anything) -- used to push partial progress
// out to the Blob store without waiting on the rest of a long run.
const PUBLISH_EXISTING = process.argv.includes('--publish-existing');
// launchd has a bare PATH; make sure yt-dlp's pyenv shim and ffmpeg are findable.
process.env.PATH = `${os.homedir()}/.pyenv/shims:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}`;

function token() {
  if (process.env.BLOB_READ_WRITE_TOKEN) return process.env.BLOB_READ_WRITE_TOKEN;
  const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
  const m = env.match(/BLOB_READ_WRITE_TOKEN="?([^"\n]+)/);
  if (!m) throw new Error('BLOB_READ_WRITE_TOKEN not found in env or .env.local');
  return m[1];
}
const TOKEN = token();

const log = (...a) => console.log(new Date().toISOString(), ...a);

// Default 2 min covers version checks/self-update/listings; download() passes
// a longer budget. killSignal ensures a wedged process is actually reaped
// (a hung yt-dlp wedged the nightly run before this was added).
function ytdlp(args, timeoutMs = 120000) {
  return execFileSync('yt-dlp', args, {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs, killSignal: 'SIGKILL',
  });
}

const VALID_VIDEO_ID = /^[\w-]{1,32}$/;

function listFeed(feedId, limit) {
  const base = feedId.startsWith('PL')
    ? `https://www.youtube.com/playlist?list=${feedId}`
    : `https://www.youtube.com/channel/${feedId}/videos`;
  const args = ['--flat-playlist', '--print', '%(id)s\t%(title)s', base];
  if (limit) args.splice(1, 0, '--playlist-end', String(limit));
  return ytdlp(args).trim().split('\n').filter(Boolean).map(line => {
    const [id, ...t] = line.split('\t');
    return { videoId: id, title: t.join('\t') };
  }).filter(v => {
    if (VALID_VIDEO_ID.test(v.videoId)) return true;
    log('SKIP (bad videoId)', feedId, JSON.stringify(v.videoId));
    return false;
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

function choosePlaylistPicks(feedId, upstream, state, retiredIds) {
  if (PUBLISH_EXISTING) {
    // Don't claim a slot for a video we're not about to download: just
    // republish whichever of the already-stored picks exist locally.
    const stored = state.playlistPicks[feedId] || [];
    return upstream.filter(v => stored.includes(v.videoId));
  }
  const upstreamIds = new Set(upstream.map(v => v.videoId));
  let picks = (state.playlistPicks[feedId] || []).filter(id =>
    upstreamIds.has(id) && !retiredIds.has(id) && !ROTATE);
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
    ], 900000);
  }
  if (fs.statSync(mp4).size === 0) throw new Error('empty download: ' + videoId);
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
  // Entries we tracked last run but are gone from watch-history now are
  // "retired" -- their playlist slot should be freed up. This fires for
  // three distinct reasons the app deletes a watch-history entry: (1) the
  // video was watched to >=95% completion, (2) the IFrame player reported
  // it unplayable (error code 100/101/150 -- age-gated, removed, embed-
  // disabled), or (3) its source channel/playlist was removed from config.
  // All three are legitimate reasons to stop holding that slot, so the
  // replace-on-retirement behavior is correct for all of them -- but don't
  // read "retired" as "the kid finished watching it".
  const retiredIds = new Set(state.trackedHistory.filter(id => !(id in history)));

  const desired = []; // { videoId, title, channelId, channelName }
  for (const feed of cfg.channels) {
    try {
      const isPlaylist = feed.id.startsWith('PL');
      const upstream = listFeed(feed.id, isPlaylist ? 0 : PER_FEED);
      const picks = isPlaylist
        ? choosePlaylistPicks(feed.id, upstream, state, retiredIds)
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
      const mp4Path = path.join(VIDEOS_DIR, `${v.videoId}.mp4`);
      if (PUBLISH_EXISTING && !fs.existsSync(mp4Path)) {
        log('SKIP (not downloaded, --publish-existing)', v.videoId);
        continue;
      }
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

  if (PUBLISH_EXISTING) {
    // Partial-progress publish: feeds/videos not yet downloaded are simply
    // absent from this manifest, not "no longer desired" -- evicting would
    // delete their local downloads-in-progress and any blobs from previous
    // full runs that a later full run still needs. Skip eviction entirely;
    // a subsequent full run reconciles everything.
    log('evictions skipped (--publish-existing) — run a full sync to reconcile');
  } else {
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
  }

  state.trackedHistory = Object.keys(history);
  fs.mkdirSync(LIB, { recursive: true });
  const tmpStateFile = STATE_FILE + '.tmp';
  fs.writeFileSync(tmpStateFile, JSON.stringify(state, null, 2));
  fs.renameSync(tmpStateFile, STATE_FILE);
  log('done');
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
