// src/server.js
// Express server: Twilio SMS webhook + WordPress REST API bridge.
// WP plugin calls /api/genres, /api/curators, /api/subscribe.
// Twilio calls /sms for inbound HIT / DENIED votes.
//
// Run: node src/server.js

require('dotenv').config();
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const { runWeeklyDrop } = require('./scheduler');
const express = require('express');
const db      = require('./db');
const twilio  = require('twilio');
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const app  = express();
const PORT = process.env.PORT || 3000;

// CORS — WordPress PHP makes server-side calls, so open is fine.
// Restrict via ALLOWED_ORIGIN env var if needed.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Twilio sends form-encoded; WP plugin sends JSON
app.use(express.urlencoded({ extended: false, limit: "10mb" }));
app.use(express.json({ limit: "10mb" }));
app.use(require("express").static(require("path").join(__dirname, "public")));

// Admin panel
app.get("/admin", (req, res) => res.sendFile(require("path").join(__dirname, "public", "admin.html")));

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'UHT SMS Platform running', version: '1.0.0' });
});

// =============================================================================
// WORDPRESS BRIDGE ROUTES  (called by uht-platform.php)
// =============================================================================

// GET /api/genres  — powers the genre chip selector on the landing page
app.get('/api/genres', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT id, name FROM genres ORDER BY name ASC');
    res.json({ genres: rows });
  } catch (err) {
    console.error('[API] genres error:', err.message);
    res.status(500).json({ error: 'Failed to load genres.' });
  }
});

// GET /api/curators  — for future curator-select UI
app.get('/api/curators', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT id, name, bio, image_url, instagram FROM curators ORDER BY name ASC');
    res.json({ curators: rows });
  } catch (err) {
    console.error('[API] curators error:', err.message);
    res.status(500).json({ error: 'Failed to load curators.' });
  }
});

// POST /api/subscribe  — body: { phone, genre_id?, curator_id? }
// Creates user (if new) and records subscription.
app.post('/api/subscribe', async (req, res) => {
  const { phone, name, email, genre_id, curator_id } = req.body;

  if (!phone) return res.status(400).json({ error: 'phone is required.' });
  if (!genre_id && !curator_id) return res.status(400).json({ error: 'Provide genre_id or curator_id.' });
  if (genre_id && curator_id)   return res.status(400).json({ error: 'Provide genre_id OR curator_id, not both.' });

  // Normalise bare 10-digit to E.164
  const normalPhone = /^\d{10}$/.test(phone) ? '+1' + phone : phone;
  if (!/^\+1\d{10}$/.test(normalPhone)) {
    return res.status(400).json({ error: 'Invalid US phone number.' });
  }

  try {
    // Upsert user by phone
    const { rows: userRows } = await db.query(
      `INSERT INTO users (phone, name, email)
       VALUES ($1, $2, $3)
       ON CONFLICT (phone) DO UPDATE SET name = COALESCE(EXCLUDED.name, users.name), email = COALESCE(EXCLUDED.email, users.email)
       RETURNING id`,
      [normalPhone, name || null, email || null]
    );
    const userId = userRows[0].id;

    // Create subscription (DO NOTHING if duplicate)
    const { rows: subRows } = await db.query(
      `INSERT INTO subscriptions (user_id, genre_id, curator_id)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [userId, genre_id || null, curator_id || null]
    );

    const isNew = subRows.length > 0;
    console.log(`[Subscribe] ${normalPhone} -> user #${userId} | ${isNew ? 'new subscription' : 'already subscribed'}`);

    // Send opt-in confirmation text to new subscribers
    if (isNew) {
      try {
        await twilioClient.messages.create({
          body: 'Undeniable Hit Theory: Reply YES to confirm you want curator text drops. 1-2 msgs/month. Reply STOP to opt out.',
          from: process.env.TWILIO_FROM,
          to: normalPhone,
        });
        console.log(`[Subscribe] Opt-in SMS sent to ${normalPhone}`);
      } catch (smsErr) {
        console.error('[Subscribe] Failed to send opt-in SMS:', smsErr.message);
      }
    }

    res.json({
      success: true,
      message: isNew
        ? 'Subscribed! Check your phone for a confirmation text.'
        : "You're already subscribed — Friday drops incoming!",
      user_id: userId,
    });
  } catch (err) {
    console.error('[API] subscribe error:', err.message);
    res.status(500).json({ error: 'Subscription failed. Please try again.' });
  }
});

// =============================================================================
// TWILIO INBOUND SMS WEBHOOK  — POST /sms
// Receives HIT (1) / DENIED (2) replies and records votes.
// =============================================================================
app.post('/sms', async (req, res) => {
  const from = req.body.From;
  const body = (req.body.Body || '').trim();

  console.log(`[SMS] From: ${from}  Body: "${body}"`);

  // Helper: respond with TwiML text
  const twiml = (msg) => {
    res.set('Content-Type', 'text/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${msg}</Message></Response>`);
  };

  const upper = body.toUpperCase();

  // Handle YES opt-in
  if (upper === 'YES' || upper === 'Y') {
    try {
      const { rows } = await db.query(
        'UPDATE users SET sms_verified = true WHERE phone = $1 RETURNING id',
        [from]
      );
      if (rows.length) {
        const userId = rows[0].id;
        await db.query(
          'UPDATE subscriptions SET is_active = true WHERE user_id = $1',
          [userId]
        );
        return twiml("You're in! UHT will send your picks by text. Reply STOP anytime to opt out.");
      } else {
        return twiml("Hmm, we couldn't find your number. Visit the site to sign up.");
      }
    } catch(e) {
      console.error('[YES] error:', e.message);
      return twiml('Something went wrong. Try again later.');
    }
  }

  // Handle HELP
  if (upper === 'HELP') {
    return twiml('UHT: Reply HIT or DENY to vote on your weekly drop. Reply STOP to unsubscribe.');
  }

  // Parse vote
  let voteValue;
  if (upper === 'HIT' || upper === '1') voteValue = 'hit';
  else if (upper === 'DENY' || upper === 'DENIED' || upper === '2') voteValue = 'deny';
  else if (upper === 'MEGA HIT' || upper === 'ULTRA HIT' || upper === '3') voteValue = 'mega_hit';
  else {
    return twiml('Reply 1 (Hit), 2 (Deny), or 3 (Ultra Hit) to vote on your weekly drop.');
  }

  try {
    // Look up user
    const { rows: users } = await db.query(
      'SELECT id FROM users WHERE phone = $1',
      [from]
    );

    if (!users.length) {
      console.warn(`  [Vote] Unknown phone: ${from}`);
      return twiml("We don't recognise your number. Subscribe at undeniablehittheory.com");
    }

    const userId = users[0].id;

    // Find most recent delivery
    const { rows: deliveries } = await db.query(
      `SELECT id, song_id FROM deliveries
       WHERE user_id = $1
       ORDER BY sent_at DESC
       LIMIT 1`,
      [userId]
    );

    if (!deliveries.length) {
      console.warn(`  [Vote] No deliveries for user #${userId}`);
      return twiml('No recent drops found. Stay tuned!');
    }

    const { id: deliveryId, song_id: songId } = deliveries[0];

    // Upsert vote into legacy votes table
    const legacyVote = voteValue === 'mega_hit' ? 'hit' : voteValue;
    await db.query(
      `INSERT INTO votes (delivery_id, user_id, song_id, vote, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (delivery_id) DO UPDATE
         SET vote = EXCLUDED.vote,
             updated_at = NOW()`,
      [deliveryId, userId, songId, legacyVote]
    );

    // Also record in new curator intelligence song_votes table
    const { rows: subs } = await db.query(
      'SELECT curator_id FROM subscriptions WHERE user_id = $1 AND is_active = true LIMIT 1',
      [userId]
    );
    const curatorId = subs.length ? subs[0].curator_id : null;
    await db.query(
      `INSERT INTO song_votes (subscriber_id, curator_id, song_id, vote_type)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (subscriber_id, song_id, playlist_id) DO UPDATE
         SET vote_type = EXCLUDED.vote_type, created_at = NOW()`,
      [userId, curatorId, songId, voteValue]
    ).catch(e => console.warn('[song_votes] non-fatal:', e.message));

    const emoji = voteValue === 'mega_hit' ? '🔥🔥' : voteValue === 'hit' ? '🔥' : '❌';
    console.log(`  [Vote] User #${userId} voted ${voteValue.toUpperCase()} on delivery #${deliveryId}`);
    return twiml(`Thanks! Marked as ${voteValue.toUpperCase()} ${emoji}`);

  } catch (err) {
    console.error('[Vote] Error:', err.message);
    return twiml('Something went wrong. Try again soon!');
  }
});


// ── GET /api/curator-submissions ─────────────────────────────
app.get('/api/curator-submissions', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT cs.*, c.name AS curator_name
      FROM curator_submissions cs
      LEFT JOIN curators c ON c.id = cs.curator_id
      ORDER BY cs.submitted_at DESC
    `);
    res.json({ submissions: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/curator-submissions ────────────────────────────
app.post('/api/curator-submissions', async (req, res) => {
  const { curator_id, title, artist, spotify_url, youtube_url, theme, week_number, curator_note } = req.body;
  if (!curator_id || !title || !artist) {
    return res.status(400).json({ error: 'curator_id, title, and artist are required.' });
  }
  try {
    const { rows } = await db.query(`
      INSERT INTO curator_submissions (curator_id, title, artist, spotify_url, youtube_url, theme, week_number, curator_note)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *
    `, [curator_id, title, artist, spotify_url || null, youtube_url || null, theme || null, week_number || 1, curator_note || null]);
    res.json({ submission: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ── PATCH /api/curator-submissions/:id ───────────────────────────────────────
app.patch('/api/curator-submissions/:id', async (req, res) => {
  const { title, artist, spotify_url, youtube_url, theme, week_number, curator_note } = req.body;
  if (!title || !artist) return res.status(400).json({ error: 'title and artist required.' });
  try {
    const { rows } = await db.query(
      `UPDATE curator_submissions SET
        title=$1, artist=$2, spotify_url=$3, youtube_url=$4,
        theme=$5, week_number=$6, curator_note=$7
       WHERE id=$8 RETURNING *`,
      [title, artist, spotify_url||null, youtube_url||null, theme||null, week_number||1, curator_note||null, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found.' });
    res.json({ submission: rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/curator-submissions/:id ──────────────────────
app.delete('/api/curator-submissions/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM curator_submissions WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/curator-submissions/by-curator/:curatorId ────────
app.get('/api/curator-submissions/by-curator/:curatorId', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT * FROM curator_submissions
      WHERE curator_id = $1
      ORDER BY week_number ASC, submitted_at DESC
    `, [req.params.curatorId]);
    res.json({ submissions: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Start server ──────────────────────────────────────────────────────────────

app.post('/api/drop/send', async (req, res) => {
  try { const r = await runWeeklyDrop(); res.json({ ok: true, ...r }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/genres/seed', async (req, res) => {
  const genres = ['Rock', 'Punk', 'Pop', 'Country'];
  const created = [];
  for (const name of genres) {
    const { rows } = await db.query(
      'INSERT INTO genres (name) VALUES ($1) ON CONFLICT (name) DO NOTHING RETURNING *',
      [name]
    );
    if (rows.length) created.push(name);
  }
  res.json({ seeded: created });
});



// ── Twilio Verify: send OTP ───────────────────────────────────────────────────
app.post('/api/send_code', async (req, res) => {
  const { phone, name, email } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  try {
    const client = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    await client.verify.v2
      .services(process.env.TWILIO_VERIFY_SID)
      .verifications.create({ to: phone, channel: 'sms' });
    res.json({ ok: true });
  } catch (err) {
    console.error('send_code error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Twilio Verify: verify OTP + subscribe ─────────────────────────────────────
app.post('/api/verify_code', async (req, res) => {
  const { phone, code, genre } = req.body;
  if (!phone || !code) return res.status(400).json({ error: 'phone and code required' });
  try {
    const client = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const check = await client.verify.v2
      .services(process.env.TWILIO_VERIFY_SID)
      .verificationChecks.create({ to: phone, code });

    if (check.status !== 'approved') {
      return res.status(400).json({ error: 'Invalid or expired code.' });
    }

    // Upsert user
    const { rows: [user] } = await db.query(
      `INSERT INTO users (phone) VALUES ($1)
       ON CONFLICT (phone) DO UPDATE SET phone = EXCLUDED.phone
       RETURNING *`,
      [phone]
    );

    // Subscribe to genre if provided
    if (genre) {
      const { rows: genres } = await db.query(
        'SELECT id FROM genres WHERE LOWER(name) = LOWER($1) LIMIT 1', [genre]
      );
      if (genres.length) {
        await db.query(
          `INSERT INTO subscriptions (user_id, genre_id, is_active)
           VALUES ($1, $2, true)
           ON CONFLICT (user_id, genre_id) DO UPDATE SET is_active = true`,
          [user.id, genres[0].id]
        );
      }
    }

    res.json({ ok: true, status: 'approved' });
  } catch (err) {
    console.error('verify_code error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Check if subscriber exists ────────────────────────────────────────────────
app.get('/api/check_subscriber', async (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  try {
    const { rows } = await db.query(
      'SELECT * FROM users WHERE phone = $1 LIMIT 1', [phone]
    );
    if (rows.length) {
      res.json({ exists: true, verified: true });
    } else {
      res.json({ exists: false, verified: false });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Playlist links (optional — return empty array by default) ─────────────────
app.get('/api/playlist_links', (req, res) => {
  res.json({ playlist_links: [] });
});


// ── POST /api/follows ─────────────────────────────────────────────────────────
app.post('/api/follows', async (req, res) => {
  const { phone, curator_id } = req.body;
  if (!phone || !curator_id) return res.status(400).json({ error: 'phone and curator_id required.' });
  try {
    await db.query(
      `INSERT INTO follows (phone, curator_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [phone, curator_id]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/follows ───────────────────────────────────────────────────────
app.delete('/api/follows', async (req, res) => {
  const { phone, curator_id } = req.body;
  if (!phone || !curator_id) return res.status(400).json({ error: 'phone and curator_id required.' });
  try {
    await db.query(`DELETE FROM follows WHERE phone=$1 AND curator_id=$2`, [phone, curator_id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/follows/check ────────────────────────────────────────────────────
app.get('/api/follows/check', async (req, res) => {
  const { phone, curator_id } = req.query;
  if (!phone || !curator_id) return res.status(400).json({ error: 'phone and curator_id required.' });
  try {
    const { rows } = await db.query(
      `SELECT id FROM follows WHERE phone=$1 AND curator_id=$2`,
      [phone, curator_id]
    );
    res.json({ following: rows.length > 0 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/follows/curator/:id ──────────────────────────────────────────────
app.get('/api/follows/curator/:id', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT phone, created_at FROM follows WHERE curator_id=$1 ORDER BY created_at DESC`,
      [req.params.id]
    );
    res.json({ followers: rows, count: rows.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ── POST /api/follows ─────────────────────────────────────────────────────────
app.post('/api/follows', async (req, res) => {
  const { phone, curator_id } = req.body;
  if (!phone || !curator_id) return res.status(400).json({ error: 'phone and curator_id required.' });
  try {
    await db.query(
      `INSERT INTO follows (phone, curator_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [phone, curator_id]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/follows ───────────────────────────────────────────────────────
app.delete('/api/follows', async (req, res) => {
  const { phone, curator_id } = req.body;
  if (!phone || !curator_id) return res.status(400).json({ error: 'phone and curator_id required.' });
  try {
    await db.query(`DELETE FROM follows WHERE phone=$1 AND curator_id=$2`, [phone, curator_id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/follows/check ────────────────────────────────────────────────────
app.get('/api/follows/check', async (req, res) => {
  const { phone, curator_id } = req.query;
  if (!phone || !curator_id) return res.status(400).json({ error: 'phone and curator_id required.' });
  try {
    const { rows } = await db.query(
      `SELECT id FROM follows WHERE phone=$1 AND curator_id=$2`,
      [phone, curator_id]
    );
    res.json({ following: rows.length > 0 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/follows/curator/:id ──────────────────────────────────────────────
app.get('/api/follows/curator/:id', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT phone, created_at FROM follows WHERE curator_id=$1 ORDER BY created_at DESC`,
      [req.params.id]
    );
    res.json({ followers: rows, count: rows.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ── POST /api/follows ─────────────────────────────────────────────────────────
app.post('/api/follows', async (req, res) => {
  const { phone, curator_id } = req.body;
  if (!phone || !curator_id) return res.status(400).json({ error: 'phone and curator_id required.' });
  try {
    await db.query(
      `INSERT INTO follows (phone, curator_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [phone, curator_id]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/follows ───────────────────────────────────────────────────────
app.delete('/api/follows', async (req, res) => {
  const { phone, curator_id } = req.body;
  if (!phone || !curator_id) return res.status(400).json({ error: 'phone and curator_id required.' });
  try {
    await db.query(`DELETE FROM follows WHERE phone=$1 AND curator_id=$2`, [phone, curator_id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/follows/check ────────────────────────────────────────────────────
app.get('/api/follows/check', async (req, res) => {
  const { phone, curator_id } = req.query;
  if (!phone || !curator_id) return res.status(400).json({ error: 'phone and curator_id required.' });
  try {
    const { rows } = await db.query(
      `SELECT id FROM follows WHERE phone=$1 AND curator_id=$2`,
      [phone, curator_id]
    );
    res.json({ following: rows.length > 0 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/follows/curator/:id ──────────────────────────────────────────────
app.get('/api/follows/curator/:id', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT phone, created_at FROM follows WHERE curator_id=$1 ORDER BY created_at DESC`,
      [req.params.id]
    );
    res.json({ followers: rows, count: rows.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ── GET /api/genre-submissions ───────────────────────────────────────────────
app.get('/api/genre-submissions', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM genre_submissions ORDER BY drop_date DESC, created_at DESC`
    );
    res.json({ submissions: rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/genre-submissions ──────────────────────────────────────────────
app.post('/api/genre-submissions', async (req, res) => {
  const { genre, week_title, title, artist, note, youtube_url, spotify_url, week_number, drop_date } = req.body;
  if (!genre || !title || !artist) return res.status(400).json({ error: 'genre, title and artist required.' });
  try {
    const { rows } = await db.query(
      `INSERT INTO genre_submissions (genre, week_title, title, artist, note, youtube_url, spotify_url, week_number, drop_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [genre, week_title||null, title, artist, note||null, youtube_url||null, spotify_url||null, week_number||1, drop_date||null]
    );
    res.json({ submission: rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/genre-submissions/:id ────────────────────────────────────────
app.patch('/api/genre-submissions/:id', async (req, res) => {
  const { genre, week_title, title, artist, note, youtube_url, spotify_url, week_number, drop_date } = req.body;
  if (!title || !artist) return res.status(400).json({ error: 'title and artist required.' });
  try {
    const { rows } = await db.query(
      `UPDATE genre_submissions SET genre=$1, week_title=$2, title=$3, artist=$4, note=$5,
       youtube_url=$6, spotify_url=$7, week_number=$8, drop_date=$9 WHERE id=$10 RETURNING *`,
      [genre, week_title||null, title, artist, note||null, youtube_url||null, spotify_url||null, week_number||1, drop_date||null, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found.' });
    res.json({ submission: rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/genre-submissions/:id ───────────────────────────────────────
app.delete('/api/genre-submissions/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM genre_submissions WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});






// ── GET /drop/curator/:slug ──────────────────────────────────────────────────
app.get('/drop/curator/:slug', async (req, res) => {
  const slug = req.params.slug.toLowerCase();
  try {
    const curatorRes = await db.query(
      `SELECT * FROM curators WHERE LOWER(REPLACE(name,' ','-'))=$1 LIMIT 1`,
      [slug]
    );
    if (!curatorRes.rows.length) return res.status(404).send('<h1>Curator not found.</h1>');
    const curator = curatorRes.rows[0];

    const subRes = await db.query(
      `SELECT * FROM curator_submissions WHERE curator_id=$1
       ORDER BY week_number DESC, submitted_at DESC LIMIT 1`,
      [curator.id]
    );
    if (!subRes.rows.length) return res.status(404).send('<h1>No picks yet.</h1>');
    const d = subRes.rows[0];

    // Compute curator tier from lifetime hit votes
    const hitRes = await db.query(
      `SELECT COUNT(*) AS hits FROM curator_submission_votes
        WHERE submission_id IN (
          SELECT id FROM curator_submissions WHERE curator_id = $1
        ) AND vote = 'hit'`,
      [curator.id]
    );
    const totalHits = parseInt(hitRes.rows[0].hits, 10);
    const curatorTier =
      totalHits >= 28 ? '🏆 Legend' :
      totalHits >= 18 ? '👑 Tastemaker' :
      totalHits >= 8  ? '🎯 Hit Hunter' :
                        '🌙 Rising Curator';

    const ytId = d.youtube_url ? (d.youtube_url.match(/(?:v=|youtu\.be\/)([^&?/]+)/) || [])[1] : null;
    const pageUrl = '/drop/curator/' + slug;
    const firstName = curator.name.split(' ')[0];

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${curator.name}'s Pick — UHT</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;1,400&family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:#080808;color:#ede8df;font-family:'Inter',sans-serif;overflow-x:hidden}
.page{max-width:680px;margin:0 auto}

/* Stamp */
.stamp{text-align:center;padding:52px 24px 40px}
.stamp-brand{font-size:9px;letter-spacing:.4em;text-transform:uppercase;color:rgba(237,232,223,0.3);margin-bottom:10px}
.stamp-month{font-size:9px;letter-spacing:.3em;text-transform:uppercase;color:rgba(237,232,223,0.2)}

/* Hero */
.hero{position:relative;width:100%;aspect-ratio:3/4;max-height:88vh;overflow:hidden;background:#111}
.hero img{width:100%;height:100%;object-fit:cover;object-position:center top;display:block}
.hero-grad{position:absolute;inset:0;background:linear-gradient(to bottom,transparent 35%,rgba(8,8,8,0.6) 70%,#080808 100%)}
.hero-name{position:absolute;bottom:0;left:0;right:0;padding:28px 32px 40px}
.c-name{font-family:'Playfair Display',serif;font-size:clamp(44px,11vw,76px);font-weight:700;line-height:1;letter-spacing:-1.5px;color:#ede8df}
.c-tier{font-size:9px;letter-spacing:.3em;text-transform:uppercase;color:rgba(237,232,223,0.35);margin-top:12px}

/* Bio */
.bio{padding:44px 32px;border-bottom:1px solid rgba(255,255,255,0.06)}
.bio p{font-family:'Playfair Display',serif;font-size:16px;line-height:2;color:rgba(237,232,223,0.5);font-style:italic}

/* Pick */
.pick{padding:56px 32px 36px}
.pick-meta{font-size:9px;letter-spacing:.35em;text-transform:uppercase;color:rgba(237,232,223,0.25);margin-bottom:24px}
.song-title{font-family:'Playfair Display',serif;font-size:clamp(38px,9vw,68px);font-weight:700;line-height:1.02;letter-spacing:-1.5px;color:#ede8df;margin-bottom:12px}
.song-artist{font-size:13px;letter-spacing:.2em;text-transform:uppercase;color:rgba(237,232,223,0.35);font-weight:400;margin-bottom:32px}
.song-note{font-family:'Playfair Display',serif;font-size:18px;font-style:italic;color:rgba(237,232,223,0.45);line-height:1.85;padding-left:22px;border-left:1px solid rgba(237,232,223,0.18);margin-bottom:40px}

/* Player */
.player-outer{width:100%;aspect-ratio:16/9;background:#000;overflow:hidden}
.player-outer iframe,#player{width:100%;height:100%;border:none;display:block}

/* Vote */
.vote-section{padding:44px 32px 24px}
.vote-label{font-size:9px;letter-spacing:.35em;text-transform:uppercase;color:rgba(237,232,223,0.2);text-align:center;margin-bottom:24px}
.vote-btn{display:block;width:100%;padding:20px;margin-bottom:14px;border-radius:14px;border:1px solid rgba(255,255,255,0.09);background:rgba(255,255,255,0.025);color:rgba(237,232,223,0.75);font-family:'Inter',sans-serif;font-size:16px;font-weight:400;cursor:pointer;transition:all .25s;text-align:center;letter-spacing:.03em}
.vote-btn:hover{background:rgba(255,255,255,0.07);border-color:rgba(255,255,255,0.18);color:#ede8df;transform:translateY(-2px)}
.vote-btn:active{transform:translateY(0)}
.vote-btn:disabled{opacity:.2;cursor:default;transform:none}
.vote-msg{text-align:center;font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:rgba(237,232,223,0.3);min-height:22px;padding:10px 0 4px}

/* Bottom */
.bottom{padding:8px 32px 72px;display:flex;flex-direction:column;align-items:center;gap:18px}
.sp-embed-wrap{width:100%}
.sp-btn{font-size:9px;letter-spacing:.25em;text-transform:uppercase;color:rgba(237,232,223,0.2);cursor:pointer;background:none;border:none;font-family:'Inter',sans-serif;padding:0}
.sp-btn:hover{color:rgba(237,232,223,0.45)}
.share-btn{font-size:9px;letter-spacing:.25em;text-transform:uppercase;color:rgba(237,232,223,0.3);cursor:pointer;background:none;border:1px solid rgba(237,232,223,0.12);border-radius:999px;padding:11px 26px;font-family:'Inter',sans-serif;transition:all .2s}
.share-btn:hover{color:#ede8df;border-color:rgba(237,232,223,0.35)}
.follow-a{font-size:9px;letter-spacing:.25em;text-transform:uppercase;color:rgba(237,232,223,0.18);text-decoration:none;font-family:'Inter',sans-serif;transition:color .2s}
.follow-a:hover{color:rgba(237,232,223,0.5)}
</style>
</head>
<body>
<div class="page">

<div class="stamp">
  <div class="stamp-brand">Undeniable Hit Theory</div>
  <div class="stamp-month">${curator.curator_month ? '🌙 Curator of the Month · ' + curator.curator_month : '🌙 Curator Pick'}</div>
</div>

<div class="hero">
  ${curator.image_url ? `<img src="${curator.image_url}" alt="${curator.name}">` : ''}
  <div class="hero-grad"></div>
  <div class="hero-name">
    <div class="c-name">${curator.name}</div>
    <div class="c-tier">${curatorTier}</div>
  </div>
</div>

${curator.bio ? `<div class="bio"><p>${curator.bio}</p></div>` : ''}

<div class="pick">
  <div class="pick-meta">${d.theme ? d.theme.toUpperCase() + ' · ' : ''}Week ${d.week_number}</div>
  <div class="song-title">${d.title}</div>
  <div class="song-artist">${d.artist}</div>
  ${d.curator_note ? `<div class="song-note">"${d.curator_note}"</div>` : ''}
</div>

${ytId ? `<div class="player-outer" id="ytWrap"><div id="player"></div></div>` : ''}
${!ytId && d.spotify_url ? `<div class="player-outer"><iframe src="https://open.spotify.com/embed/track/${d.spotify_url.match(/track\/([a-zA-Z0-9]+)/)?.[1]}" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" loading="lazy"></iframe></div>` : ''}

<div class="vote-section">
  <div class="vote-label">Is this an undeniable hit?</div>
  <button class="vote-btn" id="vMega" onclick="vote('mega_hit')">🔥 Mega Hit</button>
  <button class="vote-btn" id="vHit" onclick="vote('hit')">🎯 Hit</button>
  <button class="vote-btn" id="vDenied" onclick="vote('deny')">💀 Denied</button>
  <div class="vote-msg" id="voteMsg"></div>
</div>

<div class="bottom">
  ${ytId && d.spotify_url ? `
  <div id="spWrap" style="display:none;width:100%">
    <iframe style="border-radius:10px" src="https://open.spotify.com/embed/track/${d.spotify_url.match(/track\/([a-zA-Z0-9]+)/)?.[1]}" width="100%" height="152" frameBorder="0" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" loading="lazy"></iframe>
  </div>
  <button class="sp-btn" onclick="var w=document.getElementById('spWrap');w.style.display=w.style.display==='none'?'block':'none'">Prefer Spotify?</button>
  ` : ''}
  <button class="share-btn" onclick="sharePick()">Share this pick</button>
  <a class="follow-a" href="/uht-radio.html">Follow ${firstName} →</a>
</div>

</div>

${ytId ? `<script src="https://www.youtube.com/iframe_api"></script>
<script>
var player;
function onYouTubeIframeAPIReady(){
  player=new YT.Player('player',{videoId:'${ytId}',playerVars:{rel:0,modestbranding:1,playsinline:1}});
}
</script>` : ''}

<script>
function vote(v){
  ['vMega','vHit','vDenied'].forEach(function(id){var b=document.getElementById(id);if(b)b.disabled=true;});
  var msg=document.getElementById('voteMsg');
  fetch('/api/vote',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({submission_id:${d.id},vote:v,page:'curator'})})
  .then(function(r){return r.json();})
  .then(function(){
    var labels={mega_hit:'🔥 Mega Hit recorded!',hit:'🎯 Hit recorded!',deny:'💀 Denied recorded!'};
    if(msg) msg.textContent=labels[v]||'Recorded!';
  })
  .catch(function(){if(msg)msg.textContent='Try again.';['vMega','vHit','vDenied'].forEach(function(id){var b=document.getElementById(id);if(b)b.disabled=false;});});
}
function sharePick(){
  var url=window.location.href.split('?')[0]+'?ref=share';
  if(navigator.share){navigator.share({title:'${d.title} — ${d.artist}',text:'Is this an undeniable hit?',url:url});}
  else{navigator.clipboard.writeText(url).then(function(){document.getElementById('voteMsg').textContent='Link copied!';});}
}
</script>
</body>
</html>`);
  } catch(e) { res.status(500).send('<h1>Error: ' + e.message + '</h1>'); }
});


// ── GET /api/genre-submissions ───────────────────────────────────────────────
app.get('/api/genre-submissions', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM genre_submissions ORDER BY drop_date DESC, created_at DESC`
    );
    res.json({ submissions: rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/genre-submissions ──────────────────────────────────────────────
app.post('/api/genre-submissions', async (req, res) => {
  const { genre, week_title, title, artist, note, youtube_url, spotify_url, week_number, drop_date } = req.body;
  if (!genre || !title || !artist) return res.status(400).json({ error: 'genre, title and artist required.' });
  try {
    const { rows } = await db.query(
      `INSERT INTO genre_submissions (genre, week_title, title, artist, note, youtube_url, spotify_url, week_number, drop_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [genre, week_title||null, title, artist, note||null, youtube_url||null, spotify_url||null, week_number||1, drop_date||null]
    );
    res.json({ submission: rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/genre-submissions/:id ────────────────────────────────────────
app.patch('/api/genre-submissions/:id', async (req, res) => {
  const { genre, week_title, title, artist, note, youtube_url, spotify_url, week_number, drop_date } = req.body;
  if (!title || !artist) return res.status(400).json({ error: 'title and artist required.' });
  try {
    const { rows } = await db.query(
      `UPDATE genre_submissions SET genre=$1, week_title=$2, title=$3, artist=$4, note=$5,
       youtube_url=$6, spotify_url=$7, week_number=$8, drop_date=$9 WHERE id=$10 RETURNING *`,
      [genre, week_title||null, title, artist, note||null, youtube_url||null, spotify_url||null, week_number||1, drop_date||null, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found.' });
    res.json({ submission: rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/genre-submissions/:id ───────────────────────────────────────
app.delete('/api/genre-submissions/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM genre_submissions WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /drop/:genre ─────────────────────────────────────────────────────────
app.get('/drop/:genre', async (req, res) => {
  const genre = req.params.genre.toLowerCase();
  try {
    const { rows } = await db.query(
      `SELECT * FROM genre_submissions WHERE LOWER(genre)=$1
       ORDER BY drop_date DESC NULLS LAST, created_at DESC LIMIT 1`,
      [genre]
    );
    if (!rows.length) return res.status(404).send('<h1>No drop found for this genre.</h1>');
    const d = rows[0];
    const ytId = d.youtube_url ? (d.youtube_url.match(/(?:v=|youtu\.be\/)([^&?/]+)/) || [])[1] : null;
    const weekTitle = d.week_title || ('Undeniable ' + genre.charAt(0).toUpperCase() + genre.slice(1) + ' Hit of the Week');

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${weekTitle}</title>
<style>
html,body{background:#000;margin:0;padding:0;overflow-x:hidden;font-family:Georgia,"Times New Roman",serif;color:#f3f1ea}
.uht-hit{min-height:100svh;background:#000;display:flex;flex-direction:column;justify-content:flex-start;padding:12px 0 40px}
.uht-header{text-align:center;padding:0 14px;margin-bottom:14px}
.uht-label{font-size:11px;letter-spacing:.25em;opacity:.6;margin-bottom:10px;text-transform:uppercase}
.uht-title{margin:0;font-size:42px;line-height:1.05;font-weight:600}
.uht-sub{margin:16px 0 0}
.uht-song-name{display:block;font-size:24px;font-weight:600;opacity:.98}
.uht-artist-name{display:block;margin-top:4px;font-size:18px;opacity:.72}
.uht-note{margin-top:14px;font-size:17px;font-style:italic;opacity:.75}
.uht-play{margin-top:12px;font-size:11px;letter-spacing:.3em;opacity:.6;transition:opacity .4s ease;text-transform:uppercase}
.uht-video{position:relative;width:100%;aspect-ratio:16/9}
#player{width:100%;height:100%}
.uht-end{position:absolute;inset:0;background:rgba(0,0,0,.82);display:flex;align-items:center;justify-content:center;text-align:center;padding:20px;opacity:0;pointer-events:none;transition:opacity .45s ease}
.uht-end.show{opacity:1;pointer-events:all}
.uht-end p{margin:0;font-size:20px;line-height:1.6}
.vote-row{display:flex;gap:12px;justify-content:center;margin-top:24px;padding:0 14px}
.vote-btn{flex:1;max-width:160px;padding:14px;border-radius:12px;border:none;font-family:Georgia,serif;font-size:16px;cursor:pointer;transition:all .2s;letter-spacing:1px}
.vote-hit{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.15);color:rgba(255,255,255,.8)}.vote-hit:hover,.vote-hit:hover,.vote-hit:hover,.vote-hit:active{background:rgba(200,0,0,.3);border-color:rgba(200,0,0,.6);color:#ff4444}
.vote-denied{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.15);color:rgba(255,255,255,.8)}.vote-denied:hover,.vote-denied:hover,.vote-denied:hover,.vote-denied:active{background:rgba(200,0,0,.3);border-color:rgba(200,0,0,.6);color:#ff4444}
.vote-btn:disabled{opacity:.4;cursor:default}
.vote-confirm{text-align:center;margin-top:12px;font-size:13px;letter-spacing:.1em;opacity:.5;min-height:20px}
.no-video{padding:40px 14px;text-align:center}
.spotify-btn{display:inline-block;margin-top:16px;padding:12px 28px;border-radius:999px;background:#1DB954;color:#fff;text-decoration:none;font-size:15px;letter-spacing:1px}
@media(min-width:768px){
  .uht-hit{align-items:center;padding:20px 0 60px}
  .uht-title{font-size:clamp(48px,6vw,82px)}
  .uht-song-name{font-size:32px}
  .uht-artist-name{font-size:20px}
  .uht-note{font-size:19px}
  .uht-video{max-width:1400px}
}
</style>
</head>
<body>
<section class="uht-hit">
  <div class="uht-header">
    <div class="uht-label">Hit of the Week</div>
    <h1 class="uht-title">${weekTitle}</h1>
    <p class="uht-sub">
      <span class="uht-song-name">${d.title}</span>
      <span class="uht-artist-name">${d.artist}</span>
    </p>
    ${d.note ? `<p class="uht-note">${d.note}</p>` : ''}
    ${ytId ? `<div class="uht-play" id="uhtPlay">Press Play.</div>` : ''}
  </div>

  ${ytId ? `
  <div class="uht-video">
    <div id="player"></div>
    <div class="uht-end" id="endMessage">
      <p>This one's yours.<br><br>Your next hit arrives via text next Friday.</p>
    </div>
  </div>` : `
  <div class="no-video">
    ${d.spotify_url ? `<a class="spotify-btn" href="${d.spotify_url}" target="_blank">🎵 Play on Spotify</a>` : '<p style="opacity:.4">No playback source available.</p>'}
  </div>`}

  <div class="vote-row">
    <button class="vote-btn vote-hit" id="voteHit" onclick="castVote('hit')">🔥 Hit</button>
    <button class="vote-btn vote-denied" id="voteDenied" onclick="castVote('denied')">💀 Denied</button>
  </div>
  <div class="vote-confirm" id="voteConfirm"></div>
</section>

${ytId ? `
<script src="https://www.youtube.com/iframe_api"></script>
<script>
let player, shown=false, timerStarted=false;
function onYouTubeIframeAPIReady(){
  player = new YT.Player('player',{
    videoId:'${ytId}',
    playerVars:{rel:0,modestbranding:1,playsinline:1},
    events:{onStateChange:onPlayerStateChange}
  });
}
function onPlayerStateChange(e){
  if(e.data===YT.PlayerState.PLAYING){
    var p=document.getElementById('uhtPlay');
    if(p) p.style.opacity='0';
    if(!timerStarted){timerStarted=true;setInterval(checkTime,500);}
  }
}
function checkTime(){
  if(!player||shown) return;
  var c=player.getCurrentTime(), d=player.getDuration();
  if(d&&(d-c<=10)){document.getElementById('endMessage').classList.add('show');shown=true;}
}
</script>` : ''}

<script>
function castVote(type){
  document.getElementById('voteHit').disabled=true;
  document.getElementById('voteDenied').disabled=true;
  document.getElementById('voteConfirm').textContent = type==='hit' ? '🔥 Hit recorded!' : '💀 Denied recorded!';
  // Save vote via API
  fetch('/api/genre-vote', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({submission_id:${d.id}, vote:type})
  }).then(function(r){if(!r.ok)r.json().then(function(e){console.error('[vote error]',e);});})
    .catch(function(e){console.error('[vote network error]',e);});
}
</script>
</body>
</html>`);
  } catch(e) { res.status(500).send('<h1>Error: ' + e.message + '</h1>'); }
});


// ── GET /api/genre-submissions ───────────────────────────────────────────────
app.get('/api/genre-submissions', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM genre_submissions ORDER BY drop_date DESC, created_at DESC`
    );
    res.json({ submissions: rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/genre-submissions ──────────────────────────────────────────────
app.post('/api/genre-submissions', async (req, res) => {
  const { genre, week_title, title, artist, note, youtube_url, spotify_url, week_number, drop_date } = req.body;
  if (!genre || !title || !artist) return res.status(400).json({ error: 'genre, title and artist required.' });
  try {
    const { rows } = await db.query(
      `INSERT INTO genre_submissions (genre, week_title, title, artist, note, youtube_url, spotify_url, week_number, drop_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [genre, week_title||null, title, artist, note||null, youtube_url||null, spotify_url||null, week_number||1, drop_date||null]
    );
    res.json({ submission: rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/genre-submissions/:id ────────────────────────────────────────
app.patch('/api/genre-submissions/:id', async (req, res) => {
  const { genre, week_title, title, artist, note, youtube_url, spotify_url, week_number, drop_date } = req.body;
  if (!title || !artist) return res.status(400).json({ error: 'title and artist required.' });
  try {
    const { rows } = await db.query(
      `UPDATE genre_submissions SET genre=$1, week_title=$2, title=$3, artist=$4, note=$5,
       youtube_url=$6, spotify_url=$7, week_number=$8, drop_date=$9 WHERE id=$10 RETURNING *`,
      [genre, week_title||null, title, artist, note||null, youtube_url||null, spotify_url||null, week_number||1, drop_date||null, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found.' });
    res.json({ submission: rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/genre-submissions/:id ───────────────────────────────────────
app.delete('/api/genre-submissions/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM genre_submissions WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /drop/:genre ─────────────────────────────────────────────────────────
app.get('/drop/:genre', async (req, res) => {
  const genre = req.params.genre.toLowerCase();
  try {
    const { rows } = await db.query(
      `SELECT * FROM genre_submissions WHERE LOWER(genre)=$1
       ORDER BY drop_date DESC NULLS LAST, created_at DESC LIMIT 1`,
      [genre]
    );
    if (!rows.length) return res.status(404).send('<h1>No drop found for this genre.</h1>');
    const d = rows[0];
    const ytId = d.youtube_url ? (d.youtube_url.match(/(?:v=|youtu\.be\/)([^&?/]+)/) || [])[1] : null;
    const weekTitle = d.week_title || ('Undeniable ' + genre.charAt(0).toUpperCase() + genre.slice(1) + ' Hit of the Week');

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${weekTitle}</title>
<style>
html,body{background:#000;margin:0;padding:0;overflow-x:hidden;font-family:Georgia,"Times New Roman",serif;color:#f3f1ea}
.uht-hit{min-height:100svh;background:#000;display:flex;flex-direction:column;justify-content:flex-start;padding:12px 0 40px}
.uht-header{text-align:center;padding:0 14px;margin-bottom:14px}
.uht-label{font-size:11px;letter-spacing:.25em;opacity:.6;margin-bottom:10px;text-transform:uppercase}
.uht-title{margin:0;font-size:42px;line-height:1.05;font-weight:600}
.uht-sub{margin:16px 0 0}
.uht-song-name{display:block;font-size:24px;font-weight:600;opacity:.98}
.uht-artist-name{display:block;margin-top:4px;font-size:18px;opacity:.72}
.uht-note{margin-top:14px;font-size:17px;font-style:italic;opacity:.75}
.uht-play{margin-top:12px;font-size:11px;letter-spacing:.3em;opacity:.6;transition:opacity .4s ease;text-transform:uppercase}
.uht-video{position:relative;width:100%;aspect-ratio:16/9}
#player{width:100%;height:100%}
.uht-end{position:absolute;inset:0;background:rgba(0,0,0,.82);display:flex;align-items:center;justify-content:center;text-align:center;padding:20px;opacity:0;pointer-events:none;transition:opacity .45s ease}
.uht-end.show{opacity:1;pointer-events:all}
.uht-end p{margin:0;font-size:20px;line-height:1.6}
.vote-row{display:flex;gap:12px;justify-content:center;margin-top:24px;padding:0 14px}
.vote-btn{flex:1;max-width:160px;padding:14px;border-radius:12px;border:none;font-family:Georgia,serif;font-size:16px;cursor:pointer;transition:all .2s;letter-spacing:1px}
.vote-hit{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.15);color:rgba(255,255,255,.8)}.vote-hit:hover,.vote-hit:hover,.vote-hit:hover,.vote-hit:active{background:rgba(200,0,0,.3);border-color:rgba(200,0,0,.6);color:#ff4444}
.vote-denied{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.15);color:rgba(255,255,255,.8)}.vote-denied:hover,.vote-denied:hover,.vote-denied:hover,.vote-denied:active{background:rgba(200,0,0,.3);border-color:rgba(200,0,0,.6);color:#ff4444}
.vote-btn:disabled{opacity:.4;cursor:default}
.vote-confirm{text-align:center;margin-top:12px;font-size:13px;letter-spacing:.1em;opacity:.5;min-height:20px}
.no-video{padding:40px 14px;text-align:center}
.spotify-btn{display:inline-block;margin-top:16px;padding:12px 28px;border-radius:999px;background:#1DB954;color:#fff;text-decoration:none;font-size:15px;letter-spacing:1px}
@media(min-width:768px){
  .uht-hit{align-items:center;padding:20px 0 60px}
  .uht-title{font-size:clamp(48px,6vw,82px)}
  .uht-song-name{font-size:32px}
  .uht-artist-name{font-size:20px}
  .uht-note{font-size:19px}
  .uht-video{max-width:1400px}
}
</style>
</head>
<body>
<section class="uht-hit">
  <div class="uht-header">
    <div class="uht-label">Hit of the Week</div>
    <h1 class="uht-title">${weekTitle}</h1>
    <p class="uht-sub">
      <span class="uht-song-name">${d.title}</span>
      <span class="uht-artist-name">${d.artist}</span>
    </p>
    ${d.note ? `<p class="uht-note">${d.note}</p>` : ''}
    ${ytId ? `<div class="uht-play" id="uhtPlay">Press Play.</div>` : ''}
  </div>

  ${ytId ? `
  <div class="uht-video">
    <div id="player"></div>
    <div class="uht-end" id="endMessage">
      <p>This one's yours.<br><br>Your next hit arrives via text next Friday.</p>
    </div>
  </div>` : `
  <div class="no-video">
    ${d.spotify_url ? `<a class="spotify-btn" href="${d.spotify_url}" target="_blank">🎵 Play on Spotify</a>` : '<p style="opacity:.4">No playback source available.</p>'}
  </div>`}

  <div class="vote-row">
    <button class="vote-btn vote-hit" id="voteHit" onclick="castVote('hit')">🔥 Hit</button>
    <button class="vote-btn vote-denied" id="voteDenied" onclick="castVote('denied')">💀 Denied</button>
  </div>
  <div class="vote-confirm" id="voteConfirm"></div>
</section>

${ytId ? `
<script src="https://www.youtube.com/iframe_api"></script>
<script>
let player, shown=false, timerStarted=false;
function onYouTubeIframeAPIReady(){
  player = new YT.Player('player',{
    videoId:'${ytId}',
    playerVars:{rel:0,modestbranding:1,playsinline:1},
    events:{onStateChange:onPlayerStateChange}
  });
}
function onPlayerStateChange(e){
  if(e.data===YT.PlayerState.PLAYING){
    var p=document.getElementById('uhtPlay');
    if(p) p.style.opacity='0';
    if(!timerStarted){timerStarted=true;setInterval(checkTime,500);}
  }
}
function checkTime(){
  if(!player||shown) return;
  var c=player.getCurrentTime(), d=player.getDuration();
  if(d&&(d-c<=10)){document.getElementById('endMessage').classList.add('show');shown=true;}
}
</script>` : ''}

<script>
function castVote(type){
  document.getElementById('voteHit').disabled=true;
  document.getElementById('voteDenied').disabled=true;
  document.getElementById('voteConfirm').textContent = type==='hit' ? '🔥 Hit recorded!' : '💀 Denied recorded!';
  // Save vote via API
  fetch('/api/genre-vote', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({submission_id:${d.id}, vote:type})
  }).then(function(r){if(!r.ok)r.json().then(function(e){console.error('[vote error]',e);});})
    .catch(function(e){console.error('[vote network error]',e);});
}
</script>
</body>
</html>`);
  } catch(e) { res.status(500).send('<h1>Error: ' + e.message + '</h1>'); }
});


// ── GET /api/genre-submissions ───────────────────────────────────────────────
app.get('/api/genre-submissions', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM genre_submissions ORDER BY drop_date DESC, created_at DESC`
    );
    res.json({ submissions: rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/genre-submissions ──────────────────────────────────────────────
app.post('/api/genre-submissions', async (req, res) => {
  const { genre, week_title, title, artist, note, youtube_url, spotify_url, week_number, drop_date } = req.body;
  if (!genre || !title || !artist) return res.status(400).json({ error: 'genre, title and artist required.' });
  try {
    const { rows } = await db.query(
      `INSERT INTO genre_submissions (genre, week_title, title, artist, note, youtube_url, spotify_url, week_number, drop_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [genre, week_title||null, title, artist, note||null, youtube_url||null, spotify_url||null, week_number||1, drop_date||null]
    );
    res.json({ submission: rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/genre-submissions/:id ────────────────────────────────────────
app.patch('/api/genre-submissions/:id', async (req, res) => {
  const { genre, week_title, title, artist, note, youtube_url, spotify_url, week_number, drop_date } = req.body;
  if (!title || !artist) return res.status(400).json({ error: 'title and artist required.' });
  try {
    const { rows } = await db.query(
      `UPDATE genre_submissions SET genre=$1, week_title=$2, title=$3, artist=$4, note=$5,
       youtube_url=$6, spotify_url=$7, week_number=$8, drop_date=$9 WHERE id=$10 RETURNING *`,
      [genre, week_title||null, title, artist, note||null, youtube_url||null, spotify_url||null, week_number||1, drop_date||null, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found.' });
    res.json({ submission: rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/genre-submissions/:id ───────────────────────────────────────
app.delete('/api/genre-submissions/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM genre_submissions WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /drop/:genre ─────────────────────────────────────────────────────────
app.get('/drop/:genre', async (req, res) => {
  const genre = req.params.genre.toLowerCase();
  try {
    const { rows } = await db.query(
      `SELECT * FROM genre_submissions WHERE LOWER(genre)=$1
       ORDER BY drop_date DESC NULLS LAST, created_at DESC LIMIT 1`,
      [genre]
    );
    if (!rows.length) return res.status(404).send('<h1>No drop found for this genre.</h1>');
    const d = rows[0];
    const ytId = d.youtube_url ? (d.youtube_url.match(/(?:v=|youtu\.be\/)([^&?/]+)/) || [])[1] : null;
    const weekTitle = d.week_title || ('Undeniable ' + genre.charAt(0).toUpperCase() + genre.slice(1) + ' Hit of the Week');

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${weekTitle}</title>
<style>
html,body{background:#000;margin:0;padding:0;overflow-x:hidden;font-family:Georgia,"Times New Roman",serif;color:#f3f1ea}
.uht-hit{min-height:100svh;background:#000;display:flex;flex-direction:column;justify-content:flex-start;padding:12px 0 40px}
.uht-header{text-align:center;padding:0 14px;margin-bottom:14px}
.uht-label{font-size:11px;letter-spacing:.25em;opacity:.6;margin-bottom:10px;text-transform:uppercase}
.uht-title{margin:0;font-size:42px;line-height:1.05;font-weight:600}
.uht-sub{margin:16px 0 0}
.uht-song-name{display:block;font-size:24px;font-weight:600;opacity:.98}
.uht-artist-name{display:block;margin-top:4px;font-size:18px;opacity:.72}
.uht-note{margin-top:14px;font-size:17px;font-style:italic;opacity:.75}
.uht-play{margin-top:12px;font-size:11px;letter-spacing:.3em;opacity:.6;transition:opacity .4s ease;text-transform:uppercase}
.uht-video{position:relative;width:100%;aspect-ratio:16/9}
#player{width:100%;height:100%}
.uht-end{position:absolute;inset:0;background:rgba(0,0,0,.82);display:flex;align-items:center;justify-content:center;text-align:center;padding:20px;opacity:0;pointer-events:none;transition:opacity .45s ease}
.uht-end.show{opacity:1;pointer-events:all}
.uht-end p{margin:0;font-size:20px;line-height:1.6}
.vote-row{display:flex;gap:12px;justify-content:center;margin-top:24px;padding:0 14px}
.vote-btn{flex:1;max-width:160px;padding:14px;border-radius:12px;border:none;font-family:Georgia,serif;font-size:16px;cursor:pointer;transition:all .2s;letter-spacing:1px}
.vote-hit{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.15);color:rgba(255,255,255,.8)}.vote-hit:hover,.vote-hit:hover,.vote-hit:hover,.vote-hit:active{background:rgba(200,0,0,.3);border-color:rgba(200,0,0,.6);color:#ff4444}
.vote-denied{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.15);color:rgba(255,255,255,.8)}.vote-denied:hover,.vote-denied:hover,.vote-denied:hover,.vote-denied:active{background:rgba(200,0,0,.3);border-color:rgba(200,0,0,.6);color:#ff4444}
.vote-btn:disabled{opacity:.4;cursor:default}
.vote-confirm{text-align:center;margin-top:12px;font-size:13px;letter-spacing:.1em;opacity:.5;min-height:20px}
.no-video{padding:40px 14px;text-align:center}
.spotify-btn{display:inline-block;margin-top:16px;padding:12px 28px;border-radius:999px;background:#1DB954;color:#fff;text-decoration:none;font-size:15px;letter-spacing:1px}
@media(min-width:768px){
  .uht-hit{align-items:center;padding:20px 0 60px}
  .uht-title{font-size:clamp(48px,6vw,82px)}
  .uht-song-name{font-size:32px}
  .uht-artist-name{font-size:20px}
  .uht-note{font-size:19px}
  .uht-video{max-width:1400px}
}
</style>
</head>
<body>
<section class="uht-hit">
  <div class="uht-header">
    <div class="uht-label">Hit of the Week</div>
    <h1 class="uht-title">${weekTitle}</h1>
    <p class="uht-sub">
      <span class="uht-song-name">${d.title}</span>
      <span class="uht-artist-name">${d.artist}</span>
    </p>
    ${d.note ? `<p class="uht-note">${d.note}</p>` : ''}
    ${ytId ? `<div class="uht-play" id="uhtPlay">Press Play.</div>` : ''}
  </div>

  ${ytId ? `
  <div class="uht-video">
    <div id="player"></div>
    <div class="uht-end" id="endMessage">
      <p>This one's yours.<br><br>Your next hit arrives via text next Friday.</p>
    </div>
  </div>` : `
  <div class="no-video">
    ${d.spotify_url ? `<a class="spotify-btn" href="${d.spotify_url}" target="_blank">🎵 Play on Spotify</a>` : '<p style="opacity:.4">No playback source available.</p>'}
  </div>`}

  <div class="vote-row">
    <button class="vote-btn vote-hit" id="voteHit" onclick="castVote('hit')">🔥 Hit</button>
    <button class="vote-btn vote-denied" id="voteDenied" onclick="castVote('denied')">💀 Denied</button>
  </div>
  <div class="vote-confirm" id="voteConfirm"></div>
</section>

${ytId ? `
<script src="https://www.youtube.com/iframe_api"></script>
<script>
let player, shown=false, timerStarted=false;
function onYouTubeIframeAPIReady(){
  player = new YT.Player('player',{
    videoId:'${ytId}',
    playerVars:{rel:0,modestbranding:1,playsinline:1},
    events:{onStateChange:onPlayerStateChange}
  });
}
function onPlayerStateChange(e){
  if(e.data===YT.PlayerState.PLAYING){
    var p=document.getElementById('uhtPlay');
    if(p) p.style.opacity='0';
    if(!timerStarted){timerStarted=true;setInterval(checkTime,500);}
  }
}
function checkTime(){
  if(!player||shown) return;
  var c=player.getCurrentTime(), d=player.getDuration();
  if(d&&(d-c<=10)){document.getElementById('endMessage').classList.add('show');shown=true;}
}
</script>` : ''}

<script>
function castVote(type){
  document.getElementById('voteHit').disabled=true;
  document.getElementById('voteDenied').disabled=true;
  document.getElementById('voteConfirm').textContent = type==='hit' ? '🔥 Hit recorded!' : '💀 Denied recorded!';
  // Save vote via API
  fetch('/api/genre-vote', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({submission_id:${d.id}, vote:type})
  }).then(function(r){if(!r.ok)r.json().then(function(e){console.error('[vote error]',e);});})
    .catch(function(e){console.error('[vote network error]',e);});
}
</script>
</body>
</html>`);
  } catch(e) { res.status(500).send('<h1>Error: ' + e.message + '</h1>'); }
});


// ── POST /api/genre-vote ─────────────────────────────────────
app.post('/api/genre-vote', async (req, res) => {
  const { submission_id, vote } = req.body;
  if (!submission_id || !vote) {
    return res.status(400).json({ error: 'submission_id and vote are required.' });
  }
  const dbVote = vote === 'mega_hit' ? 'hit' : vote === 'deny' ? 'denied' : vote;
  if (!['hit', 'denied'].includes(dbVote)) {
    return res.status(400).json({ error: 'vote must be hit, denied, mega_hit, or deny.' });
  }
  // Compute voter fingerprint from IP + user agent
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
  const ua = req.headers['user-agent'] || '';
  const voterHash = require('crypto').createHash('sha256').update(ip + ua).digest('hex');
  try {
    const { rows } = await db.query(
      `INSERT INTO curator_submission_votes (submission_id, vote, voter_hash)
       VALUES ($1, $2, $3)
       ON CONFLICT (submission_id, voter_hash) WHERE voter_hash IS NOT NULL
       DO NOTHING RETURNING *`,
      [submission_id, dbVote, voterHash]
    );
    if (rows.length === 0) {
      return res.json({ ok: true, duplicate: true });
    }
    res.json({ ok: true, vote: rows[0] });
  } catch (e) {
    console.error('[genre-vote error]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`\nUHT server running on port ${PORT}`);
  console.log(`  API:     GET  http://localhost:${PORT}/api/genres`);
  console.log(`  API:     GET  http://localhost:${PORT}/api/curators`);
  console.log(`  API:     POST http://localhost:${PORT}/api/subscribe`);
  console.log(`  Webhook: POST http://localhost:${PORT}/sms\n`);
});


// =============================================================================
// ADMIN API ROUTES  (used by admin.html)
// =============================================================================

// ── GET /api/songs ────────────────────────────────────────────────────────────
app.get('/api/songs', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT s.*, 
        COALESCE(c.name, g.name) AS target_name
      FROM songs s
      LEFT JOIN curators c ON c.id = s.curator_id
      LEFT JOIN genres   g ON g.id = s.genre_id
      ORDER BY s.id DESC
    `);
    res.json({ songs: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/songs ───────────────────────────────────────────────────────────
app.post('/api/songs', async (req, res) => {
  const { title, artist, url, genre_id, curator_id } = req.body;
  if (!title || !artist) return res.status(400).json({ error: 'title and artist required.' });
  try {
    const { rows } = await db.query(
      `INSERT INTO songs (title, artist, url, genre_id, curator_id)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [title, artist, url || null, genre_id || null, curator_id || null]
    );
    res.json({ song: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/songs/:id ─────────────────────────────────────────────────────
app.delete('/api/songs/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM songs WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/genres-admin (with counts) ──────────────────────────────────────
app.get('/api/genres-admin', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT g.*,
        COUNT(DISTINCT s.id)  AS song_count,
        COUNT(DISTINCT sb.id) AS sub_count
      FROM genres g
      LEFT JOIN songs s ON s.genre_id = g.id
      LEFT JOIN subscriptions sb ON sb.genre_id = g.id
      GROUP BY g.id ORDER BY g.name
    `);
    res.json({ genres: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/genres ──────────────────────────────────────────────────────────
app.post('/api/genres', async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required.' });
  try {
    const { rows } = await db.query(
      `INSERT INTO genres (name) VALUES ($1) RETURNING *`, [name]
    );
    res.json({ genre: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/genres/:id ────────────────────────────────────────────────────
app.delete('/api/genres/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM genres WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/curators-admin (with counts) ────────────────────────────────────
app.get('/api/curators-admin', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT c.*,
        COUNT(DISTINCT s.id)  AS song_count,
        COUNT(DISTINCT sb.id) AS sub_count,
        COUNT(DISTINCT f.id)  AS follower_count
      FROM curators c
      LEFT JOIN songs s ON s.curator_id = c.id
      LEFT JOIN subscriptions sb ON sb.curator_id = c.id
      LEFT JOIN follows f ON f.curator_id = c.id
      GROUP BY c.id ORDER BY c.name
    `);
    res.json({ curators: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/curators ────────────────────────────────────────────────────────
app.post('/api/curators', async (req, res) => {
  const { name, bio, image_url, instagram, curator_month, monthly_theme } = req.body;
  if (!name) return res.status(400).json({ error: 'name required.' });
  try {
    const { rows } = await db.query(
      `INSERT INTO curators (name, bio, image_url, instagram, curator_month, monthly_theme) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [name, bio || null, image_url || null, instagram || null, curator_month || null, monthly_theme || null]
    );
    res.json({ curator: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/curators/:id ──────────────────────────────────────────────────
app.delete('/api/curators/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM curators WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/subscribers (joined with target name) ────────────────────────────
app.get('/api/subscribers', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT sb.*, u.phone, u.name, u.email,
        COALESCE(c.name, g.name) AS target_name
      FROM subscriptions sb
      JOIN users u ON u.id = sb.user_id
      LEFT JOIN curators c ON c.id = sb.curator_id
      LEFT JOIN genres   g ON g.id = sb.genre_id
      ORDER BY sb.id DESC
    `);
    res.json({ subscribers: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/subscribers/:id  (pause/resume) ───────────────────────────────
app.patch('/api/subscribers/:id', async (req, res) => {
  const { is_active } = req.body;
  try {
    await db.query('UPDATE subscriptions SET is_active=$1 WHERE id=$2', [is_active, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/subscribers/:id ───────────────────────────────────────────────
app.delete('/api/subscribers/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM subscriptions WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ── PATCH /api/users/:id (update name + email) ───────────────────────────────
app.patch('/api/users/:id', async (req, res) => {
  const { name, email } = req.body;
  try {
    await db.query('UPDATE users SET name=$1, email=$2 WHERE id=$3', [name, email, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/messages/test ───────────────────────────────────────────────────
app.post('/api/messages/test', async (req, res) => {
  const { to, message } = req.body;
  if (!to || !message) return res.status(400).json({ error: 'to and message required' });
  try {
    const msg = await twilioClient.messages.create({
      body: message,
      from: process.env.TWILIO_FROM,
      to: to
    });
    res.json({ ok: true, sid: msg.sid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/deliveries  (recent 50, joined) ──────────────────────────────────
app.get('/api/deliveries', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT d.*, u.phone, s.title, s.artist, v.vote
      FROM deliveries d
      JOIN users u ON u.id = d.user_id
      JOIN songs s ON s.id = d.song_id
      LEFT JOIN votes v ON v.delivery_id = d.id
      ORDER BY d.sent_at DESC
      LIMIT 50
    `);
    res.json({ deliveries: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/votes ────────────────────────────────────────────────────────────
app.get('/api/votes', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT v.*, u.phone, s.title, s.artist
      FROM votes v
      JOIN users u ON u.id = v.user_id
      JOIN songs s ON s.id = v.song_id
      ORDER BY v.updated_at DESC
    `);
    res.json({ votes: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/curators/:id ───────────────────────────────────────────────────
app.patch('/api/curators/:id', async (req, res) => {
  console.log('PATCH body:', req.body);
  const { name, bio, image_url, instagram, curator_month, monthly_theme } = req.body;
  if (!name) return res.status(400).json({ error: 'name required.' });
  try {
    const { rows } = await db.query(
      `UPDATE curators SET name=$1, bio=$2, image_url=$3, instagram=$4, curator_month=$5, monthly_theme=$6 WHERE id=$7 RETURNING *`,
      [name, bio || null, image_url || null, instagram || null, curator_month || null, monthly_theme || null, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Curator not found.' });
    res.json({ curator: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ── POST /api/vote ────────────────────────────────────────────
app.post('/api/vote', async (req, res) => {
  const { subscriber_id, curator_id, playlist_id, song_id, vote_type } = req.body;
  if (!subscriber_id || !song_id || !vote_type) {
    return res.status(400).json({ error: 'subscriber_id, song_id, and vote_type are required.' });
  }
  if (!['hit', 'deny', 'mega_hit'].includes(vote_type)) {
    return res.status(400).json({ error: 'vote_type must be hit, deny, or mega_hit.' });
  }
  try {
    const { rows } = await db.query(`
      INSERT INTO song_votes (subscriber_id, curator_id, playlist_id, song_id, vote_type)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (subscriber_id, song_id, playlist_id)
      DO UPDATE SET vote_type = EXCLUDED.vote_type, created_at = NOW()
      RETURNING *
    `, [subscriber_id, curator_id || null, playlist_id || null, song_id, vote_type === 'mega_hit' ? 'ultra_hit' : vote_type]);
    res.json({ vote: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/curators/:id/stats ───────────────────────────────
app.get('/api/curators/:id/stats', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM curator_stats WHERE curator_id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Curator not found.' });
    res.json({ stats: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/curators/leaderboard ────────────────────────────
app.get('/api/curators/leaderboard', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM curator_stats WHERE total_votes >= 5 ORDER BY hit_rate DESC NULLS LAST');
    res.json({ leaderboard: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/playlists ───────────────────────────────────────
app.post('/api/playlists', async (req, res) => {
  const { curator_id, theme, week } = req.body;
  if (!curator_id || !theme) return res.status(400).json({ error: 'curator_id and theme required.' });
  try {
    const { rows } = await db.query(
      'INSERT INTO playlists (curator_id, theme, week) VALUES ($1, $2, $3) RETURNING *',
      [curator_id, theme, week || 1]
    );
    res.json({ playlist: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/playlists/:id/songs ─────────────────────────────
app.post('/api/playlists/:id/songs', async (req, res) => {
  const { song_id, curator_note, position } = req.body;
  if (!song_id) return res.status(400).json({ error: 'song_id required.' });
  try {
    const { rows } = await db.query(
      'INSERT INTO playlist_songs (playlist_id, song_id, curator_note, position) VALUES ($1, $2, $3, $4) RETURNING *',
      [req.params.id, song_id, curator_note || null, position || 1]
    );
    res.json({ playlist_song: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/playlists/:id ────────────────────────────────────
app.get('/api/playlists/:id', async (req, res) => {
  try {
    const playlist = await db.query(`
      SELECT p.*, c.name AS curator_name, c.instagram AS curator_instagram
      FROM playlists p LEFT JOIN curators c ON c.id = p.curator_id
      WHERE p.id = $1
    `, [req.params.id]);
    if (!playlist.rows.length) return res.status(404).json({ error: 'Playlist not found.' });
    const songs = await db.query(`
      SELECT ps.*, s.title, s.artist
      FROM playlist_songs ps LEFT JOIN songs s ON s.id = ps.song_id
      WHERE ps.playlist_id = $1 ORDER BY ps.position ASC
    `, [req.params.id]);
    res.json({ playlist: playlist.rows[0], songs: songs.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/curators/:id/scorecard', async (req, res) => {
  try {
    const id = req.params.id;
    const stats = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE vote_type='mega_hit') AS mega_hits,
        COUNT(*) FILTER (WHERE vote_type='hit')       AS hits,
        COUNT(*) FILTER (WHERE vote_type='deny')      AS denies,
        COUNT(*)                                       AS total,
        ROUND(
          100.0 * COUNT(*) FILTER (WHERE vote_type IN ('hit','mega_hit'))
          / NULLIF(COUNT(*),0), 1
        ) AS hit_rate
      FROM song_votes WHERE curator_id=$1`, [id]);

    const submissions = await db.query(`
      SELECT cs.*,
        COUNT(*) FILTER (WHERE sv.vote_type='mega_hit') AS mega_hits,
        COUNT(*) FILTER (WHERE sv.vote_type='hit')       AS hits,
        COUNT(*) FILTER (WHERE sv.vote_type='deny')      AS denies
      FROM curator_submissions cs
      LEFT JOIN songs s ON LOWER(s.title)=LOWER(cs.title) AND LOWER(s.artist)=LOWER(cs.artist)
      LEFT JOIN song_votes sv ON sv.song_id=s.id AND sv.curator_id=cs.curator_id
      WHERE cs.curator_id=$1
      GROUP BY cs.id
      ORDER BY cs.week_number DESC, cs.submitted_at DESC`, [id]);

    // Combined lifetime hits from both SMS votes and web votes
    const combinedHits = await db.query(`
      SELECT
        COALESCE((
          SELECT COUNT(*) FROM song_votes
          WHERE curator_id=$1 AND vote_type IN ('hit','mega_hit','ultra_hit')
        ),0)
        +
        COALESCE((
          SELECT COUNT(*) FROM curator_submission_votes
          WHERE submission_id IN (
            SELECT id FROM curator_submissions WHERE curator_id=$1
          ) AND vote='hit'
        ),0) AS total_hits
    `, [id]);

    const totalHits = parseInt(combinedHits.rows[0].total_hits, 10);
    const tier =
      totalHits >= 28 ? '🏆 Legend' :
      totalHits >= 18 ? '👑 Tastemaker' :
      totalHits >= 8  ? '🎯 Hit Hunter' :
                        '🌙 Rising Curator';

    res.json({ stats: stats.rows[0], submissions: submissions.rows, totalHits, tier });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/test-new', (req, res) => res.json({ ok: true }));
require('./curator-scheduler');
