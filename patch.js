const fs = require('fs');
let s = fs.readFileSync('server.js', 'utf8');

s = s.replace(
  "require('dotenv').config();",
  "require('dotenv').config();\nconst { runWeeklyDrop } = require('./scheduler');"
);

s = s.replace('app.listen(PORT', `
app.post('/api/drop/send', async (req, res) => {
  try { const r = await runWeeklyDrop(); res.json({ ok: true, ...r }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/genres/seed', async (req, res) => {
  const genres = ['Rock', 'Punk', 'Pop', 'Country'];
  const created = [];
  for (const name of genres) {
    const { rows } = await db.query(
      'INSERT INTO genres (name) VALUES ($1) ON CONFLICT (name) DO NOTHING RETURNING *',
      [name]
    );
    if (rows.length) created.push(name);
  }
  res.json({ seeded: created });
});

app.listen(PORT`);

fs.writeFileSync('server.js', s);
console.log('Done! server.js patched.');
