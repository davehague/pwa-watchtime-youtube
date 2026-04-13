# WatchTime

Kid-friendly YouTube session timer for Amazon Fire 7 tablet. Parent-controlled channels and playlists with a countdown timer that locks the screen when time's up.

## How it works

- **Parent mode** (PIN protected, default: `1234`): configure YouTube channels/playlists, session duration, and PIN
- **Kid mode**: split-screen browse layout — feed sidebar (left) with video grid (right), round-robin interleaved from all feeds
- **Channels and playlists**: add YouTube channels (latest videos via RSS) or playlists (random selection via YouTube Data API)
- **Session timer**: starts when a video is tapped, counts down through browsing AND watching
- **Fullscreen**: auto-enters fullscreen on first interaction; exiting fullscreen requires PIN
- **Wake lock**: screen stays on during active sessions
- **Shorts filtered**: YouTube Shorts are automatically excluded from channel video lists
- **Time's up**: video pauses, fullscreen lock overlay until parent enters PIN
- **Responsive**: landscape shows split-screen with feed sidebar; portrait hides sidebar and shows all-channel grid

## Architecture

Single `index.html` — all HTML/CSS/JS inline. No framework, no build step.

Vercel serverless functions handle backend work:

| Endpoint | Purpose |
|---|---|
| `/api/config` | GET/POST app config (stored in Upstash Redis) |
| `/api/yt-feed/[channelId]` | Fetches videos — RSS for channels, YouTube Data API for playlists. Filters Shorts. |
| `/api/resolve-channel` | Resolves `@handles` and channel URLs to channel IDs + avatar URLs |
| `/api/avatar/[channelId]` | Proxies channel profile images (avoids Google CDN rate limits) |
| `/api/playlist-info` | Fetches playlist thumbnail from YouTube Data API |

Config (channels, timer, PIN) stored in **Upstash Redis** with localStorage as offline fallback.

Installable as a **PWA** via service worker and manifest.

## Deployment

Hosted on Vercel: https://pwa-watchtime-youtube.vercel.app

```bash
vercel --prod
```

### Required setup

1. Link an **Upstash for Redis** store to the project in the Vercel dashboard (prefix: `KV`)
2. This provides `KV_REST_API_URL` and `KV_REST_API_TOKEN` env vars automatically
3. Set `YOUTUBE_API_KEY` env var for playlist support (YouTube Data API v3)

## Development

```bash
vercel env pull    # pulls Upstash credentials to .env.local
vercel dev         # serves at http://localhost:3000
```

## Adding channels and playlists

In settings (gear icon, PIN required), paste any of these formats:

- `https://www.youtube.com/@ChannelName`
- `@ChannelName`
- `https://www.youtube.com/channel/UCxxxxxxx`
- `UCxxxxxxx`
- `https://www.youtube.com/playlist?list=PLxxxxxxx`

The app resolves `@handles` to channel IDs automatically and fetches the channel's profile picture. Playlists use the YouTube Data API to fetch all items and show a random 10 per session.
