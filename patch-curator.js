const fs = require('fs');
let s = fs.readFileSync('server.js', 'utf8');

// Add image_url to curator insert
s = s.replace(
  "`INSERT INTO curators (name, bio) VALUES ($1,$2) RETURNING *`, [name, bio || null]",
  "`INSERT INTO curators (name, bio, image_url) VALUES ($1,$2,$3) RETURNING *`, [name, bio || null, image_url || null]"
);

// Add image_url to destructuring
s = s.replace(
  "const { name, bio } = req.body;\n  if (!name) return res.status(400).json({ error: 'name required.' });\n  try {\n    const { rows } = await db.query(\n      `INSERT INTO curators (name, bio) VALUES ($1,$2) RETURNING *`, [name, bio || null]",
  "const { name, bio, image_url } = req.body;\n  if (!name) return res.status(400).json({ error: 'name required.' });\n  try {\n    const { rows } = await db.query(\n      `INSERT INTO curators (name, bio, image_url) VALUES ($1,$2,$3) RETURNING *`, [name, bio || null, image_url || null]"
);

fs.writeFileSync('server.js', s);
console.log('Done! server.js patched for image_url.');
