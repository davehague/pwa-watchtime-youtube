export default async function handler(req, res) {
  const { channelId } = req.query;

  if (!channelId || (!channelId.startsWith('UC') && !channelId.startsWith('PL'))) {
    return res.status(400).send('Invalid channel or playlist ID');
  }

  const param = channelId.startsWith('PL') ? 'playlist_id' : 'channel_id';
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?${param}=${channelId}`;

  try {
    const response = await fetch(feedUrl, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) {
      return res.status(response.status).send('YouTube feed error');
    }
    const xml = await response.text();

    // Extract video IDs to check for Shorts
    const videoIds = [...xml.matchAll(/<yt:videoId>([^<]+)<\/yt:videoId>/g)].map(m => m[1]);

    // Check which are Shorts (200 = Short, 303 redirect = regular video)
    const shortsChecks = await Promise.all(
      videoIds.map(async id => {
        try {
          const r = await fetch(`https://www.youtube.com/shorts/${id}`, {
            method: 'HEAD',
            redirect: 'manual',
            headers: { 'User-Agent': 'Mozilla/5.0' },
            signal: AbortSignal.timeout(4000),
          });
          return { id, isShort: r.status === 200 };
        } catch {
          return { id, isShort: false };
        }
      })
    );
    const shortsSet = new Set(shortsChecks.filter(c => c.isShort).map(c => c.id));

    // Return JSON instead of XML for easier client-side handling
    const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)];
    const videos = entries
      .map(m => {
        const block = m[1];
        const id = block.match(/<yt:videoId>([^<]+)/)?.[1] || '';
        const title = block.match(/<title>([^<]+)/)?.[1] || '';
        return { videoId: id, title };
      })
      .filter(v => v.videoId && !shortsSet.has(v.videoId));

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json(videos);
  } catch (e) {
    return res.status(502).send('Failed to fetch feed');
  }
}
