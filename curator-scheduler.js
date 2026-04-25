// ── UHT Curator Scheduler ─────────────────────────────────────────────────────
// Sends Monday 10am curator drops to curator subscribers.
// Completely separate from the Friday genre drop in scheduler.js.

require('dotenv').config();
const db     = require('./db');
const twilio = require('twilio');

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ── Core curator drop function ────────────────────────────────────────────────
async function runCuratorDrop() {
  console.log(`\n[CuratorDrop] Starting Monday curator drop at ${new Date().toISOString()}`);

  // Get all active curator subscriptions
  const { rows: subs } = await db.query(`
    SELECT
      s.id        AS sub_id,
      s.user_id,
      s.curator_id,
      u.phone,
      c.name      AS curator_name
    FROM subscriptions s
    JOIN users    u ON u.id = s.user_id
    JOIN curators c ON c.id = s.curator_id
    WHERE s.is_active = TRUE
      AND s.curator_id IS NOT NULL
  `);

  if (!subs.length) {
    console.log('[CuratorDrop] No active curator subscribers. Skipping.');
    return { sent: 0, skipped: 0, errors: 0 };
  }

  let sent = 0, skipped = 0, errors = 0;

  for (const sub of subs) {
    try {
      // Find oldest unplayed song for this curator not yet delivered to this user
      const { rows: songs } = await db.query(`
        SELECT
          s.*,
          cs.theme,
          cs.curator_note,
          cs.week_number,
          cs.spotify_url
        FROM songs s
        LEFT JOIN curator_submissions cs ON cs.song_id = s.id AND cs.curator_id = $1
        WHERE s.curator_id = $1
          AND s.id NOT IN (
            SELECT song_id FROM deliveries WHERE user_id = $2
          )
        ORDER BY s.created_at ASC
        LIMIT 1
      `, [sub.curator_id, sub.user_id]);

      if (!songs.length) {
        console.log(`[CuratorDrop] No new songs for sub #${sub.sub_id} (${sub.phone}). Skipping.`);
        skipped++;
        continue;
      }

      const song = songs[0];
      const msg  = buildCuratorMessage(song, sub.curator_name);

      // Send via Twilio
      await client.messages.create({
        from: process.env.TWILIO_FROM || process.env.TWILIO_PHONE_NUMBER,
        to:   sub.phone,
        body: msg,
      });

      // Record delivery
      await db.query(
        `INSERT INTO deliveries (user_id, song_id) VALUES ($1, $2)`,
        [sub.user_id, song.id]
      );

      console.log(`[CuratorDrop] ✓ Sent "${song.title}" by ${sub.curator_name} → ${sub.phone}`);
      sent++;

    } catch (err) {
      console.error(`[CuratorDrop] ✗ Error for sub #${sub.sub_id}:`, err.message);
      errors++;
    }
  }

  console.log(`[CuratorDrop] Done. Sent: ${sent} | Skipped: ${skipped} | Errors: ${errors}\n`);
  return { sent, skipped, errors };
}

// ── Curator message builder ───────────────────────────────────────────────────
// Richer than genre drops — includes curator identity, theme, and personal note.
function buildCuratorMessage(song, curatorName) {
  let msg = `🎧 ${curatorName}'s pick this week:\n\n`;

  // Theme line if available
  if (song.theme) {
    msg += `Theme: ${song.theme}\n`;
  }

  msg += `"${song.title}" by ${song.artist}\n`;

  // Curator's personal note
  if (song.curator_note) {
    msg += `\n"${song.curator_note}"\n`;
  }

  // Spotify/listen link
  if (song.spotify_url || song.url) {
    msg += `\n🔗 ${song.spotify_url || song.url}\n`;
  }

  const base = process.env.BASE_URL || '';
  if (base) {
    const slug = curatorName.toLowerCase().replace(/\s+/g, '-');
    msg += `\n🗳 Vote: ${base}/drop/curator/${slug}?ref=sms`;
  } else if (song.spotify_url || song.url) {
    msg += `\n🔗 ${song.spotify_url || song.url}`;
  }
  msg += `\nReply STOP to unsubscribe`;

  return msg;
}

// ── Schedule: every Monday at 10:00am ────────────────────────────────────────
let cron;
try {
  cron = require('node-cron');
  // 0 10 * * 1  =  10:00am every Monday
  cron.schedule('0 10 * * 1', () => {
    console.log('[CuratorScheduler] Monday 10am ET — firing curator drop!');
    runCuratorDrop().catch(err => console.error('[CuratorScheduler] Drop failed:', err.message));
  }, { scheduled: true, timezone: 'America/New_York' });
  console.log('[CuratorScheduler] Monday curator drop scheduled for 10:00am every week.');
} catch (e) {
  console.log('[CuratorScheduler] node-cron not installed — manual drops only via POST /api/curator-drop/send');
}

module.exports = { runCuratorDrop, buildCuratorMessage };
