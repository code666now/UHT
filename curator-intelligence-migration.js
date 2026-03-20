// Curator Intelligence System — Database Migration
// Run with: node curator-intelligence-migration.js from ~/uht-app

require('dotenv').config();
const db = require('./db');

async function migrate() {
  console.log('Running Curator Intelligence migrations...\n');

  // 1. Ensure curators table has all needed columns (already exists, just add missing)
  await db.query(`
    ALTER TABLE curators
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()
  `);
  console.log('✓ curators table updated');

  // 2. Playlists table — themed weekly drops
  await db.query(`
    CREATE TABLE IF NOT EXISTS playlists (
      id          SERIAL PRIMARY KEY,
      curator_id  INT REFERENCES curators(id) ON DELETE SET NULL,
      theme       TEXT,
      week        INT NOT NULL DEFAULT 1,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log('✓ playlists table ready');

  // 3. Playlist songs — songs assigned to a playlist
  await db.query(`
    CREATE TABLE IF NOT EXISTS playlist_songs (
      id          SERIAL PRIMARY KEY,
      playlist_id INT REFERENCES playlists(id) ON DELETE CASCADE,
      song_id     INT REFERENCES songs(id) ON DELETE CASCADE,
      curator_note TEXT,
      position    INT DEFAULT 1,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(playlist_id, song_id)
    )
  `);
  console.log('✓ playlist_songs table ready');

  // 4. Song votes — HIT or DENY only, IGNORE is never stored
  await db.query(`
    CREATE TYPE IF NOT EXISTS vote_type_enum AS ENUM ('hit', 'deny', 'ultra_hit')
  `).catch(() => console.log('  (vote_type_enum already exists)'));

  await db.query(`
    CREATE TABLE IF NOT EXISTS song_votes (
      id            SERIAL PRIMARY KEY,
      subscriber_id INT REFERENCES users(id) ON DELETE CASCADE,
      curator_id    INT REFERENCES curators(id) ON DELETE SET NULL,
      playlist_id   INT REFERENCES playlists(id) ON DELETE SET NULL,
      song_id       INT REFERENCES songs(id) ON DELETE CASCADE,
      vote_type     vote_type_enum NOT NULL,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(subscriber_id, song_id, playlist_id)
    )
  `);
  console.log('✓ song_votes table ready');

  // 5. Curator stats view — auto-updates on every query
  await db.query(`DROP VIEW IF EXISTS curator_stats`);
  await db.query(`
    CREATE VIEW curator_stats AS
    SELECT
      c.id                                                                AS curator_id,
      c.name                                                              AS curator_name,
      COUNT(CASE WHEN v.vote_type = 'hit'       THEN 1 END)              AS total_hits,
      COUNT(CASE WHEN v.vote_type = 'ultra_hit' THEN 1 END)              AS total_ultra_hits,
      COUNT(CASE WHEN v.vote_type = 'deny'      THEN 1 END)              AS total_denies,
      COUNT(v.id)                                                         AS total_votes,
      CASE
        WHEN COUNT(v.id) = 0 THEN NULL
        ELSE ROUND(
          (COUNT(CASE WHEN v.vote_type IN ('hit','ultra_hit') THEN 1 END))::NUMERIC
          / COUNT(v.id) * 100, 1
        )
      END                                                                 AS hit_rate,
      COUNT(DISTINCT v.playlist_id)                                       AS playlists_sent,
      MAX(v.created_at)                                                   AS last_updated
    FROM curators c
    LEFT JOIN song_votes v ON v.curator_id = c.id
    GROUP BY c.id, c.name
  `);
  console.log('✓ curator_stats view created');

  console.log('\n✅ All migrations complete!');
  process.exit(0);
}

migrate().catch(e => {
  console.error('Migration failed:', e.message);
  process.exit(1);
});
