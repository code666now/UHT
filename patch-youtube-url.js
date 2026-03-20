const fs = require('fs');
let s = fs.readFileSync('server.js', 'utf8');

// Add youtube_url to INSERT
s = s.replace(
  `INSERT INTO curator_submissions (curator_id, title, artist, spotify_url, theme, week_number, curator_note)`,
  `INSERT INTO curator_submissions (curator_id, title, artist, spotify_url, youtube_url, theme, week_number, curator_note)`
);

// Add youtube_url to VALUES
s = s.replace(
  /VALUES \(\$1,\s*\$2,\s*\$3,\s*\$4,\s*\$5,\s*\$6,\s*\$7\)/,
  `VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`
);

// Add youtube_url to destructuring
s = s.replace(
  `const { curator_id, title, artist, spotify_url, theme, week_number, curator_note } = req.body;`,
  `const { curator_id, title, artist, spotify_url, youtube_url, theme, week_number, curator_note } = req.body;`
);

// Add youtube_url to params array
s = s.replace(
  `[curator_id, title, artist, spotify_url || null, theme || null, week_number || 1, curator_note || null]`,
  `[curator_id, title, artist, spotify_url || null, youtube_url || null, theme || null, week_number || 1, curator_note || null]`
);

fs.writeFileSync('server.js', s);
console.log('Done! youtube_url added to curator-submissions route.');
