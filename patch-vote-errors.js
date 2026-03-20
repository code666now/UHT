const fs = require('fs');
let s = fs.readFileSync('server.js', 'utf8');

// Fix 1: curator drop vote() - inline fetch on line 750
// Changes silent .catch(()=>{}) to visible console.error
s = s.replace(
  `fetch('/api/genre-vote',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({submission_id:\${d.id},vote:type,type:'curator'})}).catch(()=>{});`,
  `fetch('/api/genre-vote',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({submission_id:\${d.id},vote:type,type:'curator'})})
    .then(function(r){if(!r.ok)r.json().then(function(e){console.error('[vote error]',e);});})
    .catch(function(e){console.error('[vote network error]',e);});`
);

// Fix 2: all 4 castVote blocks - multiline fetch
// Same change: silent catch → visible console.error
s = s.replaceAll(
  `  fetch('/api/genre-vote', {\n    method:'POST',\n    headers:{'Content-Type':'application/json'},\n    body:JSON.stringify({submission_id:\${d.id}, vote:type})\n  }).catch(()=>{});`,
  `  fetch('/api/genre-vote', {\n    method:'POST',\n    headers:{'Content-Type':'application/json'},\n    body:JSON.stringify({submission_id:\${d.id}, vote:type})\n  }).then(function(r){if(!r.ok)r.json().then(function(e){console.error('[vote error]',e);});})
    .catch(function(e){console.error('[vote network error]',e);});`
);

fs.writeFileSync('server.js', s);
console.log('✅ Silent vote failures replaced with visible console errors');
