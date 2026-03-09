require('dotenv').config();
const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const twilio = require('twilio');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

async function sendSMS(to, body) {
  return twilioClient.messages.create({ from: process.env.TWILIO_PHONE_NUMBER, to, body });
}

function buildVoteMenu(songs) {
  let menu = '🎵 UHT Weekly Hits! Vote for your fave:\n';
  songs.forEach((s, i) => { menu += `${i+1}. ${s.title} - ${s.artist}\n`; });
  menu += '\nReply 1, 2, 3, or 4 to vote!';
  return menu;
}

// SONGS
app.get('/songs', async (req, res) => {
  const r = await pool.query('SELECT * FROM songs ORDER BY created_at DESC');
  res.json(r.rows);
});
app.post('/songs', async (req, res) => {
  const { title, artist, genre, audio_url } = req.body;
  const r = await pool.query(
    'INSERT INTO songs (title,artist,genre,audio_url) VALUES ($1,$2,$3,$4) RETURNING *',
    [title, artist, genre, audio_url]
  );
  res.json(r.rows[0]);
});
app.put('/songs/:id', async (req, res) => {
  const { title, artist, genre, audio_url } = req.body;
  const r = await pool.query(
    'UPDATE songs SET title=$1,artist=$2,genre=$3,audio_url=$4 WHERE id=$5 RETURNING *',
    [title, artist, genre, audio_url, req.params.id]
  );
  if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
  res.json(r.rows[0]);
});
app.delete('/songs/:id', async (req, res) => {
  await pool.query('DELETE FROM votes WHERE song_id=$1', [req.params.id]);
  await pool.query('DELETE FROM songs WHERE id=$1', [req.params.id]);
  res.json({ success: true });
});

// PLAYLISTS
app.post('/playlists', async (req, res) => {
  const { week, song1, song2, song3, song4 } = req.body;
  const r = await pool.query(
    'INSERT INTO playlists (week,song1,song2,song3,song4) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [week, song1, song2, song3, song4]
  );
  res.json(r.rows[0]);
});
app.get('/playlists/current', async (req, res) => {
  const r = await pool.query(`
    SELECT p.*,
      s1.title AS song1_title, s1.artist AS song1_artist,
      s2.title AS song2_title, s2.artist AS song2_artist,
      s3.title AS song3_title, s3.artist AS song3_artist,
      s4.title AS song4_title, s4.artist AS song4_artist
    FROM playlists p
    LEFT JOIN songs s1 ON p.song1=s1.id LEFT JOIN songs s2 ON p.song2=s2.id
    LEFT JOIN songs s3 ON p.song3=s3.id LEFT JOIN songs s4 ON p.song4=s4.id
    ORDER BY p.week DESC LIMIT 1`);
  res.json(r.rows[0] || null);
});

// SUBSCRIBERS
app.get('/subscribers', async (req, res) => {
  const r = await pool.query('SELECT * FROM subscribers ORDER BY created_at DESC');
  res.json(r.rows);
});
app.delete('/subscribers/:id', async (req, res) => {
  await pool.query('DELETE FROM votes WHERE subscriber_id=$1', [req.params.id]);
  await pool.query('DELETE FROM subscribers WHERE id=$1', [req.params.id]);
  res.json({ success: true });
});

// VOTES
app.get('/votes/results', async (req, res) => {
  const r = await pool.query(`
    SELECT s.title, s.artist, COUNT(v.id) AS vote_count
    FROM votes v JOIN songs s ON v.song_id=s.id
    GROUP BY s.id,s.title,s.artist ORDER BY vote_count DESC`);
  res.json(r.rows);
});

// BROADCAST
app.post('/broadcast', async (req, res) => {
  const pl = await pool.query('SELECT * FROM playlists ORDER BY week DESC LIMIT 1');
  if (!pl.rows.length) return res.status(404).json({ error: 'No playlist' });
  const { song1, song2, song3, song4 } = pl.rows[0];
  const ids = [song1,song2,song3,song4].filter(Boolean);
  const songs = await pool.query('SELECT * FROM songs WHERE id=ANY($1)', [ids]);
  const menu = buildVoteMenu(songs.rows);
  const subs = await pool.query('SELECT * FROM subscribers WHERE verified=TRUE');
  const results = [];
  for (const sub of subs.rows) {
    try { await sendSMS(sub.phone, menu); results.push({ phone: sub.phone, status: 'sent' }); }
    catch(e) { results.push({ phone: sub.phone, status: 'failed', error: e.message }); }
  }
  res.json({ sent: results.length, results });
});

// TWILIO SMS WEBHOOK
app.post('/sms', async (req, res) => {
  const from = req.body.From;
  const body = req.body.Body?.trim().toLowerCase();
  const twiml = new twilio.twiml.MessagingResponse();

  if (body === 'join' || body === 'subscribe') {
    const ex = await pool.query('SELECT * FROM subscribers WHERE phone=$1', [from]);
    if (ex.rows.length) {
      twiml.message("You're already on UHT! 🎵 Reply STOP to unsubscribe.");
    } else {
      await pool.query('INSERT INTO subscribers (phone,verified) VALUES ($1,TRUE)', [from]);
      const pl = await pool.query('SELECT * FROM playlists ORDER BY week DESC LIMIT 1');
      if (pl.rows.length) {
        const ids = [pl.rows[0].song1,pl.rows[0].song2,pl.rows[0].song3,pl.rows[0].song4].filter(Boolean);
        const songs = await pool.query('SELECT * FROM songs WHERE id=ANY($1)', [ids]);
        twiml.message('Welcome to Undeniable Hit Theory! 🎶\n\n' + buildVoteMenu(songs.rows));
      } else {
        twiml.message("Welcome to Undeniable Hit Theory! 🎶 Stay tuned for this week's picks!");
      }
    }
  } else if (body === 'stop' || body === 'unsubscribe') {
    await pool.query('DELETE FROM subscribers WHERE phone=$1', [from]);
    twiml.message("Unsubscribed. Text JOIN to come back anytime! 👋");
  } else if (['1','2','3','4'].includes(body)) {
    const sub = await pool.query('SELECT * FROM subscribers WHERE phone=$1', [from]);
    if (!sub.rows.length) {
      twiml.message('Text JOIN first to subscribe and vote! 🎵');
    } else {
      const pl = await pool.query('SELECT * FROM playlists ORDER BY week DESC LIMIT 1');
      if (!pl.rows.length) {
        twiml.message('No active playlist right now. Check back soon!');
      } else {
        const songId = pl.rows[0][`song${body}`];
        if (!songId) {
          twiml.message(`No song #${body} this week. Reply 1–4!`);
        } else {
          const voted = await pool.query(
            `SELECT * FROM votes WHERE subscriber_id=$1 AND created_at>=date_trunc('week',NOW())`,
            [sub.rows[0].id]
          );
          if (voted.rows.length) {
            twiml.message('You already voted this week! 🗳️ Results drop Friday.');
          } else {
            await pool.query('INSERT INTO votes (subscriber_id,song_id,vote) VALUES ($1,$2,$3)',
              [sub.rows[0].id, songId, body]);
            const song = await pool.query('SELECT * FROM songs WHERE id=$1', [songId]);
            twiml.message(`🔥 Vote locked for "${song.rows[0].title}" by ${song.rows[0].artist}! Results Friday!`);
          }
        }
      }
    }
  } else {
    twiml.message("Hey! 👋 Text JOIN to subscribe to Undeniable Hit Theory!");
  }

  res.type('text/xml').send(twiml.toString());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🎵 UHT running → http://localhost:${PORT}\n`);
});
