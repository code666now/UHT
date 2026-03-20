const fs = require('fs');
let s = fs.readFileSync('server.js', 'utf8');

const route = `
// ── POST /api/genre-vote (temporary: log only, no DB write) ──
app.post('/api/genre-vote', async (req, res) => {
  const { submission_id, vote } = req.body;
  console.log('[genre-vote]', { submission_id, vote });
  if (!submission_id || !vote) {
    return res.status(400).json({ error: 'submission_id and vote are required.' });
  }
  res.json({ ok: true });
});

`;

s = s.replace('app.listen(PORT,', route + 'app.listen(PORT,');
fs.writeFileSync('server.js', s);
console.log('✅ /api/genre-vote log-only route added');
