# WatchTime

Kid-friendly YouTube session timer for Amazon Fire 7 tablet. Parent-controlled channels with a countdown timer that locks the screen when time's up.

## How it works

- **Parent mode** (PIN protected, default: `1234`): configure YouTube channels, session duration, and PIN
- **Kid mode**: tap a channel card (shows profile picture), browse recent videos, tap to watch via YouTube embed
- **Session timer**: starts when a channel is tapped, counts down through browsing AND watching
- **Up Next**: when a video ends, suggests more from the current channel plus picks from other channels
- **Shorts filtered**: YouTube Shorts are automatically excluded from video lists
- **Time's up**: video pauses, fullscreen lock overlay until parent enters PIN

## Architecture

Single `index.html` — all HTML/CSS/JS inline. No framework, no build step.

Vercel serverless functions handle backend work:

| Endpoint | Purpose |
|---|---|
| `/api/config` | GET/POST app config (stored in Upstash Redis) |
| `/api/yt-feed/[channelId]` | Fetches YouTube RSS feed, filters out Shorts, returns JSON |
| `/api/resolve-channel` | Resolves `@handles` and channel URLs to channel IDs + avatar URLs |
| `/api/avatar/[channelId]` | Proxies channel profile images (avoids Google CDN rate limits) |

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

## Development

```bash
vercel env pull    # pulls Upstash credentials to .env.local
vercel dev         # serves at http://localhost:3000
```

## Adding channels

In settings (gear icon, PIN required), paste any of these formats:

- `https://www.youtube.com/@ChannelName`
- `@ChannelName`
- `https://www.youtube.com/channel/UCxxxxxxx`
- `UCxxxxxxx`

The app resolves `@handles` to channel IDs automatically and fetches the channel's profile picture.
