// ─────────────────────────────────────────────────────────────────────────────
// RUN THIS ONCE to patch server.js with Twilio Verify routes
// cd ~/uht-app && node add-verify-routes.js
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, 'server.js');
let s = fs.readFileSync(serverPath, 'utf8');

const newRoutes = `

// ── Twilio Verify: send OTP ───────────────────────────────────────────────────
app.post('/api/send_code', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  try {
    const client = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    await client.verify.v2
      .services(process.env.TWILIO_VERIFY_SID)
      .verifications.create({ to: phone, channel: 'sms' });
    res.json({ ok: true });
  } catch (err) {
    console.error('send_code error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Twilio Verify: verify OTP + subscribe ─────────────────────────────────────
app.post('/api/verify_code', async (req, res) => {
  const { phone, code, genre } = req.body;
  if (!phone || !code) return res.status(400).json({ error: 'phone and code required' });
  try {
    const client = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const check = await client.verify.v2
      .services(process.env.TWILIO_VERIFY_SID)
      .verificationChecks.create({ to: phone, code });

    if (check.status !== 'approved') {
      return res.status(400).json({ error: 'Invalid or expired code.' });
    }

    // Upsert user
    const { rows: [user] } = await db.query(
      \`INSERT INTO users (phone) VALUES ($1)
       ON CONFLICT (phone) DO UPDATE SET phone = EXCLUDED.phone
       RETURNING *\`,
      [phone]
    );

    // Subscribe to genre if provided
    if (genre) {
      const { rows: genres } = await db.query(
        'SELECT id FROM genres WHERE LOWER(name) = LOWER($1) LIMIT 1', [genre]
      );
      if (genres.length) {
        await db.query(
          \`INSERT INTO subscriptions (user_id, genre_id, is_active)
           VALUES ($1, $2, true)
           ON CONFLICT (user_id, genre_id) DO UPDATE SET is_active = true\`,
          [user.id, genres[0].id]
        );
      }
    }

    res.json({ ok: true, status: 'approved' });
  } catch (err) {
    console.error('verify_code error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Check if subscriber exists ────────────────────────────────────────────────
app.get('/api/check_subscriber', async (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  try {
    const { rows } = await db.query(
      'SELECT * FROM users WHERE phone = $1 LIMIT 1', [phone]
    );
    if (rows.length) {
      res.json({ exists: true, verified: true });
    } else {
      res.json({ exists: false, verified: false });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Playlist links (optional — return empty array by default) ─────────────────
app.get('/api/playlist_links', (req, res) => {
  res.json({ playlist_links: [] });
});
`;

// Append before the last line (or before server.listen)
if (s.includes('app.listen')) {
  s = s.replace(/app\.listen\(/, newRoutes + '\napp.listen(');
} else {
  s = s + newRoutes;
}

fs.writeFileSync(serverPath, s);
console.log('✅ Done! server.js patched with Twilio Verify routes.');
console.log('');
console.log('Next steps:');
console.log('1. Go to console.twilio.com → Verify → Services → Create new service called "UHT"');
console.log('2. Copy the Service SID (starts with VA...)');
console.log('3. Add to your .env: TWILIO_VERIFY_SID=VAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
console.log('4. Restart server: node server.js');
