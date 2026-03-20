const fs = require('fs');
let s = fs.readFileSync('server.js', 'utf8');

const oldHit = `.vote-hit{background:rgba(255,100,0,0.15);border:1px solid rgba(255,100,0,0.3);color:rgba(255,150,80,0.9)}`;
const newHit = `.vote-hit{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.15);color:rgba(255,255,255,.8)}.vote-hit:hover,.vote-hit:active{background:rgba(200,0,0,.3);border-color:rgba(200,0,0,.6);color:#ff4444}`;

const oldDenied = `.vote-denied{background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);color:rgba(255,255,255,0.5)}`;
const newDenied = `.vote-denied{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.15);color:rgba(255,255,255,.8)}.vote-denied:hover,.vote-denied:active{background:rgba(200,0,0,.3);border-color:rgba(200,0,0,.6);color:#ff4444}`;

// Also fix curator drop page which has :active but missing :hover
const oldHitActive = `.vote-hit:active{background:rgba(200,0,0,.3);border-color:rgba(200,0,0,.6);color:#ff4444}`;
const newHitActive = `.vote-hit:hover,.vote-hit:active{background:rgba(200,0,0,.3);border-color:rgba(200,0,0,.6);color:#ff4444}`;
const oldDeniedActive = `.vote-denied:active{background:rgba(200,0,0,.3);border-color:rgba(200,0,0,.6);color:#ff4444}`;
const newDeniedActive = `.vote-denied:hover,.vote-denied:active{background:rgba(200,0,0,.3);border-color:rgba(200,0,0,.6);color:#ff4444}`;

s = s.replaceAll(oldHit, newHit);
s = s.replaceAll(oldDenied, newDenied);
s = s.replaceAll(oldHitActive, newHitActive);
s = s.replaceAll(oldDeniedActive, newDeniedActive);

fs.writeFileSync('server.js', s);
console.log('✅ All vote button CSS updated');
