'use strict';
const express = require('express');
const router  = express.Router();
const db      = require('../db');

// ── GET /api/subscribers ──────────────────────────────────────────────────────
router.get('/subscribers', async (req, res) => {
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

// ── PATCH /api/subscribers/:id ────────────────────────────────────────────────
router.patch('/subscribers/:id', async (req, res) => {
  const { is_active, genre_id, curator_id } = req.body;
  try {
    if (is_active !== undefined) {
      await db.query('UPDATE subscriptions SET is_active=$1 WHERE id=$2', [is_active, req.params.id]);
    }
    if (genre_id !== undefined || curator_id !== undefined) {
      await db.query(
        'UPDATE subscriptions SET genre_id=$1, curator_id=$2 WHERE id=$3',
        [genre_id || null, curator_id || null, req.params.id]
      );
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/subscribers/:id ───────────────────────────────────────────────
router.delete('/subscribers/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM subscriptions WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/users/:id ─────────────────────────────────────────────────────
router.patch('/users/:id', async (req, res) => {
  const { name, email } = req.body;
  try {
    await db.query('UPDATE users SET name=$1, email=$2 WHERE id=$3', [name, email, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/check_subscriber ────────────────────────────────────────────────
router.get('/check_subscriber', async (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  try {
    const { rows } = await db.query('SELECT * FROM users WHERE phone = $1 LIMIT 1', [phone]);
    if (rows.length) res.json({ exists: true, verified: true });
    else res.json({ exists: false, verified: false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/check-subscription ──────────────────────────────────────────────
router.get('/check-subscription', async (req, res) => {
  const { phone, curator_id, genre_id } = req.query;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  const digits = phone.replace(/\D/g, '');
  const normalPhone = digits.length === 10 ? '+1' + digits
    : digits.length === 11 && digits.startsWith('1') ? '+' + digits
    : phone;
  try {
    const { rows: users } = await db.query(
      `SELECT id, taste_token FROM users WHERE phone=$1 LIMIT 1`, [normalPhone]
    );
    if (!users.length) return res.json({ subscribed: false });
    const userId     = users[0].id;
    const tasteToken = users[0].taste_token || null;

    let subscribed = false;
    if (curator_id) {
      const { rows } = await db.query(
        `SELECT id FROM subscriptions WHERE user_id=$1 AND curator_id=$2 AND is_active=TRUE LIMIT 1`,
        [userId, curator_id]
      );
      subscribed = rows.length > 0;
    } else if (genre_id) {
      const { rows } = await db.query(
        `SELECT id FROM subscriptions WHERE user_id=$1 AND genre_id=$2 AND is_active=TRUE LIMIT 1`,
        [userId, genre_id]
      );
      subscribed = rows.length > 0;
    }
    res.json({ subscribed, taste_token: tasteToken });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/playlist_links ───────────────────────────────────────────────────
router.get('/playlist_links', (req, res) => {
  res.json({ playlist_links: [] });
});

// ── GET /api/deliveries ───────────────────────────────────────────────────────
router.get('/deliveries', async (req, res) => {
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

module.exports = router;
