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

// ── Core drop function ────────────────────────────────────────────────────────
// Picks the oldest unplayed song for each genre/curator and sends it
// to every active subscriber of that genre/curator.
async function runWeeklyDrop() {
  console.log(`\n[Drop] Starting weekly drop at ${new Date().toISOString()}`);

  // Get all active subscriptions with subscriber phone
  const { rows: subs } = await db.query(`
    SELECT s.id AS sub_id, s.user_id, s.genre_id, s.curator_id, u.phone
    FROM subscriptions s
    JOIN users u ON u.id = s.user_id
    WHERE s.is_active = TRUE
  `);

  if (!subs.length) {
    console.log('[Drop] No active subscribers. Skipping.');
    return { sent: 0, skipped: 0, errors: 0 };
  }

  let sent = 0, skipped = 0, errors = 0;

  for (const sub of subs) {
    try {
      // Find the oldest song for this sub's genre/curator that hasn't
      // been delivered to this user yet
      const { rows: songs } = await db.query(`
        SELECT s.*, g.name AS genre_name, c.name AS curator_name
        FROM songs s
        LEFT JOIN genres   g ON g.id = s.genre_id
        LEFT JOIN curators c ON c.id = s.curator_id
        WHERE
          (($1::int IS NOT NULL AND s.genre_id   = $1)
        OR ($2::int IS NOT NULL AND s.curator_id = $2))
        AND s.id NOT IN (
          SELECT song_id FROM deliveries WHERE user_id = $3
        )
        ORDER BY s.created_at ASC
        LIMIT 1
      `, [sub.genre_id, sub.curator_id, sub.user_id]);

      if (!songs.length) {
        console.log(`[Drop] No new songs for sub #${sub.sub_id} (user ${sub.phone}). Skipping.`);
        skipped++;
        continue;
      }

      const song = songs[0];

      // Build the SMS message
      const msg = buildDropMessage(song);

      // Send via Twilio
      await client.messages.create({
        from: process.env.TWILIO_FROM || process.env.TWILIO_PHONE_NUMBER,
        to:   sub.phone,
        body: msg,
      });

      // Record the delivery
      await db.query(
        `INSERT INTO deliveries (user_id, song_id) VALUES ($1, $2)`,
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
}

// ── Message builder ───────────────────────────────────────────────────────────
function buildDropMessage(song) {
  const base = process.env.BASE_URL || '';
  const target = song.curator_name
    ? `/drop/curator/${song.curator_name.toLowerCase().replace(/\s+/g, '-')}`
    : `/drop/${(song.genre_name || '').toLowerCase().replace(/\s+/g, '-')}`;
  const link = base ? `${base}${target}` : (song.url || '');

  const genre = song.genre_name || song.curator_name || '';
  let msg = `Undeniable ${genre} Hit of the Week\n\n`;
  msg += `"${song.title}" by ${song.artist}\n\n`;
  msg += `HIT or DENIED: ${link}`;
  return msg;
}

// ── Schedule: every Friday at 10:00am ─────────────────────────────────────────
let cron;
try {
  cron = require('node-cron');
  // Cron: minute hour day month weekday
  // 0 10 * * 5  =  10:00am every Friday
  cron.schedule('0 8 * * 5', async () => {
    console.log('[Scheduler] Friday 8am PT — firing weekly drop + curator intro blast!');
    runWeeklyDrop().catch(err => console.error('[Scheduler] Drop failed:', err.message));
    // Fire curator intro blast for all active curators this month
    try {
      const { runCuratorIntroBlast } = require('./curator-scheduler');
      const { rows } = await db.query(`SELECT id FROM curators WHERE curator_month IS NOT NULL ORDER BY id ASC LIMIT 1`);
      if (rows.length) {
        runCuratorIntroBlast(rows[0].id).catch(err => console.error('[Scheduler] Curator intro blast failed:', err.message));
        console.log(`[Scheduler] Curator intro blast fired for curator #${rows[0].id}`);
      }
    } catch(e) { console.error('[Scheduler] Curator intro blast error:', e.message); }
  }, { scheduled: true, timezone: 'America/Los_Angeles' });
  console.log('[Scheduler] Friday drop + curator intro scheduled for 8:00am PT every week.');
} catch (e) {
  console.log('[Scheduler] node-cron not installed — manual drops only via POST /api/drop/send');
}

module.exports = { runWeeklyDrop, buildDropMessage };
