# WatchTime Offline Library — Design

**Date:** 2026-07-10
**Status:** Approved by David (pending final spec review)
**Supersedes direction of:** `2026-07-09-capacitor-app-conversion-design.md` (paused
after the iOS embed gate failed with error 153; Tasks 1–3 of that plan — CORS,
IS_NATIVE/API_BASE, Capacitor scaffold — are complete on branch `capacitor-app`
and are prerequisites reused here)

## Goal

Kid videos available offline for car trips on the Fire 7 tablet and iPhone/iPad,
via a nightly yt-dlp job on David's Mac that uploads a small curated library to
Vercel Blob, which devices sync from ahead of time. Online behavior stays
exactly as today.

**Personal/family use only.** yt-dlp downloading violates YouTube ToS; this
permanently forecloses app-store distribution, which David explicitly paused.
This is a personal media pipeline, not a product.

## The invariant (wife-proofing)

The offline feature is **per-device opt-in and invisible by default**. It
activates only via an "Enable offline library" toggle inside the PIN-gated
settings screen, stored in **localStorage** (deliberately NOT in the shared
Redis config, which syncs to all devices). An unconfigured device — David's
wife's phone — runs byte-for-byte today's experience.

## Components

### 1. Downloader (Mac, nightly launchd job)

Script in `scripts/` (repo) run nightly via David's scheduled-jobs setup and
enrolled in the local dashboard. Each run:

1. Self-updates yt-dlp first (YouTube routinely breaks old versions).
2. Reads the channel/playlist allowlist from the app's own
   `https://pwa-watchtime-youtube.vercel.app/api/config` — adding a channel in
   the app automatically feeds the downloader; zero double-bookkeeping.
3. Per **channel**: newest **3** videos from the `/videos` tab (Shorts excluded
   by YouTube's own tab structure — retires the HEAD-probe filtering approach
   for offline content).
   Per **playlist**: 3 picks; rotation is gentle (replace only watched-to-
   completion or removed videos, not wholesale nightly churn) to keep device
   re-sync egress small.
4. Downloads 720p H.264/AAC MP4 (`bv*[height<=720][vcodec^=avc1]+ba[acodec^=mp4a]`,
   mp4 container — plays natively in every target) + thumbnail JPEG into
   `~/WatchTime-Library/<channelId>/<videoId>.*` as local staging.
5. Uploads new files to **Vercel Blob** (public access), deletes evicted blobs,
   and uploads a regenerated **`manifest.json`** listing every video: videoId,
   title, channelId, channelName, duration, size, blob URL, thumb URL,
   downloadedAt.
6. Retention: newest 3 per feed; total library hard cap **10 GB** (evict oldest
   first). Expected steady state at 3 feeds: ~9 videos, 1–2 GB.
7. Failures log loudly to the dashboard; the app is unaffected by a failed run
   (yesterday's library persists).

Auth: `BLOB_READ_WRITE_TOKEN` from the Vercel project, stored in the job's
environment on the Mac (never in the repo, never on devices — devices only read
public URLs).

### 2. Storage/serving: Vercel Blob

- Same Vercel project as the app; no new accounts.
- Public, CDN-backed https URLs with CORS and range-request support — no
  mixed-content problem for the PWA, syncs work from anywhere (hotel Wi-Fi the
  night before a trip counts), and at-home streaming without sync is possible
  later for free.
- Public-URL exposure is acceptable: the content is public YouTube video, the
  URLs are unguessable, and nothing sensitive lives in the manifest.
- Cost check: storage ~1–2 GB; device sync churn ≈ a few GB/month — comfortably
  inside the project plan's included transfer.

### 3. Device sync + storage (two adapters, one module)

Sync module lives inline in `index.html` (single-file rule holds). Storage
adapters behind the existing `IS_NATIVE` flag:

- **iPhone/iPad (installed PWA):** OPFS + `navigator.storage.persist()`.
  Installed home-screen web apps are exempt from Safari's 7-day eviction;
  1–2 GB is realistic at this library size. Playback via object URLs.
- **Fire 7 (Capacitor Android app — revives the existing `android/` scaffold):**
  Capacitor Filesystem into app storage; playback via `convertFileSrc` URLs.
  No quota anxiety. (Also sidesteps webview mixed-content entirely.)

Sync UX: PIN-gated settings section (visible only when the offline toggle is
on): "Sync now" button, per-file progress, storage used, last-synced time.
Logic: fetch manifest → diff against local store → download missing → delete
evicted → idempotent and resumable per-file. Foreground-only (iOS PWAs offer
nothing better); the ritual is "plug in, open app, tap sync" before a trip.

### 4. App behavior (hybrid rules)

1. **Online browsing:** identical to today (yt-feed grid, YouTube embed).
   Cards whose video exists in local storage show a small ⬇ badge and play
   from the **local file** — an invisible upgrade (faster start, no ads, no
   error-153 exposure).
2. **Offline launch:** instead of today's empty grid, the app boots into the
   library: synced videos as normal cards, same timer, same PIN, same
   Continue Watching.
3. **Player selection:** local file → `<video>` tag; otherwise → the existing
   YouTube IFrame path, untouched. The `<video>` path reuses the session
   timer's 1 Hz position sampling against `video.currentTime`/`.duration`
   (same furthest-position semantics, same ≥95% completion cleanup).
4. **Up Next / All-feed round-robin offline:** drawn from the library.
5. Watch history: unchanged mechanism (Redis when reachable, localStorage
   mirror always — offline sessions sync back opportunistically since
   saveWatchEntry already swallows network failures).

### 5. What does NOT change

Session timer model, PIN flows, settings/channel management, config + watch
history APIs, Redis, web deploys (`vercel --prod`), CLAUDE.md single-file rule
(only the downloader script is outside `index.html`, in `scripts/`), and —
above all — the experience on any device that never enables the toggle.

## Failure modes

- **Blob unreachable / offline mid-sync:** per-file resume on next sync;
  existing local content untouched.
- **yt-dlp breakage:** dashboard alert; library goes stale but keeps working.
- **OPFS permission/quota denied (iPhone):** graceful message; feature stays
  off; nothing else degrades.
- **Manifest/local drift:** manifest is the source of truth; diff-based sync
  self-heals every run.

## Build order

1. **Downloader + Blob upload + manifest** (Mac side; delivers value before any
   app change — the library exists and is inspectable).
2. **iPhone PWA path:** offline toggle, sync module + OPFS adapter, `<video>`
   player path, offline boot mode. Pure web — proves the whole pipeline on
   David's phone.
3. **Fire path:** revive `android/` scaffold, Filesystem adapter, build +
   sideload APK. (First real test of Android at all — the iOS-only gate
   failure never got an Android data point, though local files make the
   embed question moot.)

## Out of scope (deliberate)

- App-store distribution of any kind (foreclosed by design).
- iOS native app / TestFlight (PWA covers iPhone).
- Background/automatic sync on iOS (platform won't allow it for PWAs).
- At-home LAN streaming from the Mac (Blob URLs could serve this later if
  wanted).
- Transcoding pipeline beyond yt-dlp's format selection (no ffmpeg
  post-processing unless a target device refuses a file).
- Auto-rotation of playlist picks beyond watched-replacement.
