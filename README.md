# WatchTime

Kid-friendly YouTube session timer for Amazon Fire 7 tablet. Parent-controlled channels with a countdown timer that locks the screen when time's up.

## How it works

- **Parent mode** (PIN protected, default: `1234`): configure YouTube channels and session duration
- **Kid mode**: tap a channel card, browse the 10 most recent videos, tap to watch via YouTube embed
- **Session timer**: starts when a channel is tapped, counts down through browsing AND watching
- **Time's up**: video pauses, fullscreen lock overlay until parent enters PIN

## Architecture

Single `index.html` — no framework, no build step, no dependencies beyond the YouTube IFrame Player API.

One Vercel serverless function at `/api/yt-feed/[channelId].js` proxies YouTube's Atom RSS feed to avoid CORS issues. Responses cached 5 minutes at the edge.

Config (channels, timer, PIN) stored in `localStorage` — per-device, nothing server-side.

## Deployment

Hosted on Vercel: https://pwa-watchtime-youtube.vercel.app

Deploys automatically from `main` via `vercel --prod`. No build command needed.

## Development

```bash
vercel dev
```

Opens at `http://localhost:3000`. The API route works locally too.

## Default channels

| Channel | ID |
|---|---|
| Ms Rachel | `UCG2CL6EUjG8TVT1Tpl9nJdg` |
| Bluey | `UCVzLLZkDuFGAE2BGdBuBNBg` |
| Cocomelon | `UCbCmjCuTUZos6Inko4u57UQ` |

Parents can add/remove channels in settings (gear icon, PIN required).
