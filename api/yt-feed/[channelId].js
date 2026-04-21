import { Redis } from '@upstash/redis';

const redis = process.env.KV_REST_API_URL
  ? new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN })
  : null;

const CACHE_PREFIX = 'feed:';
const SHORTS_PREFIX = 'short:';
const PLAYLIST_PREFIX = 'playlist:';
const SHORTS_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days — a video's Short status never changes
const PLAYLIST_TTL_SECONDS = 60 * 60 * 12;    // 12 hours — refetch playlist contents twice/day
const STALE_TTL_SECONDS = 60 * 60 * 24 * 7;   // 7 days — stale fallback cache

export default async function handler(req, res) {
  const { channelId } = req.query;

  if (!channelId || (!channelId.startsWith('UC') && !channelId.startsWith('PL'))) {
    return res.status(400).send('Invalid channel or playlist ID');
  }

  try {
    let videos;

    if (channelId.startsWith('PL') && process.env.YOUTUBE_API_KEY) {
      // Playlists rarely change — cache full contents in Redis for 12h to avoid
      // paginating the entire playlist on every cache miss.
      let pool = null;
      if (redis) {
        try { pool = await redis.get(PLAYLIST_PREFIX + channelId); } catch {}
      }
      if (!Array.isArray(pool) || !pool.length) {
        pool = await fetchPlaylistVideos(channelId);
        if (redis && pool.length) {
          redis.set(PLAYLIST_PREFIX + channelId, pool, { ex: PLAYLIST_TTL_SECONDS }).catch(() => {});
        }
      }
      // Shuffle and return up to 50 — client picks 10 to show and re-shuffles locally
      videos = pool.slice();
      shuffle(videos);
      videos = videos.slice(0, 50);
    } else {
      // Use RSS feed for channels (free, no quota)
      try {
        videos = await fetchRSSVideos(channelId);
      } catch (rssErr) {
        // RSS fails for "Made for Kids" channels and during YouTube flakiness.
        // Fall back to Data API uploads playlist (UC… → UU…).
        if (!process.env.YOUTUBE_API_KEY) throw rssErr;
        const uploadsId = 'UU' + channelId.slice(2);
        videos = await fetchPlaylistVideos(uploadsId, { maxPages: 1 });
        videos = videos.slice(0, 15);
      }
    }

    // Cache last-good response for stale fallback
    if (redis && videos.length) {
      redis.set(CACHE_PREFIX + channelId, videos, { ex: STALE_TTL_SECONDS }).catch(() => {});
    }

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json(videos);
  } catch (e) {
    // Both RSS and Data API failed — serve stale from Redis if we have it
    if (redis) {
      try {
        const stale = await redis.get(CACHE_PREFIX + channelId);
        if (stale && Array.isArray(stale) && stale.length) {
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('X-From-Stale-Cache', '1');
          res.setHeader('Access-Control-Allow-Origin', '*');
          return res.status(200).json(stale);
        }
      } catch {}
    }
    return res.status(502).send('Failed to fetch feed');
  }
}

// Fisher-Yates shuffle
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

async function fetchPlaylistVideos(playlistId, { maxPages = Infinity } = {}) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  const allVideos = [];
  let pageToken = '';
  let pages = 0;

  // Paginate through all playlist items (50 per page)
  do {
    if (pages++ >= maxPages) break;
    const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50&playlistId=${playlistId}&key=${apiKey}${pageToken ? '&pageToken=' + pageToken : ''}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) {
      // Partial failure on page 2+ would poison a 12h cache with a truncated pool.
      // Fail the whole request so the caller can fall back or serve stale.
      if (pages > 1) throw new Error(`Playlist fetch failed on page ${pages}: ${resp.status}`);
      break;
    }
    const data = await resp.json();

    for (const item of data.items || []) {
      const vid = item.snippet?.resourceId?.videoId;
      const title = item.snippet?.title;
      if (vid && title && title !== 'Private video' && title !== 'Deleted video') {
        allVideos.push({ videoId: vid, title });
      }
    }

    pageToken = data.nextPageToken || '';
  } while (pageToken);

  return allVideos;
}

// Classify which video IDs are Shorts, using Redis to cache results long-term.
// Returns a Set of IDs that are Shorts.
async function classifyShorts(videoIds) {
  if (!videoIds.length) return new Set();

  const keys = videoIds.map(id => SHORTS_PREFIX + id);
  let cached = [];
  if (redis) {
    try { cached = await redis.mget(...keys); } catch { cached = []; }
  }

  const shortsSet = new Set();
  const toProbe = [];
  videoIds.forEach((id, i) => {
    const v = cached[i];
    if (v === 1 || v === '1') shortsSet.add(id);
    else if (v === 0 || v === '0') { /* known not-short */ }
    else toProbe.push(id);
  });

  if (toProbe.length) {
    const results = await Promise.all(
      toProbe.map(async id => {
        try {
          const r = await fetch(`https://www.youtube.com/shorts/${id}`, {
            method: 'HEAD',
            redirect: 'manual',
            headers: { 'User-Agent': 'Mozilla/5.0' },
            signal: AbortSignal.timeout(4000),
          });
          return { id, isShort: r.status === 200, ok: true };
        } catch {
          return { id, isShort: false, ok: false };
        }
      })
    );

    if (redis) {
      const pipe = redis.pipeline();
      let writes = 0;
      for (const { id, isShort, ok } of results) {
        if (!ok) continue; // don't cache probe failures
        pipe.set(SHORTS_PREFIX + id, isShort ? 1 : 0, { ex: SHORTS_TTL_SECONDS });
        writes++;
      }
      if (writes) pipe.exec().catch(() => {});
    }

    for (const { id, isShort } of results) if (isShort) shortsSet.add(id);
  }

  return shortsSet;
}

async function fetchRSSVideos(channelId) {
  const param = channelId.startsWith('PL') ? 'playlist_id' : 'channel_id';
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?${param}=${channelId}`;

  const response = await fetch(feedUrl, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error('YouTube feed error');
  const xml = await response.text();

  // Extract video IDs to check for Shorts
  const videoIds = [...xml.matchAll(/<yt:videoId>([^<]+)<\/yt:videoId>/g)].map(m => m[1]);
  const shortsSet = await classifyShorts(videoIds);

  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)];
  return entries
    .map(m => {
      const block = m[1];
      const id = block.match(/<yt:videoId>([^<]+)/)?.[1] || '';
      const title = block.match(/<title>([^<]+)/)?.[1] || '';
      return { videoId: id, title };
    })
    .filter(v => v.videoId && !shortsSet.has(v.videoId));
}
