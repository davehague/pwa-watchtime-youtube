# WatchTime - Claude Code Context

## Project overview

Single-file HTML app (`index.html`) that acts as a kid-friendly YouTube session timer. Designed for Amazon Fire 7 tablet running in Amazon Kids browser with a whitelisted URL. Also used on iPhones and other devices.

## Tech stack

- **Frontend**: Single `index.html` file — all HTML/CSS/JS inline. No framework, no build step.
- **Backend**: Vercel serverless functions (Node.js, ESM) in the `api/` directory.
- **Storage**: Upstash Redis (via `@upstash/redis`) for server-side config persistence. localStorage as offline fallback cache.
- **Dependencies**: Only `@upstash/redis` in `package.json`. The `package.json` exists solely for this dependency — there is no build step.
- **PWA**: Service worker (`sw.js`) + `manifest.json` for installability. Beware: the SW caches `index.html` aggressively — users may need hard refresh after deploys.

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

## File structure

```
index.html                       # The entire app (HTML/CSS/JS)
manifest.json                    # PWA manifest
sw.js                            # Service worker for PWA
package.json                     # Only dependency: @upstash/redis
api/
  config.js                      # GET/POST app config (Upstash Redis)
  yt-feed/[channelId].js         # Channels: RSS + Shorts filter. Playlists: YouTube Data API + shuffle.
  resolve-channel.js             # Resolves @handles and channel IDs → { channelId, avatar }
  avatar/[channelId].js          # Proxies channel profile images from Google CDN
  playlist-info.js               # Fetches playlist thumbnail from YouTube Data API
docs/plans/                      # Design documents
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

## Things to watch out for

- YouTube IFrame Player API is loaded from `https://www.youtube.com/iframe_api` — no local copy
- The `fetchVideos()` function in index.html calls `/api/yt-feed/${channelId}` — returns JSON (not XML) with Shorts already filtered out
- Channel IDs must start with `UC`, playlist IDs with `PL` — the settings UI validates this
- Adding channels supports `@handle` URLs, full channel URLs, raw channel IDs, or playlist URLs — the `/api/resolve-channel` endpoint resolves channels
- The YouTube channel page uses either `"channelId"` or `"externalId"` for the channel ID — the resolver checks both
- The app uses `touch-action: manipulation` and `-webkit-tap-highlight-color: transparent` for tablet UX — don't remove these
- The yt-feed endpoint makes HEAD requests to YouTube `/shorts/<id>` for each video to filter Shorts — this adds latency (~2-4s). Client timeout is 15s.

## What NOT to do

- Don't split index.html into multiple files
- Don't change the timer from session-based to per-video
- Don't add authentication on API endpoints (PIN is UI-only by design)
- Don't hotlink `yt3.googleusercontent.com` directly — use the `/api/avatar/` proxy to avoid 429s
- Don't re-add color picker for channel cards — it was removed as unused after the split-screen layout change
