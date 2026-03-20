const fs = require('fs');
let s = fs.readFileSync('server.js', 'utf8');

const patchRoute = `
// ── PATCH /api/curator-submissions/:id ───────────────────────────────────────
app.patch('/api/curator-submissions/:id', async (req, res) => {
  const { title, artist, spotify_url, youtube_url, theme, week_number, curator_note } = req.body;
  if (!title || !artist) return res.status(400).json({ error: 'title and artist required.' });
  try {
    const { rows } = await db.query(
      \`UPDATE curator_submissions SET
        title=$1, artist=$2, spotify_url=$3, youtube_url=$4,
        theme=$5, week_number=$6, curator_note=$7
       WHERE id=$8 RETURNING *\`,
      [title, artist, spotify_url||null, youtube_url||null, theme||null, week_number||1, curator_note||null, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found.' });
    res.json({ submission: rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
`;

// Insert before DELETE route
s = s.replace(
  '// ── DELETE /api/curator-submissions/:id',
  patchRoute + '\n// ── DELETE /api/curator-submissions/:id'
);

fs.writeFileSync('server.js', s);
console.log('Done! PATCH route added for curator-submissions.');
