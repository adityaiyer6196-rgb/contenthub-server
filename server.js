const express = require('express');
const cors = require('cors');
const OAuth = require('oauth-1.0a');
const crypto = require('crypto');
const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

// ── Health check ──
app.get('/', (req, res) => {
  res.json({
    status: 'ContentHub Twitter Server running ✅',
    version: '2.0.0',
    features: ['single-tweet', 'thread', 'scheduling'],
    schedulerActive: !!schedulerInterval
  });
});

// ── OAuth 1.0a signer ──
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

// ── Post a single tweet ──
async function postTweet(text, replyToId, apiKey, apiSecret, accessToken, accessSecret) {
  const url = 'https://api.twitter.com/2/tweets';
  const { oauth, token } = makeOAuth(apiKey, apiSecret, accessToken, accessSecret);
  const body = { text };
  if (replyToId) body.reply = { in_reply_to_tweet_id: replyToId };
  const authHeader = oauth.toHeader(oauth.authorize({ url, method: 'POST' }, token));
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...authHeader, 'Content-Type': 'application/json', 'User-Agent': 'ContentHubPro/2.0' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || data.title || JSON.stringify(data));
  return data.data;
}

// ── Post a full thread ──
async function postThread(tweets, apiKey, apiSecret, accessToken, accessSecret) {
  const results = [];
  let lastId = null;
  for (let i = 0; i < tweets.length; i++) {
    const text = tweets[i];
    if (!text?.trim()) continue;
    if (i > 0) await new Promise(r => setTimeout(r, 1200));
    const tweet = await postTweet(text.trim(), lastId, apiKey, apiSecret, accessToken, accessSecret);
    lastId = tweet.id;
    results.push({
      index: i + 1,
      tweetId: tweet.id,
      tweetUrl: `https://x.com/i/web/status/${tweet.id}`,
      text: text.trim().substring(0, 60) + '…'
    });
  }
  return results;
}

// ── POST /tweet ──
app.post('/tweet', async (req, res) => {
  const { text, apiKey, apiSecret, accessToken, accessSecret } = req.body;
  if (!text || !apiKey || !apiSecret || !accessToken || !accessSecret)
    return res.status(400).json({ error: 'Missing required fields' });
  try {
    const tweet = await postTweet(text, null, apiKey, apiSecret, accessToken, accessSecret);
    res.json({ success: true, tweetId: tweet.id, tweetUrl: `https://x.com/i/web/status/${tweet.id}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /thread ──
app.post('/thread', async (req, res) => {
  const { tweets, apiKey, apiSecret, accessToken, accessSecret } = req.body;
  if (!tweets?.length || !apiKey || !apiSecret || !accessToken || !accessSecret)
    return res.status(400).json({ error: 'Missing required fields' });
  try {
    const results = await postThread(tweets, apiKey, apiSecret, accessToken, accessSecret);
    res.json({ success: true, threadCount: results.length, firstTweetUrl: results[0]?.tweetUrl, tweets: results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /schedule ── Save a scheduled post to Supabase
app.post('/schedule', async (req, res) => {
  const { supabaseUrl, supabaseKey, scheduleData } = req.body;
  if (!supabaseUrl || !supabaseKey || !scheduleData)
    return res.status(400).json({ error: 'Missing supabaseUrl, supabaseKey, or scheduleData' });
  try {
    const db = createClient(supabaseUrl, supabaseKey);
    const record = {
      id: scheduleData.id || crypto.randomUUID(),
      profile_id: scheduleData.profileId,
      handle: scheduleData.handle,
      platform: scheduleData.platform,
      content_type: scheduleData.contentType || 'tweet', // tweet | thread
      tweets: JSON.stringify(scheduleData.tweets || [scheduleData.text]),
      caption: scheduleData.caption || scheduleData.text || '',
      topic: scheduleData.topic || '',
      image_url: scheduleData.imageUrl || '',
      scheduled_at: scheduleData.scheduledAt, // ISO string
      timezone: scheduleData.timezone || 'UTC',
      status: 'scheduled', // scheduled | posted | failed | cancelled
      api_key: scheduleData.apiKey,
      api_secret: scheduleData.apiSecret,
      access_token: scheduleData.accessToken,
      access_secret: scheduleData.accessSecret,
      created_at: new Date().toISOString()
    };
    const { error } = await db.from('scheduled_posts').upsert([record]);
    if (error) throw new Error(error.message);
    res.json({ success: true, id: record.id, scheduledAt: record.scheduled_at });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /schedule/:id ── Cancel a scheduled post
app.delete('/schedule/:id', async (req, res) => {
  const { supabaseUrl, supabaseKey } = req.body;
  if (!supabaseUrl || !supabaseKey)
    return res.status(400).json({ error: 'Missing supabaseUrl, supabaseKey' });
  try {
    const db = createClient(supabaseUrl, supabaseKey);
    const { error } = await db.from('scheduled_posts').update({ status: 'cancelled' }).eq('id', req.params.id);
    if (error) throw new Error(error.message);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /schedule ── List scheduled posts
app.get('/schedule', async (req, res) => {
  const { supabaseUrl, supabaseKey, profileId } = req.query;
  if (!supabaseUrl || !supabaseKey)
    return res.status(400).json({ error: 'Missing supabaseUrl, supabaseKey' });
  try {
    const db = createClient(supabaseUrl, supabaseKey);
    let query = db.from('scheduled_posts').select('*').eq('status', 'scheduled').order('scheduled_at', { ascending: true });
    if (profileId) query = query.eq('profile_id', profileId);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    res.json({ success: true, posts: data || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── SCHEDULER LOOP ── Runs every 60 seconds
let schedulerInterval = null;

async function runScheduler() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;
  if (!supabaseUrl || !supabaseKey) return; // Scheduler needs env vars

  try {
    const db = createClient(supabaseUrl, supabaseKey);
    const now = new Date().toISOString();

    // Get all scheduled posts due now or overdue
    const { data: duePosts, error } = await db
      .from('scheduled_posts')
      .select('*')
      .eq('status', 'scheduled')
      .lte('scheduled_at', now);

    if (error || !duePosts?.length) return;

    console.log(`[Scheduler] Found ${duePosts.length} due post(s)`);

    for (const post of duePosts) {
      try {
        // Mark as processing to avoid double-posting
        await db.from('scheduled_posts').update({ status: 'processing' }).eq('id', post.id);

        const tweets = JSON.parse(post.tweets || '[]');
        let firstTweetUrl = '';

        if (post.content_type === 'thread' && tweets.length > 1) {
          const results = await postThread(tweets, post.api_key, post.api_secret, post.access_token, post.access_secret);
          firstTweetUrl = results[0]?.tweetUrl || '';
          console.log(`[Scheduler] Thread posted: ${results.length} tweets for ${post.handle}`);
        } else {
          const text = tweets[0] || post.caption;
          const tweet = await postTweet(text, null, post.api_key, post.api_secret, post.access_token, post.access_secret);
          firstTweetUrl = `https://x.com/i/web/status/${tweet.id}`;
          console.log(`[Scheduler] Tweet posted for ${post.handle}`);
        }

        // Mark as posted
        await db.from('scheduled_posts').update({
          status: 'posted',
          posted_at: new Date().toISOString(),
          post_url: firstTweetUrl
        }).eq('id', post.id);

      } catch (e) {
        console.error(`[Scheduler] Failed to post ${post.id}:`, e.message);
        await db.from('scheduled_posts').update({
          status: 'failed',
          error_message: e.message
        }).eq('id', post.id);
      }
    }
  } catch (e) {
    console.error('[Scheduler] Error:', e.message);
  }
}

// Start scheduler
schedulerInterval = setInterval(runScheduler, 60 * 1000); // every 60 seconds
console.log('[Scheduler] Started — checking every 60 seconds');

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ContentHub Twitter Server v2.0 running on port ${PORT}`));
