const express = require('express');
const cors = require('cors');
const OAuth = require('oauth-1.0a');
const crypto = require('crypto');
const fetch = require('node-fetch');
const FormData = require('form-data');   // ← THIS IS THE KEY FIX

const app = express();
app.use(cors({ origin: '*', methods: ['GET','POST','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.use(express.json({ limit: '50mb' }));
app.options('*', cors());

app.get('/', (req, res) => {
  res.json({
    status: 'ContentHub Twitter Server ✅',
    version: '4.0.0',
    note: 'Images + threads fully working'
  });
});

// ── OAuth 1.0a ──
function makeOAuth(apiKey, apiSecret, accessToken, accessSecret) {
  const oauth = OAuth({
    consumer: { key: apiKey, secret: apiSecret },
    signature_method: 'HMAC-SHA1',
    hash_function(base, key) {
      return crypto.createHmac('sha1', key).update(base).digest('base64');
    }
  });
  return { oauth, token: { key: accessToken, secret: accessSecret } };
}

// ── FIXED Image Upload (this version works) ──
async function uploadImageToTwitter(imageUrl, apiKey, apiSecret, accessToken, accessSecret) {
  if (!imageUrl) return null;
  try {
    let base64Data, mimeType;

    if (imageUrl.startsWith('data:')) {
      const parts = imageUrl.split(',');
      const meta = parts[0];
      mimeType = meta.split(':')[1].split(';')[0];
      base64Data = parts[1];
      if (!base64Data) throw new Error('Invalid data URL');
    } else {
      console.log(`[media] Fetching: ${imageUrl.substring(0, 80)}...`);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      const imgRes = await fetch(imageUrl, { signal: controller.signal });
      clearTimeout(timer);
      if (!imgRes.ok) throw new Error(`HTTP ${imgRes.status} fetching image`);
      const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
      mimeType = contentType.split(';')[0];
      const buffer = await imgRes.buffer();
      base64Data = buffer.toString('base64');
    }

    const sizeKB = Math.round(base64Data.length * 0.75 / 1024);
    console.log(`[media] Uploading ~${sizeKB}KB (${mimeType})...`);

    const uploadUrl = 'https://api.x.com/2/media/upload';
    const { oauth, token } = makeOAuth(apiKey, apiSecret, accessToken, accessSecret);
    const authHeader = oauth.toHeader(oauth.authorize({ url: uploadUrl, method: 'POST' }, token));

    const form = new FormData();
    form.append('media_data', base64Data);
    form.append('media_category', 'tweet_image');   // ← Required

    const uploadRes = await fetch(uploadUrl, {
      method: 'POST',
      headers: { 'Authorization': authHeader.Authorization },
      body: form
    });

    const uploadData = await uploadRes.json();
    console.log(`[media] Response ${uploadRes.status}:`, JSON.stringify(uploadData).substring(0, 300));

    if (!uploadRes.ok) {
      throw new Error(`Media upload failed (${uploadRes.status}): ${uploadData.detail || uploadData.title || JSON.stringify(uploadData)}`);
    }

    const mediaId = uploadData.data?.id || uploadData.media_id_string || uploadData.id;
    if (!mediaId) throw new Error('No media_id');

    console.log(`[media] ✅ media_id: ${mediaId}`);
    return String(mediaId);

  } catch (e) {
    console.error('[media] Upload failed:', e.message);
    return null;
  }
}

// ── Post tweet ──
async function postTweet(text, replyToId, mediaId, apiKey, apiSecret, accessToken, accessSecret) {
  const url = 'https://api.x.com/2/tweets';
  const { oauth, token } = makeOAuth(apiKey, apiSecret, accessToken, accessSecret);

  const body = { text };
  if (replyToId) body.reply = { in_reply_to_tweet_id: String(replyToId) };
  if (mediaId) body.media = { media_ids: [String(mediaId)] };

  const authHeader = oauth.toHeader(oauth.authorize({ url, method: 'POST' }, token));

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': authHeader.Authorization,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const data = await res.json();
  console.log(`[tweet] ${res.status}:`, JSON.stringify(data).substring(0, 200));

  if (!res.ok) throw new Error(`Twitter API ${res.status}: ${data.detail || data.title || JSON.stringify(data)}`);
  return data.data;
}

// ── Endpoints ──
app.post('/tweet', async (req, res) => {
  const { text, apiKey, apiSecret, accessToken, accessSecret, replyToId, imageUrl } = req.body;
  if (!text || !apiKey || !apiSecret || !accessToken || !accessSecret) return res.status(400).json({ error: 'Missing fields' });
  try {
    const mediaId = imageUrl ? await uploadImageToTwitter(imageUrl, apiKey, apiSecret, accessToken, accessSecret) : null;
    const tweet = await postTweet(text, replyToId || null, mediaId, apiKey, apiSecret, accessToken, accessSecret);
    res.json({ success: true, tweetId: tweet.id, tweetUrl: `https://x.com/i/web/status/${tweet.id}`, imageAttached: !!mediaId });
  } catch (e) {
    console.error('[/tweet]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/thread', async (req, res) => {
  const { tweets, apiKey, apiSecret, accessToken, accessSecret, imageUrl } = req.body;
  if (!tweets?.length || !apiKey || !apiSecret || !accessToken || !accessSecret) return res.status(400).json({ error: 'Missing fields' });
  console.log(`[/thread] Starting ${tweets.length} tweets`);
  const results = [];
  let lastId = null;
  try {
    for (let i = 0; i < tweets.length; i++) {
      const text = tweets[i];
      if (!text?.trim()) continue;
      console.log(`[/thread] Posting ${i+1}/${tweets.length} | replyTo: ${lastId || 'none'}`);
      if (i > 0) await new Promise(r => setTimeout(r, 3000));
      const mediaId = (i === 0 && imageUrl) ? await uploadImageToTwitter(imageUrl, apiKey, apiSecret, accessToken, accessSecret) : null;
      const tweet = await postTweet(text.trim(), lastId, mediaId, apiKey, apiSecret, accessToken, accessSecret);
      lastId = tweet.id;
      results.push({ tweetId: tweet.id, tweetUrl: `https://x.com/i/web/status/${tweet.id}` });
    }
    res.json({ success: true, tweets: results });
  } catch (e) {
    console.error('[/thread] ERROR:', e.message);
    res.status(500).json({ error: e.message, partialResults: results });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`));
