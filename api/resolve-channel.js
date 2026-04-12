export default async function handler(req, res) {
  const { handle, channelId } = req.query;

  if (!handle && !channelId) {
    return res.status(400).json({ error: 'Missing handle or channelId parameter' });
  }

  // Build the URL to fetch
  let url;
  if (channelId) {
    url = `https://www.youtube.com/channel/${channelId}`;
  } else {
    const clean = handle.startsWith('@') ? handle : `@${handle}`;
    url = `https://www.youtube.com/${clean}`;
  }

  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!resp.ok) {
      return res.status(404).json({ error: 'Channel not found' });
    }
    const html = await resp.text();
    const idMatch = html.match(/"(?:channelId|externalId)":"(UC[\w-]+)"/);
    const resolvedId = channelId || (idMatch ? idMatch[1] : null);
    if (!resolvedId) {
      return res.status(404).json({ error: 'Could not extract channel ID' });
    }
    const avatarMatch = html.match(/https:\/\/yt3\.googleusercontent\.com\/[^"=]+/);
    const avatar = avatarMatch ? avatarMatch[0] + '=s176' : null;
    return res.status(200).json({ channelId: resolvedId, avatar });
  } catch (e) {
    return res.status(502).json({ error: 'Failed to resolve channel' });
  }
}
