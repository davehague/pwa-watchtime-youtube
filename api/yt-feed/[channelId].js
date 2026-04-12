export default async function handler(req, res) {
  const { channelId } = req.query;

  if (!channelId || (!channelId.startsWith('UC') && !channelId.startsWith('PL'))) {
    return res.status(400).send('Invalid channel or playlist ID');
  }

  try {
    let videos;

    if (channelId.startsWith('PL') && process.env.YOUTUBE_API_KEY) {
      // Use YouTube Data API for playlists (fetches all items, not just 15)
      videos = await fetchPlaylistVideos(channelId);
      // Shuffle and pick 10 random videos per session
      shuffle(videos);
      videos = videos.slice(0, 10);
    } else {
      // Use RSS feed for channels (free, no quota)
      videos = await fetchRSSVideos(channelId);
    }

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json(videos);
  } catch (e) {
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

async function fetchPlaylistVideos(playlistId) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  const allVideos = [];
  let pageToken = '';

  // Paginate through all playlist items (50 per page)
  do {
    const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50&playlistId=${playlistId}&key=${apiKey}${pageToken ? '&pageToken=' + pageToken : ''}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) break;
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

async function fetchRSSVideos(channelId) {
  const param = channelId.startsWith('PL') ? 'playlist_id' : 'channel_id';
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?${param}=${channelId}`;

  const response = await fetch(feedUrl, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error('YouTube feed error');
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
