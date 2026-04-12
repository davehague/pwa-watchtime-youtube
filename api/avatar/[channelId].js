export default async function handler(req, res) {
  const { channelId } = req.query;

  if (!channelId || !channelId.startsWith('UC')) {
    return res.status(400).send('Invalid channel ID');
  }

  try {
    // Fetch the channel page to find the avatar URL
    const pageResp = await fetch(`https://www.youtube.com/channel/${channelId}`, {
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!pageResp.ok) {
      return res.status(404).send('Channel not found');
    }
    const html = await pageResp.text();
    const match = html.match(/https:\/\/yt3\.googleusercontent\.com\/[^"=]+/);
    if (!match) {
      return res.status(404).send('Avatar not found');
    }

    // Fetch the actual image
    const imgResp = await fetch(match[0] + '=s176', {
      signal: AbortSignal.timeout(8000),
    });
    if (!imgResp.ok) {
      return res.status(502).send('Failed to fetch avatar');
    }

    const buffer = Buffer.from(await imgResp.arrayBuffer());
    const contentType = imgResp.headers.get('content-type') || 'image/jpeg';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
    return res.status(200).send(buffer);
  } catch (e) {
    return res.status(502).send('Failed to fetch avatar');
  }
}
