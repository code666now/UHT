const fs = require('fs');
let s = fs.readFileSync('server.js', 'utf8');

const curatorDropRoute = `
// ── GET /drop/curator/:slug ──────────────────────────────────────────────────
app.get('/drop/curator/:slug', async (req, res) => {
  const slug = req.params.slug.toLowerCase();
  try {
    const curatorRes = await db.query(
      \`SELECT * FROM curators WHERE LOWER(REPLACE(name,' ','-'))=$1 LIMIT 1\`,
      [slug]
    );
    if (!curatorRes.rows.length) return res.status(404).send('<h1>Curator not found.</h1>');
    const curator = curatorRes.rows[0];

    const subRes = await db.query(
      \`SELECT * FROM curator_submissions WHERE curator_id=$1
       ORDER BY week_number DESC, submitted_at DESC LIMIT 1\`,
      [curator.id]
    );
    if (!subRes.rows.length) return res.status(404).send('<h1>No picks yet.</h1>');
    const d = subRes.rows[0];

    const ytId = d.youtube_url ? (d.youtube_url.match(/(?:v=|youtu\\.be\\/)([^&?/]+)/) || [])[1] : null;
    const pageUrl = '/drop/curator/' + slug;
    const firstName = curator.name.split(' ')[0];

    res.send(\`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>\${curator.name}'s Pick — UHT</title>
<style>
html,body{background:#000;margin:0;padding:0;overflow-x:hidden;font-family:Georgia,"Times New Roman",serif;color:#f3f1ea}
.wrap{min-height:100svh;background:#000;display:flex;flex-direction:column;padding:0 0 60px}
.hero{position:relative;width:100%;aspect-ratio:4/3;max-height:360px;overflow:hidden;background:#111}
.hero img{width:100%;height:100%;object-fit:cover;display:block}
.hero-grad{position:absolute;inset:0;background:linear-gradient(to bottom,transparent 30%,#000 100%)}
.header{text-align:center;padding:0 20px;margin-top:16px}
.c-label{font-size:10px;letter-spacing:.3em;opacity:.4;text-transform:uppercase;margin-bottom:8px}
.c-name{margin:0;font-size:32px;font-weight:600;letter-spacing:3px;text-transform:uppercase}
.c-bio{font-size:14px;opacity:.5;margin-top:6px;font-style:italic}
.pick-label{font-size:10px;letter-spacing:.3em;opacity:.4;text-transform:uppercase;margin:24px 0 10px}
.song-title{font-size:28px;font-weight:600;margin:0 0 4px}
.song-artist{font-size:17px;opacity:.6;margin:0}
.song-note{font-size:16px;font-style:italic;opacity:.6;margin-top:12px;padding:0 10px}
.press-play{font-size:10px;letter-spacing:.3em;opacity:.45;text-transform:uppercase;margin-top:10px}
.video-wrap{position:relative;width:100%;aspect-ratio:16/9;margin-top:16px}
#player{width:100%;height:100%}
.end-screen{position:absolute;inset:0;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;text-align:center;padding:20px;opacity:0;pointer-events:none;transition:opacity .4s}
.end-screen.show{opacity:1;pointer-events:all}
.end-screen p{margin:0;font-size:18px;line-height:1.7}
.vote-row{display:flex;gap:12px;justify-content:center;margin-top:24px;padding:0 20px}
.vote-btn{flex:1;max-width:160px;padding:14px;border-radius:12px;border:none;font-family:Georgia,serif;font-size:16px;cursor:pointer;transition:all .2s}
.vote-hit{background:rgba(255,100,0,.12);border:1px solid rgba(255,100,0,.3);color:rgba(255,150,80,.9)}
.vote-denied{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);color:rgba(255,255,255,.5)}
.vote-btn:disabled{opacity:.35;cursor:default}
.vote-msg{text-align:center;margin-top:10px;font-size:13px;opacity:.45;min-height:18px;letter-spacing:.05em}
.share-wrap{display:flex;justify-content:center;margin-top:28px}
.share-btn{background:rgba(255,255,255,.04);color:#f3f1ea;border:1px solid rgba(243,241,234,.2);padding:11px 22px;border-radius:999px;font-size:11px;letter-spacing:.18em;text-transform:uppercase;cursor:pointer;transition:all .2s;font-family:inherit}
.share-btn:hover{background:#f3f1ea;color:#000}
.join-cta{display:none;text-align:center;margin-top:36px;padding:0 20px;border-top:1px solid rgba(255,255,255,.06);padding-top:32px}
.join-cta p{font-size:12px;opacity:.45;letter-spacing:.15em;text-transform:uppercase;margin:0 0 14px}
.join-btn{display:inline-block;padding:13px 30px;border-radius:999px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.18);color:#f3f1ea;text-decoration:none;font-size:12px;letter-spacing:.15em;text-transform:uppercase;transition:all .2s}
.join-btn:hover{background:#f3f1ea;color:#000}
.no-video{padding:40px 20px;text-align:center}
.sp-btn{display:inline-block;margin-top:14px;padding:12px 28px;border-radius:999px;background:#1DB954;color:#fff;text-decoration:none;font-size:15px}
@media(min-width:768px){
  .wrap{align-items:center}
  .hero{max-height:500px;aspect-ratio:16/7;width:100%}
  .song-title{font-size:36px}
  .video-wrap{max-width:1200px;width:100%}
}
</style>
</head>
<body>
<div class="wrap">

  \${curator.image_url ? \`<div class="hero"><img src="\${curator.image_url}" alt="\${curator.name}"><div class="hero-grad"></div></div>\` : ''}

  <div class="header">
    <div class="c-label">Curator Pick</div>
    <h1 class="c-name">\${curator.name}</h1>
    \${curator.bio ? \`<div class="c-bio">\${curator.bio}</div>\` : ''}
    <div class="pick-label">\${d.theme ? d.theme.toUpperCase() + ' · ' : ''}Week \${d.week_number}</div>
    <div class="song-title">\${d.title}</div>
    <div class="song-artist">\${d.artist}</div>
    \${d.curator_note ? \`<div class="song-note">"\${d.curator_note}"</div>\` : ''}
    \${ytId ? \`<div class="press-play" id="pressPlay">Press Play.</div>\` : ''}
  </div>

  \${ytId ? \`<div class="video-wrap"><div id="player"></div><div class="end-screen" id="endScreen"><p>This one's his pick.<br><br>Follow \${firstName} — he drops a new one every Monday.</p></div></div>\`
    : \`<div class="no-video">\${d.spotify_url ? \`<a class="sp-btn" href="\${d.spotify_url}" target="_blank">🎵 Play on Spotify</a>\` : '<p style="opacity:.35">No playback source available.</p>'}</div>\`}

  <div class="vote-row">
    <button class="vote-btn vote-hit" id="vHit" onclick="vote('hit')">🔥 Hit</button>
    <button class="vote-btn vote-denied" id="vDenied" onclick="vote('denied')">💀 Denied</button>
  </div>
  <div class="vote-msg" id="voteMsg"></div>

  <div class="share-wrap">
    <button class="share-btn" id="shareBtn" onclick="sharePick()">Share this pick</button>
  </div>

  <div class="join-cta" id="joinCta">
    <p>Get \${firstName}'s pick every Monday</p>
    <a class="join-btn" href="/uht-radio.html">Follow \${firstName} →</a>
  </div>

</div>

\${ytId ? \`<script src="https://www.youtube.com/iframe_api"></script>
<script>
var player,shown=false,started=false;
function onYouTubeIframeAPIReady(){
  player=new YT.Player('player',{videoId:'\${ytId}',playerVars:{rel:0,modestbranding:1,playsinline:1},events:{onStateChange:onChange}});
}
function onChange(e){
  if(e.data===1){var p=document.getElementById('pressPlay');if(p)p.style.opacity='0';if(!started){started=true;setInterval(check,500);}}
}
function check(){if(!player||shown)return;var c=player.getCurrentTime(),d=player.getDuration();if(d&&d-c<=10){document.getElementById('endScreen').classList.add('show');shown=true;}}
</script>\` : ''}

<script>
if(new URLSearchParams(window.location.search).get('ref')==='share'){
  document.getElementById('joinCta').style.display='block';
}
function vote(type){
  document.getElementById('vHit').disabled=true;
  document.getElementById('vDenied').disabled=true;
  document.getElementById('voteMsg').textContent=type==='hit'?'🔥 Hit recorded!':'💀 Denied recorded!';
  fetch('/api/genre-vote',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({submission_id:\${d.id},vote:type,type:'curator'})}).catch(()=>{});
}
function sharePick(){
  var url=window.location.origin+'\${pageUrl}?ref=share';
  var text='\${curator.name}\\'s pick: \${d.title} by \${d.artist}\\nListen & vote: ';
  if(navigator.share){navigator.share({title:'UHT',text:text,url:url}).catch(()=>{});return;}
  if(navigator.clipboard&&window.isSecureContext){
    navigator.clipboard.writeText(text+url).then(function(){var b=document.getElementById('shareBtn');var o=b.innerText;b.innerText='Copied!';setTimeout(function(){b.innerText=o;},1500);});
    return;
  }
  window.location.href='sms:?&body='+encodeURIComponent(text+url);
}
</script>
</body>
</html>\`);
  } catch(e) { res.status(500).send('<h1>Error: '+e.message+'</h1>'); }
});
`;

s = s.replace(
  '// ── GET /drop/:genre',
  curatorDropRoute + '\n// ── GET /drop/:genre'
);

fs.writeFileSync('server.js', s);
console.log('Done! /drop/curator/:slug added.');
