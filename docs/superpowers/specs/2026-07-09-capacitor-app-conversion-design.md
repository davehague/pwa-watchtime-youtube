# WatchTime: Capacitor App Conversion — Design

**Date:** 2026-07-09
**Status:** Approved by David

## Goal

Convert the WatchTime PWA into a real installable app for iPhone/iPad (via
TestFlight) and the Amazon Fire 7 tablet (sideloaded APK), while keeping the
web version live on Vercel from the same codebase. Family distribution now,
built store-ready so a public App Store release stays possible later.

## Non-negotiable product pillars

These three features define the app. Every implementation decision defers to
them:

1. **Timer with lock** — the session timer is the authority. When time is up,
   the app locks and only the parent PIN unlocks it.
2. **Opt-in content** — kids see only the YouTube channels/playlists a parent
   explicitly added. Allowlist, never opt-out.
3. **Kid niceties** — Continue Watching resumes the last video at the furthest
   watched position; watch-progress strips on cards; Up Next suggestions.

## Motivations (from brainstorming)

- **Kid-proof lockdown**: browser fullscreen/PIN wrestling is fragile; native
  app + OS-level Guided Access / app pinning makes escape genuinely hard.
- **Reliability & polish**: no stale service-worker caches, no browser chrome,
  instant launch, reliable keep-screen-on.
- **Real product someday**: store-ready foundation (proper app ID, Capacitor
  project) without paying the Kids-Category/COPPA compliance tax up front.

## Approach chosen

**Capacitor shell around the existing single-file app.** Rejected
alternatives: PWABuilder remote-URL wrapper (no native control, weakest App
Store review position) and full native rewrite (weeks of effort, kills the
web version, unnecessary now; migrating from Capacitor later remains
possible).

## Architecture

One repo, three targets from the same `index.html`:

```
index.html            # still the entire app — single-file identity preserved
sw.js, manifest.json  # web-only, untouched
api/                  # Vercel functions — stay on Vercel, gain CORS headers
capacitor.config.json # new: app ID, webDir, plugin config
www/                  # gitignored; filled by copy script (index.html + icons)
ios/, android/        # generated Capacitor native projects, committed
scripts/sync-www.sh   # copies index.html + icons into www/ before cap sync
```

- Web deploys unchanged: `vercel --prod`, no build step.
- App builds require the copy step because Capacitor's `webDir` must be a
  clean directory (pointing it at repo root would bundle `ios/` into itself).
- App ID: `com.davidhague.watchtime`.

## Changes inside index.html

One platform flag drives all divergence:

```js
const IS_NATIVE = !!window.Capacitor?.isNativePlatform?.();
const API_BASE = IS_NATIVE ? 'https://pwa-watchtime-youtube.vercel.app' : '';
```

- **All `fetch('/api/...')` calls** become `fetch(API_BASE + '/api/...')`.
- **Deleted outright** (dead weight on every platform once native exists):
  - Manual rotate button and the entire `body.rotated` CSS transform hack
  - Silk browser UA detection
  - `screen.orientation.lock()` attempts
- **Guarded web-only** (`if (!IS_NATIVE)`):
  - Service worker registration
  - Fullscreen button, auto-enter-fullscreen, PIN-to-exit-fullscreen,
    re-enter-on-escape loop
  - Wake Lock API (native path uses KeepAwake plugin instead)
- **Unchanged**: timer engine, PIN flows, browse/player/up-next screens,
  Continue Watching, config/watch-history sync, safe-area CSS
  (`env(safe-area-inset-*)` works in WKWebView with `viewport-fit=cover`).

## Backend changes

Vercel backend survives untouched except CORS. Native apps serve from
`capacitor://localhost` (iOS) / `https://localhost` (Android), so every
endpoint gets `Access-Control-Allow-Origin: *` plus OPTIONS preflight
handling on POST/DELETE routes (config, watch-history). Wide-open CORS is
consistent with the existing "endpoints unauthenticated, PIN is UI-only"
design. Cross-device config/history sync via shared Redis continues to work
across iPhone app, Fire app, and web for free.

Note: `/api/watch-history` (Redis-backed per-video resume positions) exists
in code but is missing from CLAUDE.md — document it during implementation.

## Native shell configuration

- **Plugins** (only these three; YAGNI on the rest):
  - `@capacitor-community/keep-awake` — screen on while a session timer runs
  - `@capacitor/status-bar` — hidden/overlay for edge-to-edge
  - `@capacitor/splash-screen` — launch experience
- **Orientation**: free-rotating on all platforms (portrait = single-column
  grid, landscape = split view), matching today's responsive behavior. The
  old lock attempts existed only for Silk browser quirks.
- **Icons/splash**: generate full sets from one 1024px source via
  `@capacitor/assets`. Need to produce a hi-res source (current largest icon
  is 192px).

## Kid-proof lockdown story

- In-app: PIN gates stay exactly as today (settings, quick timer, time's-up
  parent unlock).
- Escape-proofing moves to the OS layer: **Guided Access** on iOS, **app
  pinning** on Fire OS. This replaces ~100 lines of fullscreen-wrestling
  code with a stronger guarantee than any browser allowed.
- Future enhancement (explicitly out of scope now): Face ID/Touch ID for
  parent unlock.

## Build & distribution

- **Web**: unchanged, instant (`vercel --prod`).
- **iOS**: `sync-www.sh` → `npx cap sync ios` → Xcode archive → TestFlight →
  family installs via TestFlight app. Prerequisite: Apple Developer Program
  ($99/yr) enrollment.
- **Fire**: `npx cap sync android` → build APK → sideload to Fire 7.
- Accepted trade-off: app-side changes need rebuild + redistribute, unlike
  instant web deploys. Fine for family use; Capacitor Live Updates is the
  escape hatch if it ever hurts.

## Risks & open items (verify in this order)

1. **YouTube playback in WKWebView** — autoplay/unmute policies differ from
   Safari. Make-or-break; implementation step 1 is a bare Capacitor shell
   playing a YouTube video before any other investment.

   **2026-07-10 GATE RESULT: FAILED on iOS — project direction paused.**
   iOS simulator spike: app boots, grid loads (CORS + API_BASE verified
   end-to-end), tap starts the session timer, but the embed dies with
   **error 153** ("Video player configuration error") — YouTube's
   referrer enforcement rejecting the `capacitor://localhost` origin.
   Persisted after adding `origin` + `widget_referrer` playerVars
   (fallback a). Fixing it requires a remotely-hosted player page or a
   native player plugin — at which point David paused the productization
   direction entirely (see below). Android (`https://localhost` origin)
   was never tested and may not share the problem.

   **Status of this spec:** Tasks 1–3 of the implementation plan are
   complete, reviewed, and committed on branch `capacitor-app` (CORS,
   IS_NATIVE/API_BASE plumbing, Capacitor scaffold, .vercelignore).
   Tasks 4–10 are abandoned for now. Next direction under discussion:
   offline-first videos via a nightly yt-dlp job on the home Mac serving
   local files (kills the embed problem entirely — `<video>` tag, no
   YouTube at watch time). Personal/family use only; incompatible with
   app-store distribution by design.
2. **Amazon Kids profile** — confirm a sideloaded app can be launched from
   the kid profile on the Fire 7 (needs on-device verification).
3. **Apple Developer enrollment** — takes a day or two; start early.

## Testing

Manual on-device testing with a written per-platform checklist: timer expiry
locks the app, PIN gates hold, Continue Watching resumes at furthest
position, config sync from a second device, backgrounding mid-session,
Guided Access / app pinning behavior. Dev loop: `npx cap run ios -l` (live
reload) against `vercel dev`.

## Feature audit reference

Full audit performed 2026-07-09. Summary of fates:

| Category | Features | Fate |
|---|---|---|
| Core product | Timer, PIN gates, time's-up lock, allowlist channel management, split-view browse, round-robin All feed, Up Next, Continue Watching, playlist shuffle, player shield | Keep unchanged |
| Browser workarounds | Fullscreen+PIN loop, rotate hack, Silk detection, orientation lock calls, Wake Lock, SW registration | Delete or gate web-only |
| Backend | config, watch-history, yt-feed (RSS + Shorts filter), resolve-channel, avatar proxy, playlist-info | Keep on Vercel, add CORS |
