const fs = require('fs');
let s = fs.readFileSync('server.js', 'utf8');

// Replace the header block to add:
// 1. "Curator of the Month — March 2026" above the name
// 2. "🌙 Rising Curator" tier badge below the name
s = s.replace(
  `  <div class="header">
    <div class="c-label">Curator Pick</div>
    <h1 class="c-name">\${curator.name}</h1>
    \${curator.bio ? \`<div class="c-bio">\${curator.bio}</div>\` : ''}`,
  `  <div class="header">
    <div class="c-label">Curator of the Month — March 2026</div>
    <h1 class="c-name">\${curator.name}</h1>
    <div style="font-size:11px;letter-spacing:.2em;opacity:.5;margin-top:6px;text-transform:uppercase">🌙 Rising Curator</div>
    \${curator.bio ? \`<div class="c-bio">\${curator.bio}</div>\` : ''}`
);

fs.writeFileSync('server.js', s);
console.log('✅ Curator header updated');
