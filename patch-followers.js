const fs = require('fs');
let s = fs.readFileSync('server.js', 'utf8');

// Add followers count to curators-admin query
s = s.replace(
  `SELECT c.*,
        COUNT(DISTINCT s.id)  AS song_count,
        COUNT(DISTINCT sb.id) AS sub_count
      FROM curators c
      LEFT JOIN songs s ON s.curator_id = c.id
      LEFT JOIN subscriptions sb ON sb.curator_id = c.id
      GROUP BY c.id ORDER BY c.name`,
  `SELECT c.*,
        COUNT(DISTINCT s.id)  AS song_count,
        COUNT(DISTINCT sb.id) AS sub_count,
        COUNT(DISTINCT f.id)  AS follower_count
      FROM curators c
      LEFT JOIN songs s ON s.curator_id = c.id
      LEFT JOIN subscriptions sb ON sb.curator_id = c.id
      LEFT JOIN follows f ON f.curator_id = c.id
      GROUP BY c.id ORDER BY c.name`
);

fs.writeFileSync('server.js', s);
console.log('Done! follower_count added to curators-admin.');
