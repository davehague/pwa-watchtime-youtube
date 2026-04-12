export default async function handler(req, res) {
  const { playlistId } = req.query;
  const apiKey = process.env.YOUTUBE_API_KEY;

  if (!playlistId || !playlistId.startsWith('PL')) {
    return res.status(400).json({ error: 'Invalid playlist ID' });
  }

  if (!apiKey) {
    return res.status(200).json({ playlistId, thumbnail: null });
  }

  try {
    const url = `https://www.googleapis.com/youtube/v3/playlists?part=snippet&id=${playlistId}&key=${apiKey}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) {
      return res.status(200).json({ playlistId, thumbnail: null });
    }
    const data = await resp.json();
    const item = data.items?.[0];
    const thumbnail = item?.snippet?.thumbnails?.high?.url
      || item?.snippet?.thumbnails?.medium?.url
      || item?.snippet?.thumbnails?.default?.url
      || null;

    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
    return res.status(200).json({ playlistId, thumbnail });
  } catch (e) {
    return res.status(200).json({ playlistId, thumbnail: null });
  }
}
