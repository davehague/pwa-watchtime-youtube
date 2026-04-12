# Server-Side Config via Vercel KV

## Summary

Move all app config (channels, timer, PIN) from localStorage-only to Vercel KV as the primary store, with localStorage as an offline fallback cache.

## Data Flow

- On app load, `GET /api/config` fetches full config from Vercel KV
- If KV has no config yet, the API returns `DEFAULT_CONFIG` and seeds it into KV
- The app uses fetched config exactly like it uses `cfg` today
- On "Save & Exit" in settings, `POST /api/config` writes full config to KV
- localStorage is a fallback cache — if API fails (offline, etc.), app falls back to localStorage

## API Design

### `api/config.js` — single endpoint, method-switched

- **GET**: Read config from KV, return JSON. If no key exists, seed `DEFAULT_CONFIG` and return it
- **POST**: Receive full config JSON in body, write to KV, return `{ ok: true }`

KV key: `"config"` — single key holding entire config object.

No auth on the API — PIN protection is UI-only.

## Changes to `index.html`

- `loadConfig()` becomes async — fetches `/api/config` first, falls back to localStorage
- `saveConfig()` becomes async — POSTs to `/api/config`, also writes to localStorage as cache
- App init awaits `loadConfig()` before `renderChannels()` and `resetTimerUI()`
- Brief loading state while config fetches (spinner in channel grid)
- Everything else unchanged — same PIN flow, same settings UI, same single-file structure

## Implementation Steps

1. Set up Vercel KV store and install `@vercel/kv` dependency
2. Create `api/config.js` serverless function (GET/POST)
3. Update `index.html` — async loadConfig/saveConfig, init flow, loading state
4. Test locally with `vercel dev`
5. Deploy and verify
