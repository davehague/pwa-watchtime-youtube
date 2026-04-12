export default async function handler(req, res) {
  const { channelId } = req.query;

  if (!channelId || !channelId.startsWith('UC')) {
    return res.status(400).send('Invalid channel ID');
  }

  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;

  try {
    const response = await fetch(feedUrl, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) {
      return res.status(response.status).send('YouTube feed error');
    }
    const xml = await response.text();
    res.setHeader('Content-Type', 'application/xml');
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).send(xml);
  } catch (e) {
    return res.status(502).send('Failed to fetch feed');
  }
}
