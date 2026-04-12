export default async function handler(req, res) {
  const { handle } = req.query;

  if (!handle) {
    return res.status(400).json({ error: 'Missing handle parameter' });
  }

  // Strip @ if present
  const clean = handle.startsWith('@') ? handle : `@${handle}`;

  try {
    const resp = await fetch(`https://www.youtube.com/${clean}`, {
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!resp.ok) {
      return res.status(404).json({ error: 'Channel not found' });
    }
    const html = await resp.text();
    const match = html.match(/"channelId":"(UC[\w-]+)"/);
    if (!match) {
      return res.status(404).json({ error: 'Could not extract channel ID' });
    }
    return res.status(200).json({ channelId: match[1] });
  } catch (e) {
    return res.status(502).json({ error: 'Failed to resolve channel' });
  }
}
