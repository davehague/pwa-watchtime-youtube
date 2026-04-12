# WatchTime - Claude Code Context

## Project overview

Single-file HTML app (`index.html`) that acts as a kid-friendly YouTube session timer. Designed for Amazon Fire 7 tablet running in Amazon Kids browser with a whitelisted URL.

## Key design decisions

- **Single file**: All HTML/CSS/JS lives in `index.html`. No framework, no build step, no npm. Keep it this way.
- **Timer is session-based**: Starts when a channel card is tapped, runs continuously through browsing and video watching. NOT per-video.
- **Timer units**: Currently in seconds for testing (default 30s). Will switch to minutes later — the settings label mentions this.
- **PIN protection**: 4-digit PIN guards settings and the "time's up" unlock. Default: `1234`.
- **localStorage only**: All config is per-device. No server-side state, no auth, no database.

## File structure

```
index.html                    # The entire app
api/yt-feed/[channelId].js    # Vercel serverless function — proxies YouTube RSS to avoid CORS
```

## Vercel deployment

- Hosted at: https://pwa-watchtime-youtube.vercel.app
- Deploy: `vercel --prod` from project root
- Local dev: `vercel dev` (serves both static files and API routes)
- The API route fetches `https://www.youtube.com/feeds/videos.xml?channel_id=XXX` server-side and returns XML with 5-minute edge cache

## Things to watch out for

- YouTube IFrame Player API is loaded from `https://www.youtube.com/iframe_api` — no local copy
- The `fetchVideos()` function in index.html calls `/api/yt-feed/${channelId}` — this is the Vercel serverless function, not an external API
- Channel IDs must start with `UC` — the settings UI validates this
- The app uses `touch-action: manipulation` and `-webkit-tap-highlight-color: transparent` for tablet UX — don't remove these

## What NOT to do

- Don't add npm, package.json, or a build step
- Don't split index.html into multiple files
- Don't change the timer from session-based to per-video
- Don't add authentication or server-side user state
