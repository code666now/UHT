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

  // Get all active curator subscriptions (include curator photo + month for MMS)
  const { rows: subs } = await db.query(`
    SELECT
      s.id           AS sub_id,
      s.user_id,
      s.curator_id,
      u.phone,
      c.name         AS curator_name,
      c.image_url    AS curator_image,
      c.curator_month
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
      const { body, mediaUrl } = buildCuratorMessage(song, sub.curator_name, sub.curator_image, sub.curator_month);

      // Send via Twilio — MMS if curator has a photo, SMS otherwise
      const msgParams = {
        from: process.env.TWILIO_FROM || process.env.TWILIO_PHONE_NUMBER,
        to:   sub.phone,
        body,
      };
      if (mediaUrl) msgParams.mediaUrl = [mediaUrl];

      await client.messages.create(msgParams);

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
// Returns { body, mediaUrl } — mediaUrl is the curator photo for MMS (or null for SMS).
// Week 1: intro message ("Meet the curator"). Week 2-4: shorter drop notice.
function buildCuratorMessage(song, curatorName, curatorImage, curatorMonth) {
  const base = process.env.BASE_URL || '';
  const slug = curatorName.toLowerCase().replace(/\s+/g, '');
  const link = base ? `${base}/drop/curator/${slug}?ref=sms` : null;
  const firstName = curatorName.split(' ')[0];
  const month = curatorMonth || 'this month';
  const week = parseInt(song.week_number) || 1;

  let body;
  if (week === 1) {
    // Introduction drop
    body = `Curator of the Month · ${month}\n\n${firstName}'s picks are live. Vote now.`;
  } else {
    // Week 2, 3, 4 — short and direct
    body = `${month} · Week ${week}\n\n${firstName}'s new pick is live. Vote now.`;
  }

  if (link) body += `\n${link}`;

  return {
    body,
    mediaUrl: curatorImage || null,
  };
}

// ── Schedule: every Monday at 10:00am ────────────────────────────────────────
let cron;
try {
  cron = require('node-cron');
  // 0 10 * * 1  =  10:00am every Monday
  cron.schedule('0 8 * * 1', () => {
    console.log('[CuratorScheduler] Monday 8am PT — firing curator drop!');
    runCuratorDrop().catch(err => console.error('[CuratorScheduler] Drop failed:', err.message));
  }, { scheduled: true, timezone: 'America/Los_Angeles' });
  console.log('[CuratorScheduler] Monday curator drop scheduled for 8:00am PT every week.');
} catch (e) {
  console.log('[CuratorScheduler] node-cron not installed — manual drops only via POST /api/curator-drop/send');
}

// ── Curator intro blast ───────────────────────────────────────────────────────
// Sends a Friday intro MMS to all active genre subscribers introducing the
// current curator. Skips anyone already subscribed to that curator.
// Triggered manually via POST /api/curator-intro/send (admin button).
async function runCuratorIntroBlast(curatorId) {
  console.log(`\n[CuratorIntro] Starting intro blast at ${new Date().toISOString()}`);

  // Get the curator
  const { rows: curators } = await db.query(
    `SELECT * FROM curators WHERE id = $1 LIMIT 1`, [curatorId]
  );
  if (!curators.length) throw new Error(`Curator ${curatorId} not found`);
  const curator = curators[0];

  const firstName = curator.name.split(' ')[0];
  const month = curator.curator_month || 'this month';
  const base = process.env.BASE_URL || '';
  const slug = curator.name.toLowerCase().replace(/\s+/g, '');
  const link = base ? `${base}/curator/${slug}?ref=sms`.replace('https://','') : null;

  // Get all active genre subscribers not already subscribed to this curator
  const { rows: subs } = await db.query(`
    SELECT DISTINCT u.phone
    FROM subscriptions s
    JOIN users u ON u.id = s.user_id
    WHERE s.is_active = TRUE
      AND s.genre_id IS NOT NULL
      AND u.id NOT IN (
        SELECT s2.user_id FROM subscriptions s2
        WHERE s2.curator_id = $1 AND s2.is_active = TRUE
      )
  `, [curatorId]);

  if (!subs.length) {
    console.log('[CuratorIntro] No genre subscribers to notify. Skipping.');
    return { sent: 0, skipped: 0, errors: 0 };
  }

  let body = `Meet ${curator.name}! Our founding 1st Curator of the Month - ${month}. His first pick drops Monday.\n${link || ''}`;

  let sent = 0, skipped = 0, errors = 0;

  for (const sub of subs) {
    try {
      const msgParams = {
        from: process.env.TWILIO_FROM || process.env.TWILIO_PHONE_NUMBER,
        to:   sub.phone,
        body,
      };
      if (curator.image_url) msgParams.mediaUrl = [curator.image_url];

      await client.messages.create(msgParams);
      console.log(`[CuratorIntro] ✓ Sent to ${sub.phone}`);
      sent++;
    } catch(err) {
      console.error(`[CuratorIntro] ✗ Error for ${sub.phone}:`, err.message);
      errors++;
    }
  }

  console.log(`[CuratorIntro] Done. Sent: ${sent} | Skipped: ${skipped} | Errors: ${errors}\n`);
  return { sent, skipped, errors };
}

module.exports = { runCuratorDrop, buildCuratorMessage, runCuratorIntroBlast };
