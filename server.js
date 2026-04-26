// ── FIXED Image Upload v2 (with proper multipart headers) ──
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
    form.append('media_category', 'tweet_image');

    // ← THIS IS THE FIX
    const uploadRes = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Authorization': authHeader.Authorization,
        ...form.getHeaders()   // ← Forces correct multipart boundary
      },
      body: form
    });

    const uploadData = await uploadRes.json();
    console.log(`[media] Response ${uploadRes.status}:`, JSON.stringify(uploadData).substring(0, 300));

    if (!uploadRes.ok) {
      throw new Error(`Media upload failed (${uploadRes.status}): ${uploadData.detail || uploadData.title || JSON.stringify(uploadData)}`);
    }

    const mediaId = uploadData.data?.id || uploadData.media_id_string || uploadData.id;
    if (!mediaId) throw new Error('No media_id in response');

    console.log(`[media] ✅ media_id: ${mediaId}`);
    return String(mediaId);

  } catch (e) {
    console.error('[media] Upload failed:', e.message);
    return null;
  }
}
