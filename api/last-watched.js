import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const KEY = 'lastWatched';

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
      return res.status(200).json(data || null);
    } catch (e) {
      return res.status(500).json({ error: 'Failed to read lastWatched' });
    }
  }

  if (req.method === 'POST') {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      if (!body || !body.videoId || !body.title) {
        return res.status(400).json({ error: 'Invalid lastWatched' });
      }
      const payload = {
        videoId: String(body.videoId),
        title: String(body.title),
        channelId: body.channelId ? String(body.channelId) : null,
        channelName: body.channelName ? String(body.channelName) : null,
        position: Math.max(0, Math.floor(Number(body.position) || 0)),
        duration: Math.max(0, Math.floor(Number(body.duration) || 0)),
        savedAt: Date.now(),
      };
      await redis.set(KEY, payload);
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: 'Failed to save lastWatched' });
    }
  }

  if (req.method === 'DELETE') {
    try {
      await redis.del(KEY);
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: 'Failed to clear lastWatched' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
