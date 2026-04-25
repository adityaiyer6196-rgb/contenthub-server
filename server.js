const express = require('express');
const cors = require('cors');
const OAuth = require('oauth-1.0a');
const crypto = require('crypto');
const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors({ origin: '*', methods: ['GET','POST','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.use(express.json({ limit: '50mb' }));
app.options('*', cors());

app.get('/', (req, res) => {
  res.json({ status: 'ContentHub Twitter Server ✅', version: '3.2.0' });
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

// ── Upload image via multipart/form-data (correct OAuth signing) ──
async function uploadBase64ToTwitter(base64Data, apiKey, apiSecret, accessToken, accessSecret) {
  const url = 'https://upload.twitter.com/1.1/media/upload.json';
  const { oauth, token } = makeOAuth(apiKey, apiSecret, accessToken, accessSecret);

  // For multipart POST: sign only URL+method, NOT the body — this is correct per OAuth 1.0a spec
  const authHeader = oauth.toHeader(oauth.authorize({ url, method: 'POST' }, token));

  const sizeKB = Math.round(base64Data.length * 0.75 / 1024);
  console.log(`[uploadMedia] Uploading via multipart (~${sizeKB}KB decoded)...`);

  // Use multipart/form-data — correct for binary data and large files
  // Node 18+ has built-in FormData
  const form = new FormData();
  form.append('media_data', base64Data);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': authHeader.Authorization
      // Do NOT set Content-Type manually — fetch sets it with boundary for FormData
    },
    body: form
  });

  const data = await res.json();
  console.log(`[uploadMedia] Response ${res.status}:`, JSON.stringify(data).substring(0, 200));

  if (!res.ok || !data.media_id_string) {
    const errMsg = data.errors?.[0]?.message || data.detail || JSON.stringify(data);
    throw new Error(`Media upload failed (${res.status}): ${errMsg}`);
  }

  console.log(`[uploadMedia] ✅ media_id: ${data.media_id_string}`);
  return data.media_id_string;
}

// ── Get base64 from any image source (data: URL or public URL) ──
async function getBase64FromSource(imageUrl) {
  if (!imageUrl) return null;

  if (imageUrl.startsWith('data:')) {
    // Already base64 — extract the data part
    const base64 = imageUrl.split(',')[1];
    if (!base64) throw new Error('Invalid data URL — no base64 content');
    return base64;
  }

  // Public URL — fetch and convert
  console.log(`[uploadMedia] Fetching image from: ${imageUrl.substring(0, 80)}...`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(imageUrl, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching image`);
    const buffer = await res.buffer();
    return buffer.toString('base64');
  } catch (e) {
    clearTimeout(timer);
    throw new Error(`Could not fetch image: ${e.message}`);
  }
}

// ── Upload image to Twitter (main entry point) ──
async function uploadImageToTwitter(imageUrl, apiKey, apiSecret, accessToken, accessSecret) {
  if (!imageUrl) return null;
  try {
    const base64 = await getBase64FromSource(imageUrl);
    if (!base64) return null;
    return await uploadBase64ToTwitter(base64, apiKey, apiSecret, accessToken, accessSecret);
  } catch (e) {
    console.warn('[uploadMedia] Image upload failed — tweet will post without image:', e.message);
    return null; // Never block the tweet over an image failure
  }
}

// ── Post a single tweet ──
async function postTweet(text, replyToId, mediaId, apiKey, apiSecret, accessToken, accessSecret) {
  const url = 'https://api.twitter.com/2/tweets';
  const { oauth, token } = makeOAuth(apiKey, apiSecret, accessToken, accessSecret);
  const body = { text };
  if (replyToId) body.reply = { in_reply_to_tweet_id: String(replyToId) };
  if (mediaId) body.media = { media_ids: [String(mediaId)] };
  const authHeader = oauth.toHeader(oauth.authorize({ url, method: 'POST' }, token));
  console.log(`[postTweet] "${text.substring(0,50)}..." ${replyToId ? '↩ '+replyToId : ''} ${mediaId ? '🖼 '+mediaId : ''}`);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': authHeader.Authorization, 'Content-Type': 'application/json', 'User-Agent': 'ContentHubPro/3.2' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  console.log(`[postTweet] ${res.status}:`, JSON.stringify(data).substring(0, 150));
  if (!res.ok) throw new Error(`Twitter API ${res.status}: ${data.detail || data.title || JSON.stringify(data)}`);
  return data.data;
}

// ── POST /tweet ──
app.post('/tweet', async (req, res) => {
  const { text, apiKey, apiSecret, accessToken, accessSecret, replyToId, imageUrl } = req.body;
  if (!text || !apiKey || !apiSecret || !accessToken || !accessSecret)
    return res.status(400).json({ error: 'Missing required fields' });
  try {
    const mediaId = imageUrl ? await uploadImageToTwitter(imageUrl, apiKey, apiSecret, accessToken, accessSecret) : null;
    const tweet = await postTweet(text, replyToId || null, mediaId, apiKey, apiSecret, accessToken, accessSecret);
    res.json({ success: true, tweetId: tweet.id, tweetUrl: `https://x.com/i/web/status/${tweet.id}`, imageAttached: !!mediaId });
  } catch (e) {
    console.error('[/tweet]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /thread ──
app.post('/thread', async (req, res) => {
  const { tweets, apiKey, apiSecret, accessToken, accessSecret, imageUrl } = req.body;
  if (!tweets?.length || !apiKey || !apiSecret || !accessToken || !accessSecret)
    return res.status(400).json({ error: 'Missing required fields' });
  console.log(`[/thread] ${tweets.length} tweets`);
  const results = [];
  let lastId = null;
  try {
    for (let i = 0; i < tweets.length; i++) {
      const text = tweets[i];
      if (!text?.trim()) continue;
      if (i > 0) await new Promise(r => setTimeout(r, 3000));
      const mediaId = (i === 0 && imageUrl) ? await uploadImageToTwitter(imageUrl, apiKey, apiSecret, accessToken, accessSecret) : null;
      const tweet = await postTweet(text.trim(), lastId, mediaId, apiKey, apiSecret, accessToken, accessSecret);
      lastId = tweet.id;
      results.push({ index: i+1, tweetId: tweet.id, tweetUrl: `https://x.com/i/web/status/${tweet.id}` });
    }
    res.json({ success: true, threadCount: results.length, firstTweetUrl: results[0]?.tweetUrl, tweets: results });
  } catch (e) {
    console.error('[/thread]', e.message);
    res.status(500).json({ error: e.message, partialResults: results });
  }
});

// ── POST /schedule ──
app.post('/schedule', async (req, res) => {
  const { supabaseUrl, supabaseKey, scheduleData } = req.body;
  if (!supabaseUrl || !supabaseKey || !scheduleData) return res.status(400).json({ error: 'Missing fields' });
  try {
    const db = createClient(supabaseUrl, supabaseKey);
    const record = {
      id: scheduleData.id || crypto.randomUUID(),
      profile_id: scheduleData.profileId, handle: scheduleData.handle, platform: scheduleData.platform,
      content_type: scheduleData.contentType || 'tweet',
      tweets: JSON.stringify(scheduleData.tweets || [scheduleData.text]),
      caption: scheduleData.caption || '', topic: scheduleData.topic || '',
      image_url: scheduleData.imageUrl || '', scheduled_at: scheduleData.scheduledAt,
      timezone: scheduleData.timezone || 'UTC', status: 'scheduled',
      api_key: scheduleData.apiKey, api_secret: scheduleData.apiSecret,
      access_token: scheduleData.accessToken, access_secret: scheduleData.accessSecret,
      created_at: new Date().toISOString()
    };
    const { error } = await db.from('scheduled_posts').upsert([record]);
    if (error) throw new Error(error.message);
    res.json({ success: true, id: record.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/schedule/:id', async (req, res) => {
  const { supabaseUrl, supabaseKey } = req.body;
  if (!supabaseUrl || !supabaseKey) return res.status(400).json({ error: 'Missing fields' });
  try {
    const db = createClient(supabaseUrl, supabaseKey);
    await db.from('scheduled_posts').update({ status: 'cancelled' }).eq('id', req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/schedule', async (req, res) => {
  const { supabaseUrl, supabaseKey, profileId } = req.query;
  if (!supabaseUrl || !supabaseKey) return res.status(400).json({ error: 'Missing fields' });
  try {
    const db = createClient(supabaseUrl, supabaseKey);
    let q = db.from('scheduled_posts').select('*').eq('status','scheduled').order('scheduled_at',{ascending:true});
    if (profileId) q = q.eq('profile_id', profileId);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    res.json({ success: true, posts: data || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SCHEDULER ──
async function runScheduler() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;
  if (!supabaseUrl || !supabaseKey) return;
  try {
    const db = createClient(supabaseUrl, supabaseKey);
    const { data: due } = await db.from('scheduled_posts').select('*').eq('status','scheduled').lte('scheduled_at', new Date().toISOString());
    if (!due?.length) return;
    for (const post of due) {
      try {
        await db.from('scheduled_posts').update({ status: 'processing' }).eq('id', post.id);
        const tweets = JSON.parse(post.tweets || '[]');
        let firstUrl = '';
        if (post.content_type === 'thread' && tweets.length > 1) {
          let lastId = null;
          for (let i = 0; i < tweets.length; i++) {
            if (i > 0) await new Promise(r => setTimeout(r, 3000));
            const mediaId = (i === 0 && post.image_url) ? await uploadImageToTwitter(post.image_url, post.api_key, post.api_secret, post.access_token, post.access_secret) : null;
            const tw = await postTweet(tweets[i], lastId, mediaId, post.api_key, post.api_secret, post.access_token, post.access_secret);
            if (i === 0) firstUrl = `https://x.com/i/web/status/${tw.id}`;
            lastId = tw.id;
          }
        } else {
          const mediaId = post.image_url ? await uploadImageToTwitter(post.image_url, post.api_key, post.api_secret, post.access_token, post.access_secret) : null;
          const tw = await postTweet(tweets[0] || post.caption, null, mediaId, post.api_key, post.api_secret, post.access_token, post.access_secret);
          firstUrl = `https://x.com/i/web/status/${tw.id}`;
        }
        await db.from('scheduled_posts').update({ status: 'posted', posted_at: new Date().toISOString(), post_url: firstUrl }).eq('id', post.id);
        console.log(`[Scheduler] ✅ ${post.handle}`);
      } catch (e) {
        await db.from('scheduled_posts').update({ status: 'failed', error_message: e.message }).eq('id', post.id);
        console.error(`[Scheduler] ❌ ${e.message}`);
      }
    }
  } catch (e) { console.error('[Scheduler]', e.message); }
}

setInterval(runScheduler, 60000);
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ContentHub Server v3.2.0 on port ${PORT}`));
