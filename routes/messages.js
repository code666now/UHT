'use strict';
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const twilio  = require('twilio');

function getTwilioClient() {
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

// ── POST /api/messages/test ───────────────────────────────────────────────────
router.post('/test', async (req, res) => {
  const { to, message } = req.body;
  if (!to || !message) return res.status(400).json({ error: 'to and message required' });
  try {
    const msg = await getTwilioClient().messages.create({
      body: message,
      from: process.env.TWILIO_FROM,
      to,
    });
    res.json({ ok: true, sid: msg.sid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/messages/send (broadcast) ──────────────────────────────────────
router.post('/send', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  try {
    const { rows } = await db.query(
      `SELECT DISTINCT u.phone FROM subscriptions sb JOIN users u ON u.id = sb.user_id WHERE sb.is_active = true`
    );
    const client = getTwilioClient();
    const results = await Promise.allSettled(
      rows.map(async (row) => {
        const msg = await client.messages.create({
          body: message,
          from: process.env.TWILIO_FROM,
          to: row.phone,
        });
        await db.query(
          `INSERT INTO sms_log (to_phone, body, status) VALUES ($1, $2, $3)`,
          [row.phone, message, msg.status]
        );
        return msg.sid;
      })
    );
    const sent   = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;
    res.json({ ok: true, sent, failed });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/messages (recent broadcast log) ──────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT to_phone AS "to", body, status, sent_at FROM sms_log ORDER BY sent_at DESC LIMIT 100`
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
