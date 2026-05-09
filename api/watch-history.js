import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const KEY = 'watchHistory';

const ONE_DAY_SEC = 86400;

function sanitizeEntry(body) {
  if (!body || !body.videoId || !body.title) return null;
  // Cap each field so a malformed POST can't bloat the single Redis blob.
  return {
    videoId: String(body.videoId).slice(0, 32),
    title: String(body.title).slice(0, 200),
    channelId: body.channelId ? String(body.channelId).slice(0, 32) : null,
    channelName: body.channelName ? String(body.channelName).slice(0, 200) : null,
    position: Math.min(ONE_DAY_SEC, Math.max(0, Math.floor(Number(body.position) || 0))),
    duration: Math.min(ONE_DAY_SEC, Math.max(0, Math.floor(Number(body.duration) || 0))),
    savedAt: Date.now(),
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method === 'GET') {
    try {
      const data = await redis.get(KEY);
      return res.status(200).json(data && typeof data === 'object' ? data : {});
    } catch (e) {
      return res.status(500).json({ error: 'Failed to read watch history' });
    }
  }

  if (req.method === 'POST') {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const entry = sanitizeEntry(body);
      if (!entry) return res.status(400).json({ error: 'Invalid entry' });
      const existing = (await redis.get(KEY)) || {};
      const map = typeof existing === 'object' && existing !== null ? existing : {};
      map[entry.videoId] = entry;
      await redis.set(KEY, map);
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: 'Failed to save entry' });
    }
  }

  if (req.method === 'DELETE') {
    try {
      const url = new URL(req.url, 'http://x');
      const videoId = url.searchParams.get('videoId');
      // No videoId = clear everything.
      if (!videoId) {
        await redis.del(KEY);
        return res.status(200).json({ ok: true, cleared: 'all' });
      }
      const existing = (await redis.get(KEY)) || {};
      const map = typeof existing === 'object' && existing !== null ? existing : {};
      if (map[videoId]) {
        delete map[videoId];
        await redis.set(KEY, map);
      }
      return res.status(200).json({ ok: true, cleared: videoId });
    } catch (e) {
      return res.status(500).json({ error: 'Failed to delete entry' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
