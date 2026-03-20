const fs = require('fs');

// ── server.js: vote buttons + vote() function ──
let s = fs.readFileSync('server.js', 'utf8');

s = s.replace(
  `    <button class="vote-btn vote-hit" id="vHit" onclick="vote('hit')">🔥 Hit</button>\n    <button class="vote-btn vote-denied" id="vDenied" onclick="vote('denied')">💀 Denied</button>`,
  `    <button class="vote-btn vote-hit" id="vMega" onclick="vote('mega_hit')">🔥 Mega Hit</button>\n    <button class="vote-btn vote-hit" id="vHit" onclick="vote('hit')">🎯 Hit</button>\n    <button class="vote-btn vote-denied" id="vDenied" onclick="vote('deny')">💀 Denied</button>`
);

s = s.replace(
  `  document.getElementById('vHit').disabled=true;\n  document.getElementById('vDenied').disabled=true;\n  document.getElementById('voteMsg').textContent=type==='hit'?'🔥 Hit recorded!':'💀 Denied recorded!';`,
  `  document.getElementById('vMega').disabled=true;\n  document.getElementById('vHit').disabled=true;\n  document.getElementById('vDenied').disabled=true;\n  var msg=type==='mega_hit'?'🔥 Mega Hit recorded!':type==='hit'?'🎯 Hit recorded!':'💀 Denied recorded!';\n  document.getElementById('voteMsg').textContent=msg;`
);

fs.writeFileSync('server.js', s);
console.log('✅ server.js vote buttons patched');

// ── uht-radio.html: ultra_hits → mega_hits ──
let r = fs.readFileSync('public/uht-radio.html', 'utf8');
r = r.replaceAll('ultra_hits', 'mega_hits');
fs.writeFileSync('public/uht-radio.html', r);
console.log('✅ uht-radio.html ultra_hits → mega_hits patched');
