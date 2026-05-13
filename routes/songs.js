'use strict';
const express = require('express');
const router  = express.Router();
const db      = require('../db');

// ── GET /api/songs ────────────────────────────────────────────────────────────
router.get('/songs', async (req, res) => {
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
router.post('/songs', async (req, res) => {
  const { title, artist, url, youtube_url, genre_id, curator_id } = req.body;
  if (!title || !artist) return res.status(400).json({ error: 'title and artist required.' });
  try {
    const { rows } = await db.query(
      `INSERT INTO songs (title, artist, url, youtube_url, genre_id, curator_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [title, artist, url || null, youtube_url || null, genre_id || null, curator_id || null]
    );
    res.json({ song: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/songs/:id ─────────────────────────────────────────────────────
router.patch('/songs/:id', async (req, res) => {
  const { title, artist, url, youtube_url, genre_id, curator_id } = req.body;
  if (!title || !artist) return res.status(400).json({ error: 'title and artist required.' });
  try {
    const { rows } = await db.query(
      `UPDATE songs SET title=$1, artist=$2, url=$3, youtube_url=$4, genre_id=$5, curator_id=$6
       WHERE id=$7 RETURNING *`,
      [title, artist, url || null, youtube_url || null, genre_id || null, curator_id || null, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Song not found.' });
    res.json({ song: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/songs/:id ─────────────────────────────────────────────────────
router.delete('/songs/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await db.query('DELETE FROM votes      WHERE song_id = $1', [id]);
    await db.query('DELETE FROM song_votes WHERE song_id = $1', [id]).catch(() => {});
    await db.query('DELETE FROM deliveries WHERE song_id = $1', [id]);
    await db.query('DELETE FROM songs WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
