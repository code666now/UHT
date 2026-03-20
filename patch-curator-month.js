const fs = require('fs');
let s = fs.readFileSync('server.js', 'utf8');

s = s.replace(
  "const { name, bio, image_url, instagram } = req.body;",
  "const { name, bio, image_url, instagram, curator_month, monthly_theme } = req.body;"
);

s = s.replace(
  "`INSERT INTO curators (name, bio, image_url, instagram) VALUES ($1,$2,$3,$4) RETURNING *`, [name, bio || null, image_url || null, instagram || null]",
  "`INSERT INTO curators (name, bio, image_url, instagram, curator_month, monthly_theme) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [name, bio || null, image_url || null, instagram || null, curator_month || null, monthly_theme || null]"
);

fs.writeFileSync('server.js', s);
console.log('Done!');
