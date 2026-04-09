# ContentHub Twitter Server v2.0

Deploy to Railway.app (free). Handles Twitter OAuth + scheduled posting.

## Deploy Steps
1. Upload this folder to a GitHub repo
2. Go to railway.app → New Project → Deploy from GitHub
3. Add these Environment Variables in Railway dashboard:
   - SUPABASE_URL = your Supabase project URL
   - SUPABASE_KEY = your Supabase anon key
4. Copy your Railway public URL into ContentHub → Admin Panel → Database → Server URL

## Supabase SQL (run once)
CREATE TABLE IF NOT EXISTS scheduled_posts (
  id text PRIMARY KEY,
  profile_id text,
  handle text,
  platform text,
  content_type text DEFAULT 'tweet',
  tweets text,
  caption text,
  topic text,
  image_url text,
  scheduled_at timestamptz,
  timezone text DEFAULT 'UTC',
  status text DEFAULT 'scheduled',
  api_key text,
  api_secret text,
  access_token text,
  access_secret text,
  posted_at timestamptz,
  post_url text,
  error_message text,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE scheduled_posts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "pub" ON scheduled_posts FOR ALL USING (true) WITH CHECK (true);

## Endpoints
GET  /              — health check
POST /tweet         — post single tweet now
POST /thread        — post thread now
POST /schedule      — schedule a post
GET  /schedule      — list scheduled posts
DELETE /schedule/:id — cancel scheduled post
