# WatchTime - Claude Code Context

## Project overview

Single-file HTML app (`index.html`) that acts as a kid-friendly YouTube session timer. Designed for Amazon Fire 7 tablet running in Amazon Kids browser with a whitelisted URL. Also used on iPhones and other devices.

## Tech stack

- **Frontend**: Single `index.html` file — all HTML/CSS/JS inline. No framework, no build step.
- **Backend**: Vercel serverless functions (Node.js, ESM) in the `api/` directory.
- **Storage**: Upstash Redis (via `@upstash/redis`) for server-side config and watch-history persistence. localStorage as offline fallback cache.
- **Dependencies**: `@upstash/redis` and `@vercel/blob` in `package.json` for the web app + offline-library pipeline. Capacitor packages are also present (see "Offline library" — paused native direction, kept for a possible Fire APK). No build step for the web app itself.
- **PWA**: Service worker (`sw.js`) + `manifest.json` for installability. `sw.js` is network-first for HTML navigations, so deploys take effect the next time a device opens the app online; the cached shell is only a fallback when offline (required for offline library boot).

## Key design decisions

- **Single file**: All HTML/CSS/JS lives in `index.html`. No framework, no build step. Keep it this way.
- **Timer is session-based**: Starts when a video is tapped, runs continuously through browsing and video watching. NOT per-video.
- **Timer units**: In seconds (default 30s).
- **PIN protection**: 4-digit PIN guards settings, fullscreen exit, and the "time's up" unlock. Default: `1234`. PIN is UI-only — API endpoints are unauthenticated.
- **Fullscreen + Wake Lock**: App auto-enters fullscreen on first interaction. Exiting fullscreen requires PIN. Wake Lock API keeps screen on during sessions.
- **Config in Upstash Redis**: All config (channels, timer, PIN) stored server-side in Upstash Redis under the key `"config"`. On load, app fetches from `/api/config`; on save, POSTs back. Falls back to localStorage if API is unreachable.
- **Channel avatars**: Proxied through `/api/avatar/[channelId]` to avoid 429 rate limits from hotlinking Google CDN. Cached at the edge for 24 hours.
- **Shorts filtering**: The `/api/yt-feed/[channelId]` endpoint checks each video against YouTube's `/shorts/` URL — if it returns 200 (not redirect), it's a Short and gets filtered out.
- **Playlist support**: Playlists (IDs starting with `PL`) use the YouTube Data API to fetch all items, shuffle, and return 10 random videos per session. Channels use the free RSS feed.
- **Split-screen browse layout**: Feed sidebar (left) shows channel/playlist avatars; video grid (right) shows round-robin interleaved videos from all feeds. "All" is default. Selecting a feed filters to just that feed. Infinite scroll loads more.
- **Responsive**: Landscape shows split-screen with sidebar. Portrait hides sidebar and shows single-column all-channel grid.
- **iPhone safe areas**: Uses `env(safe-area-inset-top)` with `viewport-fit=cover` for iPhone notch/Dynamic Island support.
- **Offline library is per-device opt-in**: the "Enable offline videos" toggle in PIN-gated settings lives in localStorage (`wt_offline_enabled`), deliberately not in the shared Redis config, so an unconfigured device (e.g. the wife's phone) is byte-for-byte today's online experience. See "## Offline library" below for the full picture.
- **PIN/shared config sync is unchanged by offline work**: channels, timer, and PIN still live in Redis under `"config"` and sync to every device exactly as before; only the offline toggle and the synced video files are device-local.

## File structure

```
index.html                       # The entire app (HTML/CSS/JS)
manifest.json                    # PWA manifest
sw.js                            # Service worker for PWA
package.json                     # @upstash/redis, @vercel/blob, + Capacitor deps (paused native direction)
api/
  config.js                      # GET/POST app config (Upstash Redis)
  yt-feed/[channelId].js         # Channels: RSS + Shorts filter. Playlists: YouTube Data API + shuffle.
  resolve-channel.js             # Resolves @handles and channel IDs → { channelId, avatar }
  avatar/[channelId].js          # Proxies channel profile images from Google CDN
  playlist-info.js               # Fetches playlist thumbnail from YouTube Data API
  watch-history.js               # GET/POST/DELETE per-video resume positions (Upstash Redis, key "watchHistory")
scripts/
  library-sync.mjs               # Nightly offline-library builder: yt-dlp -> Vercel Blob + manifest.json
  library-sync-launchd.sh        # launchd entrypoint that runs library-sync.mjs with the right PATH/cwd
  library-config.json            # Public Vercel Blob base URL (not a secret)
  sync-www.sh                    # Fills www/ (Capacitor's webDir) from index.html + icons — never edit www/ directly
capacitor.config.json            # Capacitor app config — paused app-store direction, kept for a possible Fire APK
ios/                             # Capacitor iOS shell (paused — see "Offline library")
android/                         # Capacitor Android shell (paused; Fire runs the PWA — Silk OPFS+SW field-tested OK, APK not needed)
www/                             # Generated by scripts/sync-www.sh, gitignored — never edit, regenerate instead
docs/plans/                      # Design documents
docs/superpowers/                # Newer specs/plans (offline library, Capacitor conversion)
```

## Vercel deployment

- **Hosted at**: https://pwa-watchtime-youtube.vercel.app
- **Deploy**: `vercel --prod` from project root
- **Local dev**: `vercel dev` (serves static files + API routes with env vars from `.env.local`)
- **Pull env vars**: `vercel env pull` to get `.env.local` with Upstash credentials
- **Required env vars** (set automatically when Upstash is linked to the project):
  - `KV_REST_API_URL` — Upstash Redis REST endpoint
  - `KV_REST_API_TOKEN` — Upstash Redis auth token
  - `YOUTUBE_API_KEY` — YouTube Data API v3 key (needed for playlist support)
  - `BLOB_READ_WRITE_TOKEN` — Vercel Blob write token, pulled into `.env.local` via `vercel env pull`. Used only by `scripts/library-sync.mjs` on David's Mac — never read by `api/` or by the app itself.
- **`.vercelignore` excludes native/tooling trees from web deploys**: `ios/`, `android/`, `scripts/`, `capacitor.config.json`, `assets/`, `www/`, `node_modules/`, `docs/`. The Vercel CLI deploy does not respect `.gitignore`, so these are listed explicitly to keep them out of the deployed bundle.

## Offline library

Kid videos are available offline for car trips — a nightly job on David's Mac curates and
uploads a small video library that devices sync from ahead of time. Online behavior is
untouched; this is a per-device opt-in add-on, personal/family use only (yt-dlp downloading
violates YouTube's ToS, which is why app-store distribution stays paused — see below).

### The nightly build (Mac side)

- **launchd job** `com.davidhague.watchtime-library-sync` runs at 03:30 daily via the shared
  `scripts-and-agents` `launchd_wrapper.sh` (handles logging, Slack alerts on failure/timeout,
  and a 4-hour job timeout), which in turn invokes `scripts/library-sync-launchd.sh`, which
  runs `node scripts/library-sync.mjs`.
- **What it does** (`scripts/library-sync.mjs`):
  1. Self-updates yt-dlp, then reads the channel/playlist allowlist straight from the app's
     own `/api/config` — adding a channel in the app automatically feeds the downloader.
  2. **Channels**: looks at the newest 25 uploads from the channel's `/videos` tab, keeps the
     ones with a parseable duration (drops live/premiere entries), then windows to
     `MIN_DURATION_SEC`–`MAX_DURATION_SEC` (**120–600 seconds**, i.e. 2–10 minutes) and takes
     up to `PER_FEED` (**5**) of them.
     **Playlists**: same duration window, but picks are persistent across runs (stored in
     `state.json`'s `playlistPicks`) and only get replaced when a pick disappears upstream, is
     "retired" (watched to ≥95%, reported unplayable by the IFrame player, or its
     channel/playlist was removed from config), or `--rotate` is passed.
  3. **Min-1-per-feed fallback**: if a feed has nothing in the duration window (e.g. a
     channel that only posts long-form content), it falls back to that feed's single
     shortest video ≥`MIN_DURATION_SEC` — even if that video is longer than
     `MAX_DURATION_SEC` — so every feed contributes at least one video.
  4. Downloads **480p** H.264/AAC MP4 (`bv*[height<=480][vcodec^=avc1]+ba[acodec^=mp4a]`) +
     JPEG thumbnail via yt-dlp, with a `!is_live & !was_live` match-filter as a second
     live/premiere guard at download time.
  5. Uploads new files to **Vercel Blob** (public access) and regenerates `manifest.json`
     (videoId, title, channelId, channelName, duration, size, blob URL, thumb URL,
     downloadedAt), then evicts blobs and local files no longer desired.
  6. Total library is capped at **10 GB** (`MAX_TOTAL_BYTES`); videos are skipped once the
     running total would exceed the cap.
  7. Local staging lives in `~/WatchTime-Library/videos/`, with sync state (playlist picks,
     last-seen watch-history ids) in `~/WatchTime-Library/state.json`.
- **CLI flags**: `--dry-run` (select and print without downloading/uploading/evicting),
  `--rotate` (force-refresh playlist picks), `--publish-existing` (upload whatever's already
  downloaded locally without starting new downloads or evicting anything — used to push
  partial progress out during a long run).

### The app side (per-device)

- **Opt-in toggle**: "Enable offline videos" in PIN-gated settings, stored in localStorage as
  `wt_offline_enabled` (`'1'`/`'0'`) — never in the shared Redis config. Toggling it on reveals
  a "Sync now" button, last-synced time, and on-device usage (`N videos on device · X.XX GB`,
  computed from real file sizes via `libStore.usage()`, not a storage-quota estimate).
- **Storage adapter**: `libStore` (currently `opfsStore`) wraps the Origin Private File System
  (`navigator.storage.getDirectory()`) — `names()`, `save()`, `fileUrl()`, `stat()`, `remove()`,
  `usage()`. A Capacitor Filesystem adapter would swap in when `IS_NATIVE` is true, but that
  swap hasn't been implemented (see Task 9 below).
- **Sync engine** (`syncLibrary()`): fetches `manifest.json`, then per video —
  - downloads it if missing;
  - if present but its size differs from the manifest (`v.size`), treats that as a
    content change (e.g. a server re-encode) and replaces the file;
  - repairs a missing thumbnail for an already-downloaded video (handles interrupted/older syncs).
  - Local files are only evicted for videos no longer in the manifest **if every download in
    that sync succeeded** (`failed === 0`) — a partial failure keeps old content rather than
    leaving the car-trip device with less.
- **Local playback**: if the toggle is on and the tapped video's id is in `libIds` (the set of
  videoIds present on-device), it plays through a local `<video>` element instead of the
  YouTube IFrame player; otherwise playback is unchanged. Tearing down a local `<video>` always
  goes through `unloadLocalVideo()` (pause → clear `src` → `load()`) because iOS WebKit can
  otherwise hold onto the decode pipeline of a discarded element, leaving the *next* local
  video stuck at readyState 0 (black screen). A `playerGeneration` counter guards against a
  slow async `libStore.fileUrl()` resolving after the user has already navigated away.
- **Offline boot**: on load, if the offline toggle is on, the app awaits `refreshLibIds()` and
  checks `configFromServer` (the flag `loadConfig()` already sets when `/api/config` succeeds)
  as its online/offline signal — no separate reachability probe. If it's offline (or the API
  was unreachable) and there's a synced manifest with at least one local video, the app enters
  `libraryMode`: `cfg.channels` is filtered to feeds that have local content, and `fetchVideos()`
  serves videos from the manifest instead of `/api/yt-feed`.
- **Scroll-exhaustion guard**: the infinite-scroll handler skips re-rendering the grid once
  every available video (`getRoundRobinVideos(Infinity).length`) is already shown — avoids a
  visible flash, most noticeable in library mode where feeds are small.
- **Wife-invariant**: an unconfigured device never sets `wt_offline_enabled`, so it never calls
  any of the above — it is byte-for-byte today's online-only experience.

### Native (Fire tablet) path — paused

`capacitor.config.json`, `ios/`, and `android/` are Capacitor scaffolding from an earlier,
paused app-store direction (see `docs/superpowers/specs/2026-07-09-capacitor-app-conversion-design.md`
— the iOS embed gate failed with error 153). They're kept because a Fire-native APK using
local files could sidestep that gate entirely, but the Capacitor Filesystem storage adapter
and APK build (Task 9 of `docs/superpowers/plans/2026-07-10-offline-library.md`) are **on
hold**, pending a test of whether the plain PWA works well enough on the Fire tablet first.
`www/` is `index.html` + `icons/` copied by `scripts/sync-www.sh` for Capacitor's `webDir` —
it's gitignored and regenerated, never edited directly.

## Things to watch out for

- YouTube IFrame Player API is loaded from `https://www.youtube.com/iframe_api` — no local copy
- The `fetchVideos()` function in index.html calls `/api/yt-feed/${channelId}` — returns JSON (not XML) with Shorts already filtered out
- Channel IDs must start with `UC`, playlist IDs with `PL` — the settings UI validates this
- Adding channels supports `@handle` URLs, full channel URLs, raw channel IDs, or playlist URLs — the `/api/resolve-channel` endpoint resolves channels
- The YouTube channel page uses either `"channelId"` or `"externalId"` for the channel ID — the resolver checks both
- The app uses `touch-action: manipulation` and `-webkit-tap-highlight-color: transparent` for tablet UX — don't remove these
- The yt-feed endpoint makes HEAD requests to YouTube `/shorts/<id>` for each video to filter Shorts — this adds latency (~2-4s). Client timeout is 15s.
- `sw.js` is network-first for HTML navigations (`e.request.mode === 'navigate'`) — a deployed change to `index.html` takes effect the next time a device opens the app online. The cached shell only serves when the network fetch fails, which is what makes offline library boot possible at all — don't revert this to cache-first without breaking that.
- `BLOB_READ_WRITE_TOKEN` (in `.env.local` via `vercel env pull`) is only ever read by `scripts/library-sync.mjs` on David's Mac — the deployed `api/` functions and the client never touch it.
- Legacy >480p library files are gone (the curation window moved from 720p/3-per-feed to 480p/5-per-feed — see `docs/superpowers/specs/2026-07-10-offline-library-design.md`'s as-built addendum); very large video files in OPFS can fail to play on iOS, so keep synced files modest — don't raise the resolution/duration window without testing on-device.

## What NOT to do

- Don't split index.html into multiple files
- Don't change the timer from session-based to per-video
- Don't add authentication on API endpoints (PIN is UI-only by design)
- Don't hotlink `yt3.googleusercontent.com` directly — use the `/api/avatar/` proxy to avoid 429s
- Don't re-add color picker for channel cards — it was removed as unused after the split-screen layout change
- Don't put device-local settings (like the offline-library toggle) into the shared Redis config — anything in there syncs to every device, and the offline toggle must stay per-device (localStorage) to preserve the wife-invariant
- Don't edit `www/` — it's generated by `scripts/sync-www.sh` from `index.html` + `icons/` and is gitignored; edit the source files and regenerate instead
- Don't tear down a local `<video>` element by just clearing its `src` or dropping the reference — always route through `unloadLocalVideo()` (pause → clear `src` → `load()`), or iOS WebKit can starve the decode pipeline for the next local video
