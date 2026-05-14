'use strict';
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const OpenAI  = require('openai');

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

// ── POST /api/songs/:id/autotag ───────────────────────────────────────────────
router.post('/songs/:id/autotag', async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({ error: 'OPENAI_API_KEY not configured.' });
  }
  try {
    const { rows } = await db.query('SELECT title, artist FROM songs WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Song not found.' });
    const { title, artist } = rows[0];

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are a music tagger. Return only valid JSON, no markdown.'
        },
        {
          role: 'user',
          content: `Tag this song. Title: "${title}". Artist: "${artist}".
Return a JSON object with exactly these fields:
- mood: array of 1-3 values chosen from: "dark", "euphoric", "melancholic", "energetic", "chill"
- energy: integer 1-10 (1=very low, 10=extremely high)
- era: one of "60s", "70s", "80s", "90s", "00s", "modern"
- tempo: one of "slow", "mid", "fast"
- subgenre: specific subgenre string (e.g. "hard rock", "dream pop", "alt country")
- similar_artists: array of 2-3 similar artist names`
        }
      ],
      max_tokens: 200,
      temperature: 0.3
    });

    let tags;
    try {
      tags = JSON.parse(completion.choices[0].message.content.trim());
    } catch (e) {
      return res.status(500).json({ error: 'Failed to parse AI response.', raw: completion.choices[0].message.content });
    }

    await db.query('UPDATE songs SET tags=$1 WHERE id=$2', [JSON.stringify(tags), req.params.id]);
    res.json({ ok: true, tags });
  } catch (e) {
    console.error('[autotag error]', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
