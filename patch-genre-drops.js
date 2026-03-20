const fs = require('fs');
let s = fs.readFileSync('server.js', 'utf8');

const routes = `
// ── GET /api/genre-submissions ───────────────────────────────────────────────
app.get('/api/genre-submissions', async (req, res) => {
  try {
    const { rows } = await db.query(
      \`SELECT * FROM genre_submissions ORDER BY drop_date DESC, created_at DESC\`
    );
    res.json({ submissions: rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/genre-submissions ──────────────────────────────────────────────
app.post('/api/genre-submissions', async (req, res) => {
  const { genre, week_title, title, artist, note, youtube_url, spotify_url, week_number, drop_date } = req.body;
  if (!genre || !title || !artist) return res.status(400).json({ error: 'genre, title and artist required.' });
  try {
    const { rows } = await db.query(
      \`INSERT INTO genre_submissions (genre, week_title, title, artist, note, youtube_url, spotify_url, week_number, drop_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *\`,
      [genre, week_title||null, title, artist, note||null, youtube_url||null, spotify_url||null, week_number||1, drop_date||null]
    );
    res.json({ submission: rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/genre-submissions/:id ────────────────────────────────────────
app.patch('/api/genre-submissions/:id', async (req, res) => {
  const { genre, week_title, title, artist, note, youtube_url, spotify_url, week_number, drop_date } = req.body;
  if (!title || !artist) return res.status(400).json({ error: 'title and artist required.' });
  try {
    const { rows } = await db.query(
      \`UPDATE genre_submissions SET genre=$1, week_title=$2, title=$3, artist=$4, note=$5,
       youtube_url=$6, spotify_url=$7, week_number=$8, drop_date=$9 WHERE id=$10 RETURNING *\`,
      [genre, week_title||null, title, artist, note||null, youtube_url||null, spotify_url||null, week_number||1, drop_date||null, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found.' });
    res.json({ submission: rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/genre-submissions/:id ───────────────────────────────────────
app.delete('/api/genre-submissions/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM genre_submissions WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /drop/:genre ─────────────────────────────────────────────────────────
app.get('/drop/:genre', async (req, res) => {
  const genre = req.params.genre.toLowerCase();
  try {
    const { rows } = await db.query(
      \`SELECT * FROM genre_submissions WHERE LOWER(genre)=$1
       ORDER BY drop_date DESC NULLS LAST, created_at DESC LIMIT 1\`,
      [genre]
    );
    if (!rows.length) return res.status(404).send('<h1>No drop found for this genre.</h1>');
    const d = rows[0];
    const ytId = d.youtube_url ? (d.youtube_url.match(/(?:v=|youtu\\.be\\/)([^&?/]+)/) || [])[1] : null;
    const weekTitle = d.week_title || ('Undeniable ' + genre.charAt(0).toUpperCase() + genre.slice(1) + ' Hit of the Week');

    res.send(\`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>\${weekTitle}</title>
<style>
html,body{background:#000;margin:0;padding:0;overflow-x:hidden;font-family:Georgia,"Times New Roman",serif;color:#f3f1ea}
.uht-hit{min-height:100svh;background:#000;display:flex;flex-direction:column;justify-content:flex-start;padding:12px 0 40px}
.uht-header{text-align:center;padding:0 14px;margin-bottom:14px}
.uht-label{font-size:11px;letter-spacing:.25em;opacity:.6;margin-bottom:10px;text-transform:uppercase}
.uht-title{margin:0;font-size:42px;line-height:1.05;font-weight:600}
.uht-sub{margin:16px 0 0}
.uht-song-name{display:block;font-size:24px;font-weight:600;opacity:.98}
.uht-artist-name{display:block;margin-top:4px;font-size:18px;opacity:.72}
.uht-note{margin-top:14px;font-size:17px;font-style:italic;opacity:.75}
.uht-play{margin-top:12px;font-size:11px;letter-spacing:.3em;opacity:.6;transition:opacity .4s ease;text-transform:uppercase}
.uht-video{position:relative;width:100%;aspect-ratio:16/9}
#player{width:100%;height:100%}
.uht-end{position:absolute;inset:0;background:rgba(0,0,0,.82);display:flex;align-items:center;justify-content:center;text-align:center;padding:20px;opacity:0;pointer-events:none;transition:opacity .45s ease}
.uht-end.show{opacity:1;pointer-events:all}
.uht-end p{margin:0;font-size:20px;line-height:1.6}
.vote-row{display:flex;gap:12px;justify-content:center;margin-top:24px;padding:0 14px}
.vote-btn{flex:1;max-width:160px;padding:14px;border-radius:12px;border:none;font-family:Georgia,serif;font-size:16px;cursor:pointer;transition:all .2s;letter-spacing:1px}
.vote-hit{background:rgba(255,100,0,0.15);border:1px solid rgba(255,100,0,0.3);color:rgba(255,150,80,0.9)}
.vote-denied{background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);color:rgba(255,255,255,0.5)}
.vote-btn:disabled{opacity:.4;cursor:default}
.vote-confirm{text-align:center;margin-top:12px;font-size:13px;letter-spacing:.1em;opacity:.5;min-height:20px}
.no-video{padding:40px 14px;text-align:center}
.spotify-btn{display:inline-block;margin-top:16px;padding:12px 28px;border-radius:999px;background:#1DB954;color:#fff;text-decoration:none;font-size:15px;letter-spacing:1px}
@media(min-width:768px){
  .uht-hit{align-items:center;padding:20px 0 60px}
  .uht-title{font-size:clamp(48px,6vw,82px)}
  .uht-song-name{font-size:32px}
  .uht-artist-name{font-size:20px}
  .uht-note{font-size:19px}
  .uht-video{max-width:1400px}
}
</style>
</head>
<body>
<section class="uht-hit">
  <div class="uht-header">
    <div class="uht-label">Hit of the Week</div>
    <h1 class="uht-title">\${weekTitle}</h1>
    <p class="uht-sub">
      <span class="uht-song-name">\${d.title}</span>
      <span class="uht-artist-name">\${d.artist}</span>
    </p>
    \${d.note ? \`<p class="uht-note">\${d.note}</p>\` : ''}
    \${ytId ? \`<div class="uht-play" id="uhtPlay">Press Play.</div>\` : ''}
  </div>

  \${ytId ? \`
  <div class="uht-video">
    <div id="player"></div>
    <div class="uht-end" id="endMessage">
      <p>This one's yours.<br><br>Your next hit arrives via text next Friday.</p>
    </div>
  </div>\` : \`
  <div class="no-video">
    \${d.spotify_url ? \`<a class="spotify-btn" href="\${d.spotify_url}" target="_blank">🎵 Play on Spotify</a>\` : '<p style="opacity:.4">No playback source available.</p>'}
  </div>\`}

  <div class="vote-row">
    <button class="vote-btn vote-hit" id="voteHit" onclick="castVote('hit')">🔥 Hit</button>
    <button class="vote-btn vote-denied" id="voteDenied" onclick="castVote('denied')">💀 Denied</button>
  </div>
  <div class="vote-confirm" id="voteConfirm"></div>
</section>

\${ytId ? \`
<script src="https://www.youtube.com/iframe_api"></script>
<script>
let player, shown=false, timerStarted=false;
function onYouTubeIframeAPIReady(){
  player = new YT.Player('player',{
    videoId:'\${ytId}',
    playerVars:{rel:0,modestbranding:1,playsinline:1},
    events:{onStateChange:onPlayerStateChange}
  });
}
function onPlayerStateChange(e){
  if(e.data===YT.PlayerState.PLAYING){
    var p=document.getElementById('uhtPlay');
    if(p) p.style.opacity='0';
    if(!timerStarted){timerStarted=true;setInterval(checkTime,500);}
  }
}
function checkTime(){
  if(!player||shown) return;
  var c=player.getCurrentTime(), d=player.getDuration();
  if(d&&(d-c<=10)){document.getElementById('endMessage').classList.add('show');shown=true;}
}
</script>\` : ''}

<script>
function castVote(type){
  document.getElementById('voteHit').disabled=true;
  document.getElementById('voteDenied').disabled=true;
  document.getElementById('voteConfirm').textContent = type==='hit' ? '🔥 Hit recorded!' : '💀 Denied recorded!';
  // Save vote via API
  fetch('/api/genre-vote', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({submission_id:\${d.id}, vote:type})
  }).catch(()=>{});
}
</script>
</body>
</html>\`);
  } catch(e) { res.status(500).send('<h1>Error: ' + e.message + '</h1>'); }
});
`;

// Insert before app.listen or at end before module
if (s.includes('app.listen')) {
  s = s.replace(/app\.listen/, routes + '\napp.listen');
} else {
  // Insert before require('./curator-scheduler')
  s = s.replace("require('./curator-scheduler');", routes + "\nrequire('./curator-scheduler');");
}

fs.writeFileSync('server.js', s);
console.log('Done! Genre submissions routes + drop pages added.');
