// SMS Log — Database Migration
// Run with: node sms-log-migration.js from ~/uht-app

require('dotenv').config();
const db = require('./db');

async function migrate() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS sms_log (
      id         SERIAL PRIMARY KEY,
      to_phone   TEXT NOT NULL,
      body       TEXT NOT NULL,
      status     TEXT,
      sent_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log('✓ sms_log table ready');
  await db.end();
}

migrate().catch(e => { console.error(e); process.exit(1); });
