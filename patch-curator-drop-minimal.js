const fs = require('fs');
let s = fs.readFileSync('server.js', 'utf8');

// Only update the header section - minimal change
const oldHeader = `  <div class="header">
    <div class="c-label">Curator Pick</div>
    <h1 class="c-name">\${curator.name}</h1>
    \${curator.bio ? \`<div class="c-bio">\${curator.bio}</div>\` : ''}
    <div class="pick-label">\${d.theme ? d.theme.toUpperCase() + ' · ' : ''}Week \${d.week_number}</div>
    <div class="song-title">\${d.title}</div>
    <div class="song-artist">\${d.artist}</div>
    \${d.curator_note ? \`<div class="song-note">"\${d.curator_note}"</div>\` : ''}
    \${ytId ? \`<div class="press-play" id="pressPlay">Press Play.</div>\` : ''}
  </div>`;

const newHeader = `  <div class="header">
    \${curator.curator_month ? \`<div class="c-label">Curator of the Month · \${curator.curator_month}</div>\` : '<div class="c-label">Curator Pick</div>'}
    <h1 class="c-name">\${curator.name}</h1>
    <div style="font-size:11px;letter-spacing:.2em;opacity:.45;text-transform:uppercase;margin-top:4px;margin-bottom:6px">🌙 Rising Curator</div>
    \${curator.bio ? \`<div class="c-bio">\${curator.bio}</div>\` : ''}
    \${curator.monthly_theme ? \`<div style="font-size:12px;letter-spacing:.2em;opacity:.5;text-transform:uppercase;margin-top:8px;margin-bottom:0">Theme: \${curator.monthly_theme}</div>\` : ''}
    <div class="pick-label" style="margin-top:20px">Week \${d.week_number} Pick</div>
    <div class="song-title">\${d.title}</div>
    <div class="song-artist">\${d.artist}</div>
    \${d.curator_note ? \`<div class="song-note">"\${d.curator_note}"</div>\` : ''}
    \${ytId ? \`<div class="press-play" id="pressPlay">Press Play.</div>\` : ''}
  </div>`;

// Also update vote row to add Mega Hit
const oldVoteRow = `  <div class="vote-row">
    <button class="vote-btn vote-hit" id="vHit" onclick="vote('hit')">🔥 Hit</button>
    <button class="vote-btn vote-denied" id="vDenied" onclick="vote('denied')">💀 Denied</button>
  </div>`;

const newVoteRow = `  <div class="vote-row" style="display:flex;gap:8px;justify-content:center;margin-top:24px;padding:0 20px;flex-wrap:wrap">
    <button class="vote-btn" style="flex:1;min-width:80px;max-width:130px;padding:12px 8px;border-radius:12px;border:1px solid rgba(255,100,0,.3);background:rgba(255,100,0,.12);color:rgba(255,150,80,.9);font-family:Georgia,serif;font-size:14px;cursor:pointer" id="vMega" onclick="vote('ultra_hit')">🔥 Mega Hit</button>
    <button class="vote-btn" style="flex:1;min-width:80px;max-width:130px;padding:12px 8px;border-radius:12px;border:1px solid rgba(255,200,0,.2);background:rgba(255,200,0,.08);color:rgba(255,210,80,.8);font-family:Georgia,serif;font-size:14px;cursor:pointer" id="vHit" onclick="vote('hit')">🎯 Hit</button>
    <button class="vote-btn" style="flex:1;min-width:80px;max-width:130px;padding:12px 8px;border-radius:12px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.05);color:rgba(255,255,255,.5);font-family:Georgia,serif;font-size:14px;cursor:pointer" id="vDenied" onclick="vote('denied')">💀 Denied</button>
  </div>`;

// Also add follow button after share button
const oldShareWrap = `  <div class="share-wrap">
    <button class="share-btn" id="shareBtn" onclick="sharePick()">Share this pick</button>
  </div>`;

const newShareWrap = `  <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:28px;padding:0 20px">
    <button class="share-btn" id="shareBtn" onclick="sharePick()">Share this pick</button>
    <button id="followBtn" onclick="toggleFollowInput()" style="background:rgba(255,255,255,.05);color:rgba(255,255,255,.7);border:1px solid rgba(255,255,255,.15);padding:11px 22px;border-radius:999px;font-size:11px;letter-spacing:.18em;text-transform:uppercase;cursor:pointer;font-family:inherit;transition:all .2s">+ Follow \${firstName}</button>
  </div>
  <div id="followInputWrap" style="display:none;padding:12px 20px 0;max-width:400px;margin:0 auto;width:100%">
    <div style="display:flex;gap:8px;align-items:center">
      <input type="tel" id="followPhone" placeholder="+1 (212) 555-1234" style="flex:1;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.18);border-radius:8px;padding:10px 14px;color:#fff;font-family:Georgia,serif;font-size:14px;outline:none" onkeydown="if(event.key==='Enter')confirmFollow()">
      <button onclick="confirmFollow()" style="padding:10px 16px;border-radius:8px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.18);color:#f3f1ea;font-family:Georgia,serif;font-size:14px;cursor:pointer;white-space:nowrap">✓ Follow</button>
    </div>
    <div style="font-size:12px;color:rgba(255,255,255,.3);margin-top:8px;line-height:1.7">📱 Monday drops · 🔔 Drop alerts · 🔥 Vote on every pick</div>
  </div>
  <div id="followingState" style="display:none;text-align:center;margin-top:12px;font-size:12px;color:rgba(100,220,120,.8);letter-spacing:.1em">✓ Following \${firstName} · Monday drops incoming</div>`;

// Also update vote JS to handle ultra_hit
const oldVoteJS = `function vote(type){
  document.getElementById('vHit').disabled=true;
  document.getElementById('vDenied').disabled=true;
  var msgs={'hit':'🔥 Hit recorded!','denied':'💀 Denied recorded!'};`;

const newVoteJS = `function toggleFollowInput(){
  var w=document.getElementById('followInputWrap'),b=document.getElementById('followBtn');
  if(w.style.display==='none'){w.style.display='block';b.style.display='none';document.getElementById('followPhone').focus();}
  else{w.style.display='none';b.style.display='inline-block';}
}
function confirmFollow(){
  var raw=document.getElementById('followPhone').value.trim();
  if(!raw)return;
  var p=raw.replace(/\\D/g,'');
  if(p.length===10)p='+1'+p;else if(p.length===11&&p[0]==='1')p='+'+p;else p='+'+p;
  localStorage.setItem('uht_phone',p);
  fetch('/api/follows',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:p,curator_id:${curator.id}})}).then(function(){
    document.getElementById('followInputWrap').style.display='none';
    document.getElementById('followBtn').style.display='none';
    document.getElementById('followingState').style.display='block';
  }).catch(function(){document.getElementById('followingState').style.display='block';});
}
var sp=localStorage.getItem('uht_phone');
if(sp){fetch('/api/follows/check?phone='+encodeURIComponent(sp)+'&curator_id=${curator.id}').then(function(r){return r.json();}).then(function(d){if(d.following){document.getElementById('followBtn').style.display='none';document.getElementById('followingState').style.display='block';}}).catch(()=>{});}
function vote(type){
  ['vMega','vHit','vDenied'].forEach(function(id){var el=document.getElementById(id);if(el)el.disabled=true;});
  var msgs={'ultra_hit':'🔥 Mega Hit recorded!','hit':'🎯 Hit recorded!','denied':'💀 Denied recorded!'};`;

if (!s.includes(oldHeader)) {
  console.log('ERROR: Could not find header to update. No changes made.');
  process.exit(1);
}

s = s.replace(oldHeader, newHeader);
s = s.replace(oldVoteRow, newVoteRow);
s = s.replace(oldShareWrap, newShareWrap);
s = s.replace(oldVoteJS, newVoteJS);

fs.writeFileSync('server.js', s);
console.log('Done! Header, votes, and follow button updated.');
