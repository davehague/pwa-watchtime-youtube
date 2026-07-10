# WatchTime Capacitor App Conversion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wrap the existing single-file WatchTime app in Capacitor to produce an iOS app (TestFlight) and an Android APK (sideloaded on the Fire 7), while the web version keeps deploying to Vercel unchanged.

**Architecture:** `index.html` stays the entire app. A copy script fills a gitignored `www/` directory that Capacitor bundles into generated `ios/` and `android/` projects. The Vercel backend stays where it is; native builds reach it via an absolute `API_BASE`. A single `IS_NATIVE` flag gates web-only code (service worker, fullscreen wrestling, Wake Lock) and enables native plugins (KeepAwake, StatusBar).

**Tech Stack:** Capacitor 7 (`@capacitor/core`, `@capacitor/cli`, `@capacitor/ios`, `@capacitor/android`), plugins `@capacitor/status-bar`, `@capacitor/splash-screen`, `@capacitor-community/keep-awake`, `@capacitor/assets` for icon/splash generation. No test framework exists in this repo and there is no build step for the web — verification is `curl` + on-device/manual, specified exactly per task.

**Spec:** `docs/superpowers/specs/2026-07-09-capacitor-app-conversion-design.md`

**Prerequisites (human, start early):**
- Apple Developer Program enrollment ($99/yr) — needed by Task 9, not before.
- Xcode installed (`xcode-select -p` should print a path).
- Android Studio installed (bundles JDK + SDK) — needed by Task 7.
- A Mac (this repo's dev machine qualifies).

**Task ordering rationale:** The iOS playback spike (Task 4) is the make-or-break gate from the spec — nothing native gets built past scaffolding until YouTube playback is proven in WKWebView. Deleting the Silk-era rotate/fullscreen hacks is deliberately LAST among code changes (Task 8): the Fire tablet keeps using the Silk browser until the APK is verified on-device (Task 7), and deleting those hacks earlier would degrade the currently-deployed web app for its primary user.

---

### Task 1: CORS coverage for remaining API endpoints

`config.js` and `watch-history.js` already send `Access-Control-Allow-Origin: *` and handle OPTIONS. Three gaps remain: `yt-feed` only sets the header on success paths (error responses lose it), and `resolve-channel` / `playlist-info` (both called via `fetch` from settings) have none. `avatar` needs nothing — it is only used in `<img>` tags.

**Files:**
- Modify: `api/yt-feed/[channelId].js:14-19`
- Modify: `api/resolve-channel.js:1-6`
- Modify: `api/playlist-info.js:1-7`

- [ ] **Step 1: Move the CORS header to the top of the yt-feed handler**

In `api/yt-feed/[channelId].js`, change:

```js
export default async function handler(req, res) {
  const { channelId } = req.query;

  if (!channelId || (!channelId.startsWith('UC') && !channelId.startsWith('PL'))) {
    return res.status(400).send('Invalid channel or playlist ID');
  }
```

to:

```js
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { channelId } = req.query;

  if (!channelId || (!channelId.startsWith('UC') && !channelId.startsWith('PL'))) {
    return res.status(400).send('Invalid channel or playlist ID');
  }
```

Then delete the two now-redundant `res.setHeader('Access-Control-Allow-Origin', '*');` lines further down (currently lines 62 and 72).

- [ ] **Step 2: Add the header to resolve-channel**

In `api/resolve-channel.js`, change:

```js
export default async function handler(req, res) {
  const { handle, channelId } = req.query;
```

to:

```js
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { handle, channelId } = req.query;
```

- [ ] **Step 3: Add the header to playlist-info**

In `api/playlist-info.js`, change:

```js
export default async function handler(req, res) {
  const { playlistId } = req.query;
```

to:

```js
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { playlistId } = req.query;
```

- [ ] **Step 4: Verify locally with vercel dev**

Run (leave `vercel dev` running in one terminal):

```bash
vercel dev --listen 3000
```

In another terminal:

```bash
curl -sI "http://localhost:3000/api/yt-feed/XXinvalid" | grep -i access-control
curl -sI "http://localhost:3000/api/resolve-channel" | grep -i access-control
curl -sI "http://localhost:3000/api/playlist-info" | grep -i access-control
```

Expected: each prints `access-control-allow-origin: *` (note: these are error responses — 400s — which is exactly the point: the header must survive error paths).

- [ ] **Step 5: Commit and deploy**

```bash
git add api/
git commit -m "Add CORS headers to all fetched API endpoints for native app origins"
vercel --prod
```

Verify production:

```bash
curl -sI "https://pwa-watchtime-youtube.vercel.app/api/resolve-channel" | grep -i access-control
```

Expected: `access-control-allow-origin: *`

---

### Task 2: Platform detection and API_BASE in index.html

Add `IS_NATIVE` / `API_BASE` constants and prefix every same-origin URL (fetches AND `/api/avatar/` image `src`s — a relative image URL inside the app would resolve to `capacitor://localhost/api/...` and 404). On web `API_BASE` is `''`, so this is a behavioral no-op there.

**Files:**
- Modify: `index.html` (script section, 11 call sites)

- [ ] **Step 1: Add the constants at the top of the CONFIG section**

In `index.html`, directly below the `// CONFIG` banner comment (before `const DEFAULT_CONFIG`), add:

```js
const IS_NATIVE = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
const API_BASE = IS_NATIVE ? 'https://pwa-watchtime-youtube.vercel.app' : '';
```

- [ ] **Step 2: Prefix all fetch call sites**

Make these exact replacements (all in `index.html`):

| Function | Old | New |
|---|---|---|
| `loadConfig` | `fetch('/api/config', {` | `fetch(API_BASE + '/api/config', {` |
| `saveConfig` | `await fetch('/api/config', {` | `await fetch(API_BASE + '/api/config', {` |
| `loadWatchHistory` | `fetch('/api/watch-history', {` | `fetch(API_BASE + '/api/watch-history', {` |
| `saveWatchEntry` | `await fetch('/api/watch-history', {` | `await fetch(API_BASE + '/api/watch-history', {` |
| `deleteWatchEntry` | ``await fetch(`/api/watch-history?videoId=${encodeURIComponent(videoId)}`, {`` | ``await fetch(`${API_BASE}/api/watch-history?videoId=${encodeURIComponent(videoId)}`, {`` |
| `fetchVideos` | ``fetch(`/api/yt-feed/${channelId}`, {`` | ``fetch(`${API_BASE}/api/yt-feed/${channelId}`, {`` |
| `addChannelBtn` (playlist branch) | ``fetch(`/api/playlist-info?playlistId=${id}`, {`` | ``fetch(`${API_BASE}/api/playlist-info?playlistId=${id}`, {`` |
| `addChannelBtn` (handle branch) | ``fetch(`/api/resolve-channel?handle=${encodeURIComponent(handleMatch[0])}`, {`` | ``fetch(`${API_BASE}/api/resolve-channel?handle=${encodeURIComponent(handleMatch[0])}`, {`` |
| `addChannelBtn` (avatar branch) | ``fetch(`/api/resolve-channel?channelId=${encodeURIComponent(id)}`, {`` | ``fetch(`${API_BASE}/api/resolve-channel?channelId=${encodeURIComponent(id)}`, {`` |

- [ ] **Step 3: Prefix the two avatar image srcs**

In `renderSidebar()`, change:

```js
? `<img class="avatar" src="${ch.id.startsWith('PL') ? ch.avatar : '/api/avatar/' + ch.id}" alt="" onerror="this.outerHTML='<div class=\\'emoji\\'>${ch.emoji}</div>'">`
```

to:

```js
? `<img class="avatar" src="${ch.id.startsWith('PL') ? ch.avatar : API_BASE + '/api/avatar/' + ch.id}" alt="" onerror="this.outerHTML='<div class=\\'emoji\\'>${ch.emoji}</div>'">`
```

In `renderSettingsChannels()`, change:

```js
<img src="/api/avatar/${ch.id}" style="width:32px;height:32px;border-radius:50%;flex-shrink:0" onerror="this.outerHTML='<span style=font-size:24px>${ch.emoji}</span>'">
```

to:

```js
<img src="${API_BASE}/api/avatar/${ch.id}" style="width:32px;height:32px;border-radius:50%;flex-shrink:0" onerror="this.outerHTML='<span style=font-size:24px>${ch.emoji}</span>'">
```

- [ ] **Step 4: Verify zero regression on web**

With `vercel dev` running, open `http://localhost:3000` in a desktop browser:

- Video grid loads with thumbnails and sidebar avatars.
- Tap a video → plays; Back → grid re-renders with progress strip.
- Settings (PIN 1234 or configured PIN) → channel list shows avatars.

Also confirm there are no remaining relative API references:

```bash
grep -n "'/api/\|\`/api/\|\"/api/" index.html
```

Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "Route all API and avatar URLs through API_BASE for native builds"
```

---

### Task 3: Capacitor project scaffold

**Files:**
- Modify: `package.json`
- Create: `capacitor.config.json`
- Create: `scripts/sync-www.sh`
- Modify: `.gitignore`
- Generated (committed): `ios/`, `android/`

- [ ] **Step 1: Install Capacitor packages**

```bash
npm install @capacitor/core @capacitor/ios @capacitor/android @capacitor/status-bar @capacitor/splash-screen @capacitor-community/keep-awake
npm install -D @capacitor/cli @capacitor/assets
```

(If npm reports a peer-dependency mismatch on `@capacitor-community/keep-awake`, install the major version matching the installed `@capacitor/core` major.)

- [ ] **Step 2: Create capacitor.config.json**

```json
{
  "appId": "com.davidhague.watchtime",
  "appName": "WatchTime",
  "webDir": "www"
}
```

- [ ] **Step 3: Create scripts/sync-www.sh**

```bash
#!/usr/bin/env bash
# Fills www/ (Capacitor's webDir) from the repo's web assets.
# www/ is generated — never edit it, never commit it.
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf www
mkdir -p www/icons
cp index.html www/
cp icons/*.png www/icons/
```

Then: `chmod +x scripts/sync-www.sh`

Note: `sw.js` and `manifest.json` are intentionally NOT copied — they are web-only.

- [ ] **Step 4: Add npm scripts and gitignore entry**

In `package.json` add:

```json
"scripts": {
  "sync": "bash scripts/sync-www.sh && npx cap sync",
  "ios": "npm run sync && npx cap open ios",
  "android": "npm run sync && npx cap open android"
}
```

Append to `.gitignore`:

```
www/
```

- [ ] **Step 5: Generate native projects**

```bash
bash scripts/sync-www.sh
npx cap add ios
npx cap add android
npm run sync
```

Expected: `ios/` and `android/` directories created; `npx cap sync` reports copying web assets and updating 3 plugins for each platform. (Capacitor's generated projects include their own `.gitignore`s for Pods/build artifacts.)

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json capacitor.config.json scripts/sync-www.sh .gitignore ios/ android/
git commit -m "Add Capacitor scaffold: iOS + Android projects wrapping index.html"
```

---

### Task 4: iOS playback spike — THE GATE

Spec risk #1: YouTube IFrame playback inside WKWebView (`capacitor://localhost` origin) must work before anything else is built. Do this on the iOS Simulator first, then a real iPhone if available.

**Files:** none (verification only; config changes only if fallbacks are needed)

- [ ] **Step 1: Run on the iOS Simulator**

```bash
npm run sync
npx cap run ios
```

Pick any iPhone simulator. App should launch showing the timer bar and video grid (grid loading proves API_BASE + CORS work end-to-end against production Vercel).

- [ ] **Step 2: Verify the playback checklist**

- Tap a video card → player screen opens, video plays.
- Audio is audible (autoplay-with-sound is the risky part in WKWebView).
- Tap the player area (shield) → pauses; tap again → resumes.
- Let a short video end → Up Next screen appears.
- Back → grid shows watch-progress strip; Continue Watching card appears.
- Kill and relaunch the app → Continue card still there (Redis round-trip).

- [ ] **Step 3: If videos show "Video unavailable" or error 150/101**

This is the known embed-origin restriction issue with `capacitor://` origins. Try fallbacks in this order, re-testing after each:

1. In `createPlayer()` playerVars, add `origin: 'https://pwa-watchtime-youtube.vercel.app'` and `widget_referrer: 'https://pwa-watchtime-youtube.vercel.app'`.
2. Test with several channels — some videos restrict embedding regardless of origin (that behavior exists on the web version too; compare against web before blaming the app).
3. Nuclear option (works, costs offline-ness): host the player page remotely — but STOP and discuss with David first; this changes the architecture.

- [ ] **Step 4: If autoplay fails (video loads paused)**

Check `ios/App/App/AppDelegate.swift` / Capacitor's WKWebView defaults — Capacitor normally sets `allowsInlineMediaPlayback = true` and does not require user action for playback. The player's `playerVars` already include `playsinline: 1` and `onReady` calls `playVideo()`. If it still fails, tapping the shield once to start is acceptable for v1 — note it and move on.

- [ ] **Step 5: Record the gate decision**

If playback works: append a dated note to the spec's "Risks & open items" section marking risk #1 resolved, commit:

```bash
git add docs/superpowers/specs/2026-07-09-capacitor-app-conversion-design.md
git commit -m "Mark WKWebView playback risk resolved after iOS spike"
```

If playback cannot be made acceptable: STOP the plan and reassess with David (the spec names this make-or-break).

---

### Task 5: Web-only guards and native KeepAwake/StatusBar

**Files:**
- Modify: `index.html` (wake lock functions, SW registration, fullscreen section, init)

- [ ] **Step 1: Route wake lock through KeepAwake when native**

Replace `acquireWakeLock` / `releaseWakeLock` with:

```js
async function acquireWakeLock() {
  if (IS_NATIVE) {
    try { await window.Capacitor.Plugins.KeepAwake.keepAwake(); } catch(e) {}
    return;
  }
  if ('wakeLock' in navigator) {
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch(e) {}
  }
}

function releaseWakeLock() {
  if (IS_NATIVE) {
    try { window.Capacitor.Plugins.KeepAwake.allowSleep(); } catch(e) {}
    return;
  }
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}
```

(The existing `visibilitychange` re-acquire listener stays — it is harmless and correct on both platforms.)

- [ ] **Step 2: Hide the status bar on native**

Directly after the `API_BASE` constant, add:

```js
if (IS_NATIVE) {
  try { window.Capacitor.Plugins.StatusBar.hide(); } catch(e) {}
}
```

- [ ] **Step 3: Guard service worker registration web-only**

Change:

```js
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
```

to:

```js
if (!IS_NATIVE && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
```

- [ ] **Step 4: Guard the fullscreen machinery web-only**

In the FULLSCREEN API section at the bottom of the script:

Change the hide-button condition from:

```js
if (window.matchMedia('(display-mode: standalone)').matches || navigator.standalone) {
  $('fullscreenBtn').style.display = 'none';
}
```

to:

```js
if (IS_NATIVE || window.matchMedia('(display-mode: standalone)').matches || navigator.standalone) {
  $('fullscreenBtn').style.display = 'none';
}
```

Change the auto-fullscreen condition from:

```js
if (!window.matchMedia('(display-mode: standalone)').matches && !navigator.standalone) {
```

to:

```js
if (!IS_NATIVE && !window.matchMedia('(display-mode: standalone)').matches && !navigator.standalone) {
```

(The `fullscreenchange` re-enter listener and `fullscreenBtn.onclick` can stay unguarded — with the button hidden and auto-enter disabled, fullscreen never activates natively, so they are inert.)

- [ ] **Step 5: Verify on both platforms**

Web (`vercel dev`, desktop browser): everything unchanged — fullscreen button still appears, videos play.

iOS (`npx cap run ios`): status bar hidden; start a session and confirm the simulator/device screen does not sleep mid-session (set device auto-lock to 30s to test); no fullscreen button in the timer bar.

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "Gate web-only code behind IS_NATIVE; use KeepAwake and StatusBar natively"
```

---

### Task 6: App icons and splash screens

**Files:**
- Create: `assets/icon.png` (1024×1024), `assets/splash.png` + `assets/splash-dark.png` (2732×2732)
- Generated: icon/splash sets inside `ios/` and `android/`

- [ ] **Step 1: Create source assets from the existing 512px icon**

```bash
mkdir -p assets
magick icons/icon-512.png -resize 1024x1024 assets/icon.png
magick -size 2732x2732 xc:'#0f0f1a' \( icons/icon-512.png \) -gravity center -composite assets/splash.png
cp assets/splash.png assets/splash-dark.png
```

(Upscaled 512→1024 is an acceptable placeholder; flag to David that a true 1024px source would sharpen the App Store icon later. `#0f0f1a` is the app's `--bg` color.)

- [ ] **Step 2: Generate all platform assets**

```bash
npx capacitor-assets generate
npm run sync
```

Expected: generated icons/splashes written into `ios/App/App/Assets.xcassets/` and `android/app/src/main/res/`.

- [ ] **Step 3: Verify**

`npx cap run ios` — home screen icon is the WatchTime icon; launch shows the dark splash before the app appears.

- [ ] **Step 4: Commit**

```bash
git add assets/ ios/ android/
git commit -m "Generate app icons and splash screens from existing icon"
```

---### Task 7: Android build and Fire 7 sideload

**Files:** none new (build + on-device verification)

- [ ] **Step 1: Build the debug APK**

```bash
npm run sync
cd android && ./gradlew assembleDebug && cd ..
ls -la android/app/build/outputs/apk/debug/app-debug.apk
```

Expected: APK exists. (First gradle run downloads dependencies — takes minutes.)

- [ ] **Step 2: Sideload onto the Fire 7**

On the Fire: Settings → Device Options → tap serial number 7× to enable Developer Options → enable ADB. Connect USB.

```bash
adb devices          # Fire shows up; accept the trust dialog on the tablet
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

- [ ] **Step 3: On-device verification checklist (parent profile)**

- App launches fullscreen, grid loads over Wi-Fi.
- Video plays with sound; shield tap pauses/resumes.
- Timer runs; time's up → celebration lock screen; PIN unlocks.
- Screen stays awake through a session longer than the device sleep timeout.
- Config changed on the web app (e.g., timer value) appears in the Fire app after relaunch.

- [ ] **Step 4: Amazon Kids / lockdown verification (spec open item #2)**

Try adding WatchTime to the kid profile: Parent settings → child profile → Add Content. If sideloaded apps don't appear there (Amazon sometimes only lists Appstore apps), the fallback is using the parent profile with **app pinning** (Settings → Security → App Pinning) — verify pinning holds and requires the lock code to exit. Record which path worked in the testing checklist doc (Task 10).

- [ ] **Step 5: Commit any Fire-specific fixes made along the way**

```bash
git add -A && git commit -m "Fire 7 verification fixes" # only if changes were needed
```

---

### Task 8: Remove Silk-era browser workarounds

Safe now — and only now: the Fire runs the native app (Task 7 verified), so nothing depends on Silk anymore. This deletion ships to web users on the next `vercel --prod`.

**Files:**
- Modify: `index.html` (delete rotate button, rotated CSS, Silk detection, global orientation lock)

- [ ] **Step 1: Delete the rotate button element**

Remove this line from the timer bar markup:

```html
<button class="back-btn" id="rotateBtn" style="background:var(--green);">🔄</button>
```

- [ ] **Step 2: Delete the body.rotated CSS block**

Remove all `body.rotated ...` rules (the block starting `body.rotated { overflow: hidden; }` through `body.rotated .split-view { height: 100vw; }`, plus the two later rules `body.rotated .player-container` and `body.rotated .player-wrapper`).

- [ ] **Step 3: Simplify showOnly()**

Change:

```js
  $('timerBar').classList.toggle('hidden', screenId === 'settingsScreen');
  const showNav = screenId === 'playerScreen' || screenId === 'upNextScreen';
  $('backBtn').style.display = showNav ? 'inline-flex' : 'none';
  const isSilk = /\bSilk\b/i.test(navigator.userAgent);
  $('rotateBtn').style.display = (showNav && !isSilk) ? 'inline-flex' : 'none';
```

to:

```js
  $('timerBar').classList.toggle('hidden', screenId === 'settingsScreen');
  const showNav = screenId === 'playerScreen' || screenId === 'upNextScreen';
  $('backBtn').style.display = showNav ? 'inline-flex' : 'none';
```

Also remove the `if (screenId === 'browseScreen') document.body.classList.remove('rotated');` line at the top of `showOnly` — nothing sets that class anymore.

- [ ] **Step 4: Delete the rotate handler and global orientation lock**

Remove:

```js
// Try to lock to landscape (works in installed PWA / fullscreen)
try { screen.orientation.lock('landscape').catch(() => {}); } catch(e) {}

// Manual rotate toggle
$('rotateBtn').onclick = () => {
  document.body.classList.toggle('rotated');
  // Scroll to player if it's visible
  if (!$('playerScreen').classList.contains('hidden')) {
    setTimeout(() => $('playerWrapper').scrollIntoView({ behavior: 'instant' }), 50);
  }
};
```

(The `screen.orientation.lock` call inside `goFullscreen()` stays — it's part of the web-only fullscreen path and still helps web tablets.)

- [ ] **Step 5: Verify no dangling references, on web and iOS**

```bash
grep -n "rotated\|rotateBtn\|Silk" index.html
```

Expected: no output. Then load web (`vercel dev`) and iOS (`npx cap run ios`): browse, play, back, settings — no console errors; rotating the device between portrait/landscape swaps the layouts as before.

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "Remove Silk-era rotate hack, UA sniffing, and global orientation lock"
```

---

### Task 9: iOS TestFlight distribution runbook

Manual Xcode/App Store Connect work; requires the Apple Developer account. Document-as-you-go.

- [ ] **Step 1: Configure signing**

`npm run ios` → in Xcode: select the App target → Signing & Capabilities → set Team to the developer account; bundle ID `com.davidhague.watchtime`; Version `1.0.0`, Build `1`.

- [ ] **Step 2: Create the app record**

On appstoreconnect.apple.com: My Apps → "+" → New App → platform iOS, bundle ID `com.davidhague.watchtime`, name (must be globally unique — try "WatchTime Session Timer" if "WatchTime" is taken; the home-screen display name stays "WatchTime" regardless).

- [ ] **Step 3: Archive and upload**

Xcode: select "Any iOS Device (arm64)" as destination → Product → Archive → Distribute App → App Store Connect → Upload (defaults fine).

- [ ] **Step 4: Set up TestFlight testers**

In App Store Connect → TestFlight: easiest for family is an **external testing** group with a public link (requires one-time Beta App Review, usually <24h; questionnaire: no login required, mention it needs a parent PIN 1234 default). Alternative with zero review: internal testing, but each tester must be added as a user on the App Store Connect team.

Family installs the TestFlight app, opens the invite link, installs WatchTime.

- [ ] **Step 5: iPhone verification checklist**

- Install via TestFlight on David's iPhone.
- Full pass of the Task 7 Step 3 checklist.
- Safe areas: timer bar clears the Dynamic Island/notch in both orientations.
- Guided Access: Settings → Accessibility → Guided Access on → triple-click side button in WatchTime → confirm home gesture is blocked and exiting requires the Guided Access passcode.

- [ ] **Step 6: Record distribution steps taken**

Append any deviations (app name chosen, review notes) to this plan file and commit.

---

### Task 10: Documentation and device test checklist

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md` (build/install section)
- Create: `docs/testing-checklist.md`

- [ ] **Step 1: Update CLAUDE.md**

Make these changes:

1. In **File structure**, add the missing endpoint and new files:

```
  watch-history.js               # GET/POST/DELETE per-video resume positions (Upstash Redis)
capacitor.config.json            # Capacitor app config (appId com.davidhague.watchtime, webDir www/)
scripts/sync-www.sh              # Copies index.html + icons into www/ for native builds
www/                             # GENERATED by sync-www.sh — gitignored, never edit
ios/, android/                   # Capacitor native projects (committed)
assets/                          # 1024px icon + splash sources for @capacitor/assets
```

2. Add a new section after **Vercel deployment**:

```markdown
## Native app builds (Capacitor)

- The same `index.html` powers web, iOS, and Android. `IS_NATIVE` (Capacitor detection) gates
  platform differences; `API_BASE` points native builds at the production Vercel API.
- Build: `npm run ios` / `npm run android` (runs scripts/sync-www.sh + cap sync, opens the IDE).
- Fire 7 install: `cd android && ./gradlew assembleDebug`, then `adb install -r android/app/build/outputs/apk/debug/app-debug.apk`.
- iOS distribution is via TestFlight (see docs/superpowers/plans/2026-07-09-capacitor-app-conversion.md Task 9).
- Native plugins in use: KeepAwake (screen on during sessions), StatusBar (hidden), SplashScreen.
- Web-only code (service worker, fullscreen+PIN machinery, Wake Lock API) must stay behind `!IS_NATIVE` guards.
- App-side changes require rebuild + reinstall; web deploys stay instant via `vercel --prod`.
```

3. In **Key design decisions**, update the "Fullscreen + Wake Lock" bullet to note it is web-only, and remove the rotate-hack implications if mentioned.

- [ ] **Step 2: Update README.md**

Add a short "Install as an app" section mirroring the CLAUDE.md build commands (TestFlight link for iOS once it exists, adb sideload for Fire).

- [ ] **Step 3: Create docs/testing-checklist.md**

```markdown
# WatchTime device testing checklist

Run per release, per platform (web / iPhone / Fire 7).

## Core pillars
- [ ] Timer: tap video starts session; countdown visible; colors shift green→yellow→red
- [ ] Time's up: player closes, celebration screen locks the app, confetti
- [ ] Parent unlock: wrong PIN shakes; correct PIN restores browse + reset timer
- [ ] Quick timer: PIN-gated; presets and +/- work; mid-session change applies
- [ ] Allowlist: only configured channels/playlists appear; add via @handle, URL, ID, playlist URL; remove works
- [ ] Continue Watching: card appears after partial watch, resumes at furthest position, disappears ≥95% watched
- [ ] Progress strips on cards match watched position
- [ ] Up Next after video ends: current-channel + other-channel suggestions

## Platform behaviors
- [ ] Screen stays awake through a session longer than device sleep timeout
- [ ] Portrait = single column; landscape = sidebar + 2-col grid
- [ ] Config change on another device appears after relaunch (shared Redis)
- [ ] Offline/flaky network: app falls back to cached config, empty feeds show friendly message
- [ ] iPhone: safe areas clear the notch/Dynamic Island; Guided Access blocks home gesture
- [ ] Fire: app pinning (or Amazon Kids profile) blocks exit; record which is in use
- [ ] Web only: fullscreen button appears; exiting fullscreen requires PIN
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md README.md docs/testing-checklist.md
git commit -m "Document Capacitor build workflow, watch-history endpoint, and device test checklist"
```

---

## Out of scope (explicitly deferred, per spec)

- Face ID/Touch ID parent unlock
- Public App Store release (Kids Category compliance, parental gates, privacy policy)
- Capacitor Live Updates
- Android navigation-bar immersive mode
- Replacing the upscaled 1024px icon with true hi-res art
