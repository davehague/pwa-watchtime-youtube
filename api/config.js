import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const DEFAULT_CONFIG = {
  pin: '1234',
  timerSeconds: 30,
  channels: [
    { name: 'Ms Rachel', id: 'UCG2CL6EUjG8TVT1Tpl9nJdg', emoji: '🎵', color: '#e94560' },
    { name: 'Bluey', id: 'UCVzLLZkDuFGAE2BGdBuBNBg', emoji: '🐶', color: '#3b82f6' },
    { name: 'Cocomelon', id: 'UCbCmjCuTUZos6Inko4u57UQ', emoji: '🍉', color: '#4ecca3' },
  ]
};

const KEY = 'config';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method === 'GET') {
    try {
      const config = await redis.get(KEY);
      if (config) {
        return res.status(200).json(config);
      }
      // Seed default config
      await redis.set(KEY, DEFAULT_CONFIG);
      return res.status(200).json(DEFAULT_CONFIG);
    } catch (e) {
      return res.status(500).json({ error: 'Failed to read config' });
    }
  }

  if (req.method === 'POST') {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      if (!body || !body.pin || !body.channels) {
        return res.status(400).json({ error: 'Invalid config' });
      }
      await redis.set(KEY, body);
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: 'Failed to save config' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
