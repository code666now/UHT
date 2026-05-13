'use strict';
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const crypto  = require('crypto');

// verifySession is needed to resolve user from cookie for genre-vote
// We pass it in via app.locals set in server.js
function getVerifySession(req) {
  return req.app.locals.verifySession;
}

// ── GET /api/votes ────────────────────────────────────────────────────────────
router.get('/votes', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        'sms'            AS source,
        u.phone, u.name,
        s.title, s.artist,
        v.vote,
        v.updated_at     AS voted_at
      FROM votes v
      JOIN users u ON u.id = v.user_id
      JOIN songs s ON s.id = v.song_id

      UNION ALL

      SELECT
        'web'            AS source,
        u.phone,
        u.name,
        cs.title, cs.artist,
        csv.vote,
        csv.voted_at     AS voted_at
      FROM curator_submission_votes csv
      JOIN curator_submissions cs ON cs.id = csv.submission_id
      LEFT JOIN users u ON u.id = csv.user_id

      UNION ALL

      SELECT
        'web'            AS source,
        NULL             AS phone,
        NULL             AS name,
        s.title, s.artist,
        sv.vote_type     AS vote,
        sv.created_at    AS voted_at
      FROM song_votes sv
      JOIN songs s ON s.id = sv.song_id

      ORDER BY voted_at DESC
    `);
    res.json({ votes: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/vote ────────────────────────────────────────────────────────────
router.post('/vote', async (req, res) => {
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

// ── POST /api/genre-vote ──────────────────────────────────────────────────────
router.post('/genre-vote', async (req, res) => {
  const { submission_id, vote } = req.body;
  if (!submission_id || !vote) {
    return res.status(400).json({ error: 'submission_id and vote are required.' });
  }
  const dbVote = vote === 'deny' ? 'denied' : vote;
  if (!['hit', 'denied', 'mega_hit'].includes(dbVote)) {
    return res.status(400).json({ error: 'vote must be hit, denied, mega_hit, or deny.' });
  }

  const verifySession = getVerifySession(req);
  const cookieHeader  = req.headers.cookie || '';
  const sessionPart   = cookieHeader.split(';').map(c => c.trim()).find(c => c.startsWith('uht_session='));
  const sessionVal    = sessionPart ? decodeURIComponent(sessionPart.split('=').slice(1).join('=')) : null;
  let userId          = sessionVal ? verifySession(sessionVal) : null;

  if (!userId && req.body.taste_token) {
    const { rows: tRows } = await db.query(
      `SELECT id FROM users WHERE taste_token=$1 LIMIT 1`, [req.body.taste_token]
    );
    if (tRows.length) userId = tRows[0].id;
  }

  const clientId    = req.body.voter_id || '';
  const ip          = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
  const ua          = req.headers['user-agent'] || '';
  const fingerprint = clientId || (ip + ua);
  const voterHash   = crypto.createHash('sha256').update(fingerprint).digest('hex');

  try {
    if (userId) {
      const { rows: existing } = await db.query(
        `SELECT id FROM curator_submission_votes WHERE submission_id=$1 AND user_id=$2 LIMIT 1`,
        [submission_id, userId]
      );
      if (existing.length) {
        await db.query(
          `UPDATE curator_submission_votes SET vote=$1, voted_at=NOW() WHERE id=$2`,
          [dbVote, existing[0].id]
        );
        return res.json({ ok: true, updated: true });
      }
      await db.query(
        `INSERT INTO curator_submission_votes (submission_id, vote, voter_hash, user_id) VALUES ($1,$2,$3,$4)`,
        [submission_id, dbVote, voterHash, userId]
      );
      return res.json({ ok: true });
    }

    const { rows } = await db.query(
      `INSERT INTO curator_submission_votes (submission_id, vote, voter_hash)
       VALUES ($1, $2, $3)
       ON CONFLICT (submission_id, voter_hash) WHERE voter_hash IS NOT NULL
       DO UPDATE SET vote=$2, voted_at=NOW() RETURNING *`,
      [submission_id, dbVote, voterHash]
    );
    res.json({ ok: true, vote: rows[0] });
  } catch (e) {
    console.error('[genre-vote error]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/genre-vote/:id/counts ───────────────────────────────────────────
router.get('/genre-vote/:id/counts', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE vote = 'mega_hit') AS mega_hits,
        COUNT(*) FILTER (WHERE vote = 'hit')      AS hits,
        COUNT(*) FILTER (WHERE vote = 'denied')   AS denied,
        COUNT(*)                                  AS total
      FROM curator_submission_votes
      WHERE submission_id = $1
    `, [req.params.id]);
    const r = rows[0];
    res.json({
      mega_hits: parseInt(r.mega_hits) || 0,
      hits:      parseInt(r.hits)      || 0,
      denied:    parseInt(r.denied)    || 0,
      total:     parseInt(r.total)     || 0,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
