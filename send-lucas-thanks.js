// ── One-time: Founding Curator Thank-You SMS to Lucas Moon ───────────────────
// Run against production DB:
//   DATABASE_URL=<railway-url> node send-lucas-thanks.js
// Or locally if your .env points to prod:
//   node send-lucas-thanks.js

require('dotenv').config();
const db     = require('./db');
const twilio = require('twilio');

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

(async () => {
  // Find Lucas in users table (he subscribed to his own curator drop)
  const { rows: lucasRows } = await db.query(`
    SELECT u.id, u.name, u.phone, u.member_number, u.taste_token, u.share_slug
    FROM users u
    WHERE LOWER(u.name) LIKE '%lucas%'
    LIMIT 5
  `);

  if (!lucasRows.length) {
    // Fallback: find via curator subscription record
    const { rows: curatorRows } = await db.query(`SELECT id FROM curators WHERE LOWER(name) LIKE '%lucas%' LIMIT 1`);
    if (!curatorRows.length) {
      console.error('[Error] Lucas not found in curators table.');
      process.exit(1);
    }
    const curatorId = curatorRows[0].id;

    const { rows: subRows } = await db.query(`
      SELECT u.id, u.name, u.phone, u.member_number, u.taste_token, u.share_slug
      FROM subscriptions s
      JOIN users u ON u.id = s.user_id
      WHERE s.curator_id = $1 AND s.is_active = TRUE
      LIMIT 10
    `, [curatorId]);

    console.log('Curator subscribers (choose Lucas manually):', subRows);
    await db.end();
    process.exit(0);
  }

  const lucas = lucasRows[0];
  console.log('Found Lucas:', lucas);

  // Count total curator subscribers
  const { rows: curatorRows } = await db.query(`SELECT id FROM curators WHERE LOWER(name) LIKE '%lucas%' LIMIT 1`);
  const curatorId = curatorRows[0]?.id;

  let subCount = 0;
  if (curatorId) {
    const { rows: countRows } = await db.query(
      `SELECT COUNT(*) AS cnt FROM subscriptions WHERE curator_id=$1 AND is_active=TRUE`,
      [curatorId]
    );
    subCount = parseInt(countRows[0].cnt) || 0;
  }

  console.log(`Curator subscriber count: ${subCount}`);

  // Build warm personal message
  const base = process.env.BASE_URL || 'https://undeniablehits.com';
  const dropLink = `${base}/follow/curator/lucasmoon`.replace('https://', '');

  const firstName = lucas.name?.split(' ')[0] || 'Lucas';

  const listenerLine = subCount > 0
    ? `You have ${subCount} listener${subCount === 1 ? '' : 's'} following you as a curator so far!`
    : `You have listeners following you as a curator so far!`;

  const body = `${firstName}, thank you for being our founding curator of Undeniable Hits. ${listenerLine} Share this with a friend\n${dropLink}`;

  console.log('\n── Message preview ──');
  console.log(`To: ${lucas.phone}`);
  console.log(`Body:\n${body}`);
  console.log('────────────────────\n');

  const answer = process.argv.includes('--send');
  if (!answer) {
    console.log('Dry run. Pass --send to actually send.\n  node send-lucas-thanks.js --send');
    await db.end();
    process.exit(0);
  }

  const msg = await client.messages.create({
    from: process.env.TWILIO_FROM || process.env.TWILIO_PHONE_NUMBER,
    to:   lucas.phone,
    body,
  });

  console.log(`✓ Sent! SID: ${msg.sid}`);
  await db.end();
  process.exit(0);
})().catch(e => {
  console.error('[Fatal]', e.message);
  process.exit(1);
});
