const fs = require('fs');
let s = fs.readFileSync('server.js', 'utf8');

// Map mega_hit → ultra_hit at DB write time in /api/vote
// This keeps the DB constraint intact while UI shows "Mega Hit"
s = s.replace(
  `], [subscriber_id, curator_id || null, playlist_id || null, song_id, vote_type]);`,
  `], [subscriber_id, curator_id || null, playlist_id || null, song_id, vote_type === 'mega_hit' ? 'ultra_hit' : vote_type]);`
);

fs.writeFileSync('server.js', s);
console.log('✅ mega_hit → ultra_hit mapping added at DB write');
