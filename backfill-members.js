// ── UHT Member Backfill ───────────────────────────────────────────────────────
// Safe one-time script. Run with: node backfill-members.js
// - Assigns sequential member_number to users missing one (by created_at ASC)
// - Sets member_tier = 'FIRST 100' for member_number <= 100
// - Generates taste_token for users missing one (32-byte hex)
// - Generates share_slug for users missing one (zero-padded member number)
// - NEVER overwrites existing values

require('dotenv').config();
const db     = require('./db');
const crypto = require('crypto');

async function run() {
  console.log('\n[Backfill] Starting member identity backfill...\n');

  // 0. Ensure columns exist (safe — IF NOT EXISTS)
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS member_number INTEGER`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS member_tier TEXT`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS taste_token TEXT`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS share_slug TEXT`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMP`);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_member_number_uidx ON users(member_number) WHERE member_number IS NOT NULL`);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_taste_token_uidx  ON users(taste_token)  WHERE taste_token  IS NOT NULL`);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_share_slug_uidx   ON users(share_slug)   WHERE share_slug   IS NOT NULL`);
  console.log('[Backfill] Columns confirmed.\n');

  // 1. Get all users sorted by created_at ascending
  const { rows: users } = await db.query(
    `SELECT id, phone, name, member_number, taste_token, share_slug, member_tier
     FROM users ORDER BY created_at ASC, id ASC`
  );

  console.log(`[Backfill] Found ${users.length} users.\n`);

  // 2. Find the current max member_number already assigned
  const { rows: maxRow } = await db.query(
    `SELECT COALESCE(MAX(member_number), 0) AS max_num FROM users`
  );
  let nextMemberNum = parseInt(maxRow[0].max_num) + 1;

  let assigned = 0, tokenized = 0, slugged = 0, tiered = 0;

  for (const user of users) {
    const updates = {};

    // Assign member_number if missing
    if (!user.member_number) {
      updates.member_number = nextMemberNum++;
      assigned++;
    }

    const effectiveNum = user.member_number || updates.member_number;

    // Set member_tier if applicable and not already set
    if (!user.member_tier && effectiveNum <= 100) {
      updates.member_tier = 'FIRST 100';
      tiered++;
    }

    // Generate taste_token if missing
    if (!user.taste_token) {
      updates.taste_token = crypto.randomBytes(32).toString('hex');
      tokenized++;
    }

    // Generate share_slug if missing
    if (!user.share_slug) {
      updates.share_slug = String(effectiveNum).padStart(3, '0');
      slugged++;
    }

    if (Object.keys(updates).length === 0) {
      console.log(`  [skip] User #${user.id} (${user.name || user.phone.slice(0,7)}***) — already complete`);
      continue;
    }

    // Build UPDATE query from only the fields that need updating
    const setClauses = Object.keys(updates).map((k, i) => `${k}=$${i + 2}`).join(', ');
    const values = [user.id, ...Object.values(updates)];
    await db.query(`UPDATE users SET ${setClauses} WHERE id=$1`, values);

    console.log(`  [updated] User #${user.id} (${user.name || user.phone.slice(0,7)}***):`, updates);
  }

  console.log(`\n[Backfill] Done.`);
  console.log(`  member_number assigned : ${assigned}`);
  console.log(`  taste_token generated  : ${tokenized}`);
  console.log(`  share_slug generated   : ${slugged}`);
  console.log(`  member_tier set        : ${tiered}\n`);

  await db.end();
  process.exit(0);
}

run().catch(e => {
  console.error('[Backfill] Fatal error:', e.message);
  process.exit(1);
});
