// scheduler.js
// Runs the Friday drop — sends each active subscriber their genre's
// next unplayed song via Twilio SMS.
//
// Two ways to trigger:
//   1. Automatic: runs every Friday at 10am (uses node-cron)
//   2. Manual:    POST /api/drop/send  (from the admin dashboard)

require('dotenv').config();
const db     = require('./db');
const twilio = require('twilio');

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ── Concurrent execution guard ────────────────────────────────────────────────
// Prevents the cron and the manual admin button from running simultaneously,
// which would cause duplicate Twilio sends to every subscriber.
let _dropRunning = false;

// ── Core drop function ────────────────────────────────────────────────────────
// Picks the newest unplayed song for each genre and sends it
// to every active genre subscriber. Curator drops are handled by curator-scheduler.js.
async function runWeeklyDrop() {
  if (_dropRunning) {
    console.log('[Drop] Already running — skipping duplicate invocation.');
    return { sent: 0, skipped: 0, errors: 0, alreadyRunning: true };
  }
  _dropRunning = true;

  console.log(`\n[Drop] Starting weekly drop at ${new Date().toISOString()}`);

  try {
    // Get all active GENRE subscriptions only — curator subs are handled by curator-scheduler.js Monday cron
    const { rows: subs } = await db.query(`
      SELECT s.id AS sub_id, s.user_id, s.genre_id, u.phone, u.taste_token
      FROM subscriptions s
      JOIN users u ON u.id = s.user_id
      WHERE s.is_active = TRUE
        AND s.genre_id IS NOT NULL
        AND s.curator_id IS NULL
    `);

    if (!subs.length) {
      console.log('[Drop] No active subscribers. Skipping.');
      return { sent: 0, skipped: 0, errors: 0 };
    }

    let sent = 0, skipped = 0, errors = 0;

    for (const sub of subs) {
      try {
        // Find the NEWEST song for this sub's genre that hasn't been delivered yet.
        // Newest-first ensures subscribers always get the current week — never
        // catches up on old weeks and causes double texts for new subscribers.
        const { rows: songs } = await db.query(`
          SELECT s.*, g.name AS genre_name
          FROM songs s
          LEFT JOIN genres g ON g.id = s.genre_id
          WHERE s.genre_id = $1
            AND s.id NOT IN (
              SELECT song_id FROM deliveries WHERE user_id = $2
            )
          ORDER BY s.created_at DESC
          LIMIT 1
        `, [sub.genre_id, sub.user_id]);

        if (!songs.length) {
          console.log(`[Drop] No new songs for sub #${sub.sub_id} (user ${sub.phone}). Skipping.`);
          skipped++;
          continue;
        }

        const song = songs[0];

        // Build the SMS message (personalized with taste_token if available)
        const msg = buildDropMessage(song, sub.taste_token);

        // Send via Twilio
        await client.messages.create({
          from: process.env.TWILIO_FROM || process.env.TWILIO_PHONE_NUMBER,
          to:   sub.phone,
          body: msg,
        });

        // Record the delivery — ON CONFLICT DO NOTHING ensures a double-run
        // never causes a DB error even if Twilio already sent.
        await db.query(
          `INSERT INTO deliveries (user_id, song_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [sub.user_id, song.id]
        );

        console.log(`[Drop] ✓ Sent "${song.title}" → ${sub.phone}`);
        sent++;

      } catch (err) {
        console.error(`[Drop] ✗ Error for sub #${sub.sub_id}: ${err.message}`);
        errors++;
      }
    }

    console.log(`[Drop] Done. Sent: ${sent} | Skipped: ${skipped} | Errors: ${errors}\n`);
    return { sent, skipped, errors };

  } finally {
    _dropRunning = false;
  }
}

// ── Message builder ───────────────────────────────────────────────────────────
function buildDropMessage(song, tasteToken) {
  const base = process.env.BASE_URL || '';
  const target = `/drop/${(song.genre_name || '').toLowerCase().replace(/\s+/g, '-')}`;
  const tokenParam = tasteToken ? `?t=${tasteToken}` : '';
  const link = base ? `${base}${target}${tokenParam}` : (song.url || '');

  const genre = song.genre_name || '';
  let msg = `Undeniable ${genre} Hit of the Week\n\n`;
  msg += `Vote HIT or DENIED: ${link}`;
  return msg;
}

// ── Schedule: every Friday at 8:00am PT ──────────────────────────────────────
let cron;
try {
  cron = require('node-cron');
  cron.schedule('0 8 * * 5', async () => {
    console.log('[Scheduler] Friday 8am PT — firing weekly genre drop.');
    runWeeklyDrop().catch(err => console.error('[Scheduler] Drop failed:', err.message));
    // NOTE: curator intro blast is triggered MANUALLY via POST /api/curator-intro/send
    // from the admin dashboard on week-1 Friday only. It is NOT auto-fired here
    // to prevent blasting genre subscribers every single Friday.
  }, { scheduled: true, timezone: 'America/Los_Angeles' });
  console.log('[Scheduler] Friday genre drop scheduled for 8:00am PT every week.');
} catch (e) {
  console.log('[Scheduler] node-cron not installed — manual drops only via POST /api/drop/send');
}

module.exports = { runWeeklyDrop, buildDropMessage };
