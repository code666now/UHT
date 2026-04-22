// src/server.js
// Express server: Twilio SMS webhook + WordPress REST API bridge.
// WP plugin calls /api/genres, /api/curators, /api/subscribe.
// Twilio calls /sms for inbound HIT / DENIED votes.
//
// Run: node src/server.js

require('dotenv').config();
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const { runWeeklyDrop } = require('./scheduler');
const express = require('express');
const db      = require('./db');
const twilio  = require('twilio');
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const app  = express();
const PORT = process.env.PORT || 3000;

// CORS — WordPress PHP makes server-side calls, so open is fine.
// Restrict via ALLOWED_ORIGIN env var if needed.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Twilio sends form-encoded; WP plugin sends JSON
app.use(express.urlencoded({ extended: false, limit: "10mb" }));
app.use(express.json({ limit: "10mb" }));
app.use(require("express").static(require("path").join(__dirname, "public")));

// Admin panel
app.get("/admin", (req, res) => res.sendFile(require("path").join(__dirname, "public", "admin.html")));

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'UHT SMS Platform running', version: '1.0.0', deploy: 'apr22-v3' });
});

// ── GET / — Home page ─────────────────────────────────────────────────────────
app.get('/', async (req, res) => {
  try {
    const [genresResult, curatorsResult, currentDropsResult, communityDropResult] = await Promise.all([
      db.query('SELECT id, name FROM genres ORDER BY name ASC'),
      db.query('SELECT id, name, bio, image_url, instagram, slug FROM curators ORDER BY name ASC'),
      // Latest drop per genre
      db.query(`
        SELECT DISTINCT ON (LOWER(genre)) LOWER(genre) AS genre_key, title, artist
        FROM genre_submissions
        WHERE is_community_pick IS NOT TRUE
        ORDER BY LOWER(genre), drop_date DESC NULLS LAST, created_at DESC
      `),
      // Community pick
      db.query(`
        SELECT title, artist FROM genre_submissions
        WHERE is_community_pick = TRUE
        ORDER BY drop_date DESC NULLS LAST, created_at DESC LIMIT 1
      `)
    ]);
    const genres = genresResult.rows;
    const curators = curatorsResult.rows;

    // Build current drop lookup: genre_key -> {title, artist}
    const currentDrops = {};
    currentDropsResult.rows.forEach(r => { currentDrops[r.genre_key] = { title: r.title, artist: r.artist }; });
    if (communityDropResult.rows.length) {
      currentDrops['community'] = { title: communityDropResult.rows[0].title, artist: communityDropResult.rows[0].artist };
    }

    // Genre display config
    const genreConfig = {
      rock:      { emoji: '🎸', label: 'Rock',      path: '/drop/rock' },
      pop:       { emoji: '✨', label: 'Pop',       path: '/drop/pop' },
      country:   { emoji: '🤠', label: 'Country',   path: '/drop/country' },
      punk:      { emoji: '⚡', label: 'Punk',      path: '/drop/punk' },
      community: { emoji: '🃏', label: 'Community', path: '/drop/community' }
    };

    const allGenres = [
      ...genres.map(g => ({ key: g.name.toLowerCase(), ...genreConfig[g.name.toLowerCase()], id: g.id })),
      { key: 'community', emoji: '🃏', label: 'Community', path: '/drop/community', id: null }
    ].filter((g, i, arr) => g.label && arr.findIndex(x => x.key === g.key) === i);

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>UHT — Undeniable Hit Theory</title>
<meta name="description" content="A weekly music drop. Vote HIT or DENIED. Subscribe by text.">
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:#000;color:#f3f1ea;font-family:Georgia,"Times New Roman",serif;overflow-x:hidden}
a{color:inherit;text-decoration:none}

/* ── NAV ── */
.nav{display:flex;align-items:center;justify-content:space-between;padding:24px 32px;position:sticky;top:0;z-index:100;background:#000;border-bottom:1px solid rgba(243,241,234,0.06)}
.nav-logo{font-size:13px;letter-spacing:.3em;text-transform:uppercase;opacity:.9}
.nav-links{display:flex;gap:32px;font-size:11px;letter-spacing:.2em;text-transform:uppercase;opacity:.5}
.nav-links a:hover{opacity:1;transition:opacity .2s}
.nav-cta{font-size:11px;letter-spacing:.2em;text-transform:uppercase;padding:10px 22px;border:1px solid rgba(243,241,234,0.3);border-radius:999px;cursor:pointer;background:none;color:#f3f1ea;font-family:Georgia,serif;transition:all .2s}
.nav-cta:hover{background:#f3f1ea;color:#000;border-color:#f3f1ea}

/* ── HERO ── */
.hero{padding:100px 32px 80px;max-width:900px;margin:0 auto;text-align:center}
.hero-label{font-size:10px;letter-spacing:.4em;text-transform:uppercase;opacity:.35;margin-bottom:36px}
.hero-title{font-size:clamp(52px,10vw,108px);line-height:.95;font-weight:600;letter-spacing:-.02em;margin-bottom:36px}
.hero-title em{font-style:normal;opacity:.35}
.hero-sub{font-size:clamp(17px,2.5vw,22px);opacity:.55;line-height:1.6;max-width:520px;margin:0 auto 48px}
.hero-actions{display:flex;flex-direction:column;gap:14px;align-items:center}
.btn-primary{padding:18px 48px;border-radius:999px;background:#f3f1ea;color:#000;font-family:Georgia,serif;font-size:16px;letter-spacing:.05em;cursor:pointer;border:none;transition:all .2s;display:inline-block}
.btn-primary:hover{background:#fff;transform:translateY(-2px)}
.btn-ghost{padding:16px 48px;border-radius:999px;background:none;color:#f3f1ea;font-family:Georgia,serif;font-size:15px;letter-spacing:.05em;cursor:pointer;border:1px solid rgba(243,241,234,0.25);transition:all .2s;display:inline-block}
.btn-ghost:hover{border-color:rgba(243,241,234,0.7);transform:translateY(-2px)}
.hero-note{font-size:11px;letter-spacing:.15em;text-transform:uppercase;opacity:.25;margin-top:20px}

/* ── SECTION COMMON ── */
.section{padding:80px 32px}
.section-label{font-size:10px;letter-spacing:.4em;text-transform:uppercase;opacity:.3;margin-bottom:20px;text-align:center}
.section-title{font-size:clamp(28px,5vw,48px);text-align:center;margin-bottom:56px;font-weight:600}
.divider{border:none;border-top:1px solid rgba(243,241,234,0.07);margin:0}

/* ── GENRES ── */
.genres-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:2px;max-width:1100px;margin:0 auto}
.genre-card{padding:44px 40px;border:1px solid rgba(243,241,234,0.07);cursor:pointer;transition:all .25s;overflow:hidden;display:block}
.genre-card:hover{background:rgba(243,241,234,0.04);border-color:rgba(243,241,234,0.2)}
.genre-card:hover .genre-arrow{opacity:1;transform:translate(2px,-2px)}
.genre-card-top{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:20px}
.genre-emoji{font-size:28px}
.genre-name{font-size:clamp(26px,4vw,38px);font-weight:600;margin-bottom:14px;line-height:1}
.genre-tag{font-size:9px;letter-spacing:.3em;text-transform:uppercase;opacity:.3}
.genre-drop-title{font-size:15px;font-weight:600;opacity:.85;margin-bottom:4px;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.genre-drop-artist{font-size:12px;opacity:.4;letter-spacing:.05em}
.genre-arrow{font-size:18px;opacity:0;transition:all .2s;color:rgba(243,241,234,0.6);margin-top:4px;flex-shrink:0}

/* ── HOW IT WORKS ── */
.how-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:48px;max-width:900px;margin:0 auto;text-align:center}
.how-step{}
.how-num{font-size:10px;letter-spacing:.4em;text-transform:uppercase;opacity:.25;margin-bottom:20px}
.how-title{font-size:20px;font-weight:600;margin-bottom:12px;line-height:1.2}
.how-desc{font-size:15px;opacity:.45;line-height:1.6}

/* ── CURATORS ── */
.curators-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:2px;max-width:1100px;margin:0 auto}
.curator-card{padding:40px 36px;border:1px solid rgba(243,241,234,0.07);transition:all .25s;cursor:pointer;display:block}
.curator-card:hover{background:rgba(243,241,234,0.04);border-color:rgba(243,241,234,0.2)}
.curator-avatar{width:56px;height:56px;border-radius:50%;object-fit:cover;margin-bottom:20px;opacity:.85;background:rgba(243,241,234,0.1)}
.curator-avatar-placeholder{width:56px;height:56px;border-radius:50%;background:rgba(243,241,234,0.08);display:flex;align-items:center;justify-content:center;font-size:22px;margin-bottom:20px}
.curator-name{font-size:20px;font-weight:600;margin-bottom:8px}
.curator-bio{font-size:14px;opacity:.4;line-height:1.5;margin-bottom:16px}
.curator-insta{font-size:10px;letter-spacing:.2em;text-transform:uppercase;opacity:.3}

/* ── SUBSCRIBE ── */
.subscribe-wrap{max-width:560px;margin:0 auto;text-align:center}
.subscribe-wrap .section-title{margin-bottom:16px}
.subscribe-desc{font-size:16px;opacity:.45;line-height:1.6;margin-bottom:48px}
.subscribe-form{display:flex;flex-direction:column;gap:14px}
.sub-input{width:100%;padding:18px 22px;background:rgba(243,241,234,0.05);border:1px solid rgba(243,241,234,0.12);border-radius:12px;color:#f3f1ea;font-family:Georgia,serif;font-size:16px;outline:none;transition:border-color .2s}
.sub-input:focus{border-color:rgba(243,241,234,0.4)}
.sub-input::placeholder{color:rgba(243,241,234,0.25)}
select.sub-input option{background:#111;color:#f3f1ea}
.sub-btn{width:100%;padding:20px;background:#f3f1ea;color:#000;border:none;border-radius:12px;font-family:Georgia,serif;font-size:16px;letter-spacing:.05em;cursor:pointer;transition:all .2s}
.sub-btn:hover{background:#fff;transform:translateY(-2px)}
.sub-btn:disabled{opacity:.4;cursor:default;transform:none}
.sub-msg{font-size:13px;letter-spacing:.15em;text-transform:uppercase;min-height:20px;opacity:.6;margin-top:8px}
.sub-msg.error{color:#ff6b6b;opacity:1}
.sub-msg.success{color:#a8e6a3;opacity:1}
.verify-wrap{display:none;flex-direction:column;gap:14px;margin-top:4px}
.sub-fine{font-size:10px;letter-spacing:.15em;text-transform:uppercase;opacity:.2;margin-top:16px;line-height:1.6}
.sub-toggle{display:flex;gap:0;border:1px solid rgba(243,241,234,0.15);border-radius:999px;overflow:hidden;width:fit-content;margin:0 auto}
.sub-pill{flex:1;padding:12px 32px;background:none;border:none;color:rgba(243,241,234,0.4);font-family:Georgia,serif;font-size:13px;letter-spacing:.08em;cursor:pointer;transition:all .2s;white-space:nowrap}
.sub-pill.active{background:#f3f1ea;color:#000}
.sub-pill:not(.active):hover{color:rgba(243,241,234,0.8)}

/* ── FOOTER ── */
.footer{padding:60px 32px;text-align:center;border-top:1px solid rgba(243,241,234,0.07)}
.footer-logo{font-size:13px;letter-spacing:.35em;text-transform:uppercase;opacity:.4;margin-bottom:20px}
.footer-links{display:flex;justify-content:center;gap:32px;font-size:10px;letter-spacing:.2em;text-transform:uppercase;opacity:.25;flex-wrap:wrap;margin-bottom:24px}
.footer-links a:hover{opacity:.6}
.footer-copy{font-size:10px;letter-spacing:.15em;text-transform:uppercase;opacity:.15}

/* ── RESPONSIVE ── */
@media(max-width:640px){
  .nav{padding:18px 20px}
  .nav-links{display:none}
  .hero{padding:60px 20px 60px}
  .section{padding:60px 20px}
  .genre-card{padding:36px 24px}
  .curator-card{padding:32px 24px}
  .how-grid{gap:36px}
}
</style>
</head>
<body>

<!-- NAV -->
<nav class="nav">
  <div class="nav-logo">UHT</div>
  <div class="nav-links">
    <a href="#drops">Drops</a>
    <a href="#curators">Curators</a>
    <a href="#how">How It Works</a>
  </div>
  <button class="nav-cta" onclick="document.getElementById('subscribe').scrollIntoView({behavior:'smooth'})">Subscribe</button>
</nav>

<!-- HERO -->
<section class="hero">
  <div class="hero-label">Undeniable Hit Theory</div>
  <h1 class="hero-title">Your weekly<br><em>music</em> verdict.</h1>
  <p class="hero-sub">One song. Every Friday. You vote HIT or DENIED. The best music wins.</p>
  <div class="hero-actions">
    <button class="btn-primary" onclick="document.getElementById('subscribe').scrollIntoView({behavior:'smooth'})">Get the weekly drop</button>
    <a class="btn-ghost" href="#drops">See this week's picks</a>
  </div>
  <div class="hero-note">Free · Text only · Unsubscribe anytime</div>
</section>

<hr class="divider">

<!-- GENRE DROPS -->
<section class="section" id="drops">
  <div class="section-label">This Week's Drops</div>
  <h2 class="section-title">Pick your genre</h2>
  <div class="genres-grid">
    ${allGenres.map(g => {
      const drop = currentDrops[g.key];
      return `
    <a class="genre-card" href="${g.path}">
      <div class="genre-card-top">
        <span class="genre-emoji">${g.emoji}</span>
        <span class="genre-arrow">↗</span>
      </div>
      <div class="genre-name">${g.label}</div>
      ${drop
        ? `<div class="genre-drop-title">${drop.title}</div>
           <div class="genre-drop-artist">${drop.artist}</div>`
        : `<div class="genre-tag">Hit of the Week</div>`}
    </a>`;
    }).join('')}
  </div>
</section>

<hr class="divider">

<!-- HOW IT WORKS -->
<section class="section" id="how">
  <div class="section-label">The Process</div>
  <h2 class="section-title">How It Works</h2>
  <div class="how-grid">
    <div class="how-step">
      <div class="how-num">01</div>
      <div class="how-title">You subscribe</div>
      <div class="how-desc">Drop your number below. Choose your genre or follow a curator.</div>
    </div>
    <div class="how-step">
      <div class="how-num">02</div>
      <div class="how-title">Friday drop</div>
      <div class="how-desc">Every Friday at 10 AM you get one song via text. No albums. No playlists.</div>
    </div>
    <div class="how-step">
      <div class="how-num">03</div>
      <div class="how-title">Vote</div>
      <div class="how-desc">HIT or DENIED. Your vote feeds the leaderboard. The best music rises.</div>
    </div>
  </div>
</section>

<hr class="divider">

<!-- CURATORS -->
${curators.length ? `
<section class="section" id="curators">
  <div class="section-label">The Selectors</div>
  <h2 class="section-title">Curators</h2>
  <div class="curators-grid">
    ${curators.map(c => `
    <a class="curator-card" href="${c.slug ? '/drop/curator/' + c.slug : '#subscribe'}">
      ${c.image_url
        ? `<img class="curator-avatar" src="${c.image_url}" alt="${c.name}" loading="lazy">`
        : `<div class="curator-avatar-placeholder">🎧</div>`}
      <div class="curator-name">${c.name}</div>
      ${c.bio ? `<div class="curator-bio">${c.bio}</div>` : ''}
      ${c.instagram ? `<div class="curator-insta">@${c.instagram}</div>` : ''}
    </a>`).join('')}
  </div>
</section>
<hr class="divider">
` : ''}

<!-- SUBSCRIBE -->
<section class="section" id="subscribe">
  <div class="subscribe-wrap">
    <div class="section-label">Get the Drop</div>
    <h2 class="section-title">Subscribe</h2>
    <p class="subscribe-desc">One text. Every Friday. Vote HIT or DENIED and see how the world hears it.</p>
    <form class="subscribe-form" id="subForm" onsubmit="handleSubscribe(event)">
      <input class="sub-input" id="subPhone" type="tel" placeholder="Your phone number" autocomplete="tel" required>

      <!-- Toggle pills -->
      <div class="sub-toggle">
        <button type="button" class="sub-pill active" id="pillGenre" onclick="switchPill('genre')">By Genre</button>
        <button type="button" class="sub-pill" id="pillCurator" onclick="switchPill('curator')">By Curator</button>
      </div>

      <div id="genrePanel">
        <select class="sub-input" id="subGenre">
          <option value="">Choose a genre...</option>
          ${allGenres.map(g => `<option value="${g.key}" data-id="${g.id||''}">${g.emoji} ${g.label}</option>`).join('')}
        </select>
      </div>

      <div id="curatorPanel" style="display:none">
        <select class="sub-input" id="subCurator">
          <option value="">Choose a curator...</option>
          ${curators.map(c => `<option value="${c.id}">${c.name}</option>`).join('')}
        </select>
      </div>

      <button class="sub-btn" type="submit" id="subBtn">Send me the drop</button>
      <div class="sub-msg" id="subMsg"></div>
    </form>
    <div class="verify-wrap" id="verifyWrap">
      <input class="sub-input" id="verifyCode" type="text" placeholder="Enter verification code" maxlength="6" inputmode="numeric">
      <button class="sub-btn" onclick="handleVerify()">Verify</button>
      <div class="sub-msg" id="verifyMsg"></div>
    </div>
    <div class="sub-fine">By subscribing you agree to receive weekly SMS messages.<br>Text STOP at any time to unsubscribe. Standard rates may apply.</div>
  </div>
</section>

<!-- FOOTER -->
<footer class="footer">
  <div class="footer-logo">UHT</div>
  <div class="footer-links">
    <a href="#drops">Drops</a>
    <a href="#curators">Curators</a>
    <a href="#how">How It Works</a>
    <a href="/admin">Admin</a>
  </div>
  <div class="footer-copy">© ${new Date().getFullYear()} Undeniable Hit Theory · Silver Glider Line +1 (844) 261-6758</div>
</footer>

<script>
var _subPhone = '';
var _activePill = 'genre';

function switchPill(type) {
  _activePill = type;
  document.getElementById('pillGenre').className = 'sub-pill' + (type === 'genre' ? ' active' : '');
  document.getElementById('pillCurator').className = 'sub-pill' + (type === 'curator' ? ' active' : '');
  document.getElementById('genrePanel').style.display = type === 'genre' ? 'block' : 'none';
  document.getElementById('curatorPanel').style.display = type === 'curator' ? 'block' : 'none';
}

function handleSubscribe(e) {
  e.preventDefault();
  var phone = document.getElementById('subPhone').value.trim();
  var msg = document.getElementById('subMsg');
  var btn = document.getElementById('subBtn');

  var genreEl = document.getElementById('subGenre');
  var curatorEl = document.getElementById('subCurator');
  var genreKey = _activePill === 'genre' ? genreEl.value : '';
  var genreId = _activePill === 'genre' ? (genreEl.options[genreEl.selectedIndex] && genreEl.options[genreEl.selectedIndex].dataset.id) : '';
  var curatorId = _activePill === 'curator' ? curatorEl.value : '';

  if (!phone) { showMsg(msg, 'Phone number is required.', 'error'); return; }
  if (_activePill === 'genre' && !genreKey) { showMsg(msg, 'Choose a genre.', 'error'); return; }
  if (_activePill === 'curator' && !curatorId) { showMsg(msg, 'Choose a curator.', 'error'); return; }

  btn.disabled = true;
  btn.textContent = 'Sending...';
  msg.className = 'sub-msg';
  msg.textContent = '';

  var body = { phone: phone };
  if (curatorId) { body.curator_id = parseInt(curatorId); }
  else if (genreId) { body.genre_id = parseInt(genreId); }
  else {
    body.genre_id = null;
  }

  _subPhone = phone;

  fetch('/api/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  .then(function(r){ return r.json().then(function(d){ return {ok:r.ok,data:d}; }); })
  .then(function(res){
    if (res.ok) {
      // Send verification code
      return fetch('/api/send_code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: phone })
      }).then(function(r2){ return r2.json(); }).then(function(d2){
        document.getElementById('subForm').style.display = 'none';
        var vw = document.getElementById('verifyWrap');
        vw.style.display = 'flex';
        showMsg(document.getElementById('verifyMsg'), 'Code sent — check your texts.', 'success');
      });
    } else {
      showMsg(msg, res.data.error || 'Something went wrong.', 'error');
      btn.disabled = false;
      btn.textContent = 'Send me the drop';
    }
  })
  .catch(function(err){
    showMsg(msg, 'Network error. Try again.', 'error');
    btn.disabled = false;
    btn.textContent = 'Send me the drop';
  });
}

function handleVerify() {
  var code = document.getElementById('verifyCode').value.trim();
  var msg = document.getElementById('verifyMsg');
  if (!code) { showMsg(msg, 'Enter the code from your text.', 'error'); return; }
  fetch('/api/verify_code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: _subPhone, code: code })
  })
  .then(function(r){ return r.json().then(function(d){ return {ok:r.ok,data:d}; }); })
  .then(function(res){
    if (res.ok) {
      document.getElementById('verifyWrap').innerHTML = '<div style="font-size:22px;text-align:center;padding:20px 0">You\\'re in.<br><span style="font-size:14px;opacity:.5;letter-spacing:.1em">Your first drop arrives Friday.</span></div>';
    } else {
      showMsg(msg, res.data.error || 'Invalid code.', 'error');
    }
  })
  .catch(function(){ showMsg(msg, 'Network error. Try again.', 'error'); });
}

function showMsg(el, text, type) {
  el.textContent = text;
  el.className = 'sub-msg ' + (type||'');
}
</script>
</body>
</html>`);
  } catch(e) {
    res.status(500).send('<h1 style="font-family:sans-serif;color:#f3f1ea;background:#000;padding:40px">Error: ' + e.message + '</h1>');
  }
});

// =============================================================================
// WORDPRESS BRIDGE ROUTES  (called by uht-platform.php)
// =============================================================================

// GET /api/genres  — powers the genre chip selector on the landing page
app.get('/api/genres', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT id, name FROM genres ORDER BY name ASC');
    res.json({ genres: rows });
  } catch (err) {
    console.error('[API] genres error:', err.message);
    res.status(500).json({ error: 'Failed to load genres.' });
  }
});

// GET /api/curators  — for future curator-select UI
app.get('/api/curators', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT id, name, bio, image_url, instagram FROM curators ORDER BY name ASC');
    res.json({ curators: rows });
  } catch (err) {
    console.error('[API] curators error:', err.message);
    res.status(500).json({ error: 'Failed to load curators.' });
  }
});

// POST /api/subscribe  — body: { phone, genre_id?, curator_id? }
// Creates user (if new) and records subscription.
app.post('/api/subscribe', async (req, res) => {
  const { phone, name, email, genre_id, curator_id } = req.body;

  if (!phone) return res.status(400).json({ error: 'phone is required.' });
  if (!genre_id && !curator_id) return res.status(400).json({ error: 'Provide genre_id or curator_id.' });
  if (genre_id && curator_id)   return res.status(400).json({ error: 'Provide genre_id OR curator_id, not both.' });

  // Normalise bare 10-digit to E.164
  const normalPhone = /^\d{10}$/.test(phone) ? '+1' + phone : phone;
  if (!/^\+1\d{10}$/.test(normalPhone)) {
    return res.status(400).json({ error: 'Invalid US phone number.' });
  }

  try {
    // Upsert user by phone
    const { rows: userRows } = await db.query(
      `INSERT INTO users (phone, name, email)
       VALUES ($1, $2, $3)
       ON CONFLICT (phone) DO UPDATE SET name = COALESCE(EXCLUDED.name, users.name), email = COALESCE(EXCLUDED.email, users.email)
       RETURNING id`,
      [normalPhone, name || null, email || null]
    );
    const userId = userRows[0].id;

    // Create subscription (DO NOTHING if duplicate)
    const { rows: subRows } = await db.query(
      `INSERT INTO subscriptions (user_id, genre_id, curator_id)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [userId, genre_id || null, curator_id || null]
    );

    const isNew = subRows.length > 0;
    console.log(`[Subscribe] ${normalPhone} -> user #${userId} | ${isNew ? 'new subscription' : 'already subscribed'}`);

    // Send opt-in confirmation text to new subscribers
    if (isNew) {
      try {
        await twilioClient.messages.create({
          body: 'Undeniable Hit Theory: Reply YES to confirm you want curator text drops. 1-2 msgs/month. Reply STOP to opt out.',
          from: process.env.TWILIO_FROM,
          to: normalPhone,
        });
        console.log(`[Subscribe] Opt-in SMS sent to ${normalPhone}`);
      } catch (smsErr) {
        console.error('[Subscribe] Failed to send opt-in SMS:', smsErr.message);
      }
    }

    res.json({
      success: true,
      message: isNew
        ? 'Subscribed! Check your phone for a confirmation text.'
        : "You're already subscribed — Friday drops incoming!",
      user_id: userId,
    });
  } catch (err) {
    console.error('[API] subscribe error:', err.message);
    res.status(500).json({ error: 'Subscription failed. Please try again.' });
  }
});

// =============================================================================
// TWILIO INBOUND SMS WEBHOOK  — POST /sms
// Receives HIT (1) / DENIED (2) replies and records votes.
// =============================================================================
app.post('/sms', async (req, res) => {
  const from = req.body.From;
  const body = (req.body.Body || '').trim();

  console.log(`[SMS] From: ${from}  Body: "${body}"`);

  // Helper: respond with TwiML text
  const twiml = (msg) => {
    res.set('Content-Type', 'text/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${msg}</Message></Response>`);
  };

  const upper = body.toUpperCase();

  // Handle YES opt-in
  if (upper === 'YES' || upper === 'Y') {
    try {
      const { rows } = await db.query(
        'UPDATE users SET sms_verified = true WHERE phone = $1 RETURNING id',
        [from]
      );
      if (rows.length) {
        const userId = rows[0].id;
        await db.query(
          'UPDATE subscriptions SET is_active = true WHERE user_id = $1',
          [userId]
        );
        return twiml("You're in! UHT will send your picks by text. Reply STOP anytime to opt out.");
      } else {
        return twiml("Hmm, we couldn't find your number. Visit the site to sign up.");
      }
    } catch(e) {
      console.error('[YES] error:', e.message);
      return twiml('Something went wrong. Try again later.');
    }
  }

  // Handle HELP
  if (upper === 'HELP') {
    return twiml('UHT: Reply HIT or DENY to vote on your weekly drop. Reply STOP to unsubscribe.');
  }

  // Parse vote
  let voteValue;
  if (upper === 'HIT' || upper === '1') voteValue = 'hit';
  else if (upper === 'DENY' || upper === 'DENIED' || upper === '2') voteValue = 'deny';
  else if (upper === 'MEGA HIT' || upper === 'ULTRA HIT' || upper === '3') voteValue = 'mega_hit';
  else {
    return twiml('Reply 1 (Hit), 2 (Deny), or 3 (Ultra Hit) to vote on your weekly drop.');
  }

  try {
    // Look up user
    const { rows: users } = await db.query(
      'SELECT id FROM users WHERE phone = $1',
      [from]
    );

    if (!users.length) {
      console.warn(`  [Vote] Unknown phone: ${from}`);
      return twiml("We don't recognise your number. Subscribe at undeniablehittheory.com");
    }

    const userId = users[0].id;

    // Find most recent delivery
    const { rows: deliveries } = await db.query(
      `SELECT id, song_id FROM deliveries
       WHERE user_id = $1
       ORDER BY sent_at DESC
       LIMIT 1`,
      [userId]
    );

    if (!deliveries.length) {
      console.warn(`  [Vote] No deliveries for user #${userId}`);
      return twiml('No recent drops found. Stay tuned!');
    }

    const { id: deliveryId, song_id: songId } = deliveries[0];

    // Upsert vote into legacy votes table
    const legacyVote = voteValue === 'mega_hit' ? 'hit' : voteValue;
    await db.query(
      `INSERT INTO votes (delivery_id, user_id, song_id, vote, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (delivery_id) DO UPDATE
         SET vote = EXCLUDED.vote,
             updated_at = NOW()`,
      [deliveryId, userId, songId, legacyVote]
    );

    // Also record in new curator intelligence song_votes table
    const { rows: subs } = await db.query(
      'SELECT curator_id FROM subscriptions WHERE user_id = $1 AND is_active = true LIMIT 1',
      [userId]
    );
    const curatorId = subs.length ? subs[0].curator_id : null;
    await db.query(
      `INSERT INTO song_votes (subscriber_id, curator_id, song_id, vote_type)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (subscriber_id, song_id, playlist_id) DO UPDATE
         SET vote_type = EXCLUDED.vote_type, created_at = NOW()`,
      [userId, curatorId, songId, voteValue]
    ).catch(e => console.warn('[song_votes] non-fatal:', e.message));

    const emoji = voteValue === 'mega_hit' ? '🔥🔥' : voteValue === 'hit' ? '🔥' : '❌';
    console.log(`  [Vote] User #${userId} voted ${voteValue.toUpperCase()} on delivery #${deliveryId}`);
    return twiml(`Thanks! Marked as ${voteValue.toUpperCase()} ${emoji}`);

  } catch (err) {
    console.error('[Vote] Error:', err.message);
    return twiml('Something went wrong. Try again soon!');
  }
});


// ── GET /api/curator-submissions ─────────────────────────────
app.get('/api/curator-submissions', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT cs.*, c.name AS curator_name
      FROM curator_submissions cs
      LEFT JOIN curators c ON c.id = cs.curator_id
      ORDER BY cs.submitted_at DESC
    `);
    res.json({ submissions: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/curator-submissions ────────────────────────────
app.post('/api/curator-submissions', async (req, res) => {
  const { curator_id, title, artist, spotify_url, youtube_url, theme, week_number, curator_note } = req.body;
  if (!curator_id || !title || !artist) {
    return res.status(400).json({ error: 'curator_id, title, and artist are required.' });
  }
  try {
    const { rows } = await db.query(`
      INSERT INTO curator_submissions (curator_id, title, artist, spotify_url, youtube_url, theme, week_number, curator_note)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *
    `, [curator_id, title, artist, spotify_url || null, youtube_url || null, theme || null, week_number || 1, curator_note || null]);
    res.json({ submission: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ── PATCH /api/curator-submissions/:id ───────────────────────────────────────
app.patch('/api/curator-submissions/:id', async (req, res) => {
  const { title, artist, spotify_url, youtube_url, theme, week_number, curator_note } = req.body;
  if (!title || !artist) return res.status(400).json({ error: 'title and artist required.' });
  try {
    const { rows } = await db.query(
      `UPDATE curator_submissions SET
        title=$1, artist=$2, spotify_url=$3, youtube_url=$4,
        theme=$5, week_number=$6, curator_note=$7
       WHERE id=$8 RETURNING *`,
      [title, artist, spotify_url||null, youtube_url||null, theme||null, week_number||1, curator_note||null, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found.' });
    res.json({ submission: rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/curator-submissions/:id ──────────────────────
app.delete('/api/curator-submissions/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM curator_submissions WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/curator-submissions/:id/votes ────────────────
app.delete('/api/curator-submissions/:id/votes', async (req, res) => {
  try {
    await db.query('DELETE FROM curator_submission_votes WHERE submission_id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/curator-submissions/by-curator/:curatorId ────────
app.get('/api/curator-submissions/by-curator/:curatorId', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT * FROM curator_submissions
      WHERE curator_id = $1
      ORDER BY week_number ASC, submitted_at DESC
    `, [req.params.curatorId]);
    res.json({ submissions: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Start server ──────────────────────────────────────────────────────────────

app.post('/api/drop/send', async (req, res) => {
  try { const r = await runWeeklyDrop(); res.json({ ok: true, ...r }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/drop/test — send to a single phone number only ─────────────────
app.post('/api/drop/test', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  try {
    const { rows: subs } = await db.query(`
      SELECT s.id AS sub_id, s.user_id, s.genre_id, s.curator_id, u.phone
      FROM subscriptions s
      JOIN users u ON u.id = s.user_id
      WHERE u.phone = $1 AND s.is_active = TRUE
      LIMIT 1
    `, [phone]);
    if (!subs.length) return res.status(404).json({ error: 'No active subscription found for that number' });
    const sub = subs[0];
    const { rows: songs } = await db.query(`
      SELECT s.*, g.name AS genre_name, c.name AS curator_name
      FROM songs s
      LEFT JOIN genres g ON g.id = s.genre_id
      LEFT JOIN curators c ON c.id = s.curator_id
      WHERE (($1::int IS NOT NULL AND s.genre_id=$1) OR ($2::int IS NOT NULL AND s.curator_id=$2))
      AND s.id NOT IN (SELECT song_id FROM deliveries WHERE user_id=$3)
      ORDER BY s.created_at ASC LIMIT 1
    `, [sub.genre_id, sub.curator_id, sub.user_id]);
    if (!songs.length) return res.status(404).json({ error: 'No unplayed songs for this subscriber' });
    const song = songs[0];
    const { buildDropMessage } = require('./scheduler');
    const msg = buildDropMessage(song);
    const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    await twilio.messages.create({ from: process.env.TWILIO_FROM || process.env.TWILIO_PHONE_NUMBER, to: phone, body: msg });
    res.json({ ok: true, sent_to: phone, song: song.title });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/genres/seed', async (req, res) => {
  const genres = ['Rock', 'Punk', 'Pop', 'Country'];
  const created = [];
  for (const name of genres) {
    const { rows } = await db.query(
      'INSERT INTO genres (name) VALUES ($1) ON CONFLICT (name) DO NOTHING RETURNING *',
      [name]
    );
    if (rows.length) created.push(name);
  }
  res.json({ seeded: created });
});


// ── Twilio Verify: send OTP ───────────────────────────────────────────────────
app.post('/api/send_code', async (req, res) => {
  const { phone, name, email } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  try {
    const client = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    await client.verify.v2
      .services(process.env.TWILIO_VERIFY_SID)
      .verifications.create({ to: phone, channel: 'sms' });
    res.json({ ok: true });
  } catch (err) {
    console.error('send_code error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Twilio Verify: verify OTP + subscribe ─────────────────────────────────────
app.post('/api/verify_code', async (req, res) => {
  const { phone, code, genre } = req.body;
  if (!phone || !code) return res.status(400).json({ error: 'phone and code required' });
  try {
    const client = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const check = await client.verify.v2
      .services(process.env.TWILIO_VERIFY_SID)
      .verificationChecks.create({ to: phone, code });

    if (check.status !== 'approved') {
      return res.status(400).json({ error: 'Invalid or expired code.' });
    }

    // Upsert user
    const { rows: [user] } = await db.query(
      `INSERT INTO users (phone) VALUES ($1)
       ON CONFLICT (phone) DO UPDATE SET phone = EXCLUDED.phone
       RETURNING *`,
      [phone]
    );

    // Subscribe to genre if provided
    if (genre) {
      const { rows: genres } = await db.query(
        'SELECT id FROM genres WHERE LOWER(name) = LOWER($1) LIMIT 1', [genre]
      );
      if (genres.length) {
        await db.query(
          `INSERT INTO subscriptions (user_id, genre_id, is_active)
           VALUES ($1, $2, true)
           ON CONFLICT (user_id, genre_id) DO UPDATE SET is_active = true`,
          [user.id, genres[0].id]
        );
      }
    }

    res.json({ ok: true, status: 'approved' });
  } catch (err) {
    console.error('verify_code error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Check if subscriber exists ────────────────────────────────────────────────
app.get('/api/check_subscriber', async (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  try {
    const { rows } = await db.query(
      'SELECT * FROM users WHERE phone = $1 LIMIT 1', [phone]
    );
    if (rows.length) {
      res.json({ exists: true, verified: true });
    } else {
      res.json({ exists: false, verified: false });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Playlist links (optional — return empty array by default) ─────────────────
app.get('/api/playlist_links', (req, res) => {
  res.json({ playlist_links: [] });
});


// ── POST /api/follows ─────────────────────────────────────────────────────────
app.post('/api/follows', async (req, res) => {
  const { phone, curator_id } = req.body;
  if (!phone || !curator_id) return res.status(400).json({ error: 'phone and curator_id required.' });
  try {
    await db.query(
      `INSERT INTO follows (phone, curator_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [phone, curator_id]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/follows ───────────────────────────────────────────────────────
app.delete('/api/follows', async (req, res) => {
  const { phone, curator_id } = req.body;
  if (!phone || !curator_id) return res.status(400).json({ error: 'phone and curator_id required.' });
  try {
    await db.query(`DELETE FROM follows WHERE phone=$1 AND curator_id=$2`, [phone, curator_id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/follows/check ────────────────────────────────────────────────────
app.get('/api/follows/check', async (req, res) => {
  const { phone, curator_id } = req.query;
  if (!phone || !curator_id) return res.status(400).json({ error: 'phone and curator_id required.' });
  try {
    const { rows } = await db.query(
      `SELECT id FROM follows WHERE phone=$1 AND curator_id=$2`,
      [phone, curator_id]
    );
    res.json({ following: rows.length > 0 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/follows/curator/:id ──────────────────────────────────────────────
app.get('/api/follows/curator/:id', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT phone, created_at FROM follows WHERE curator_id=$1 ORDER BY created_at DESC`,
      [req.params.id]
    );
    res.json({ followers: rows, count: rows.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ── GET /api/genre-submissions ───────────────────────────────────────────────
app.get('/api/genre-submissions', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM genre_submissions ORDER BY drop_date DESC, created_at DESC`
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
      `INSERT INTO genre_submissions (genre, week_title, title, artist, note, youtube_url, spotify_url, week_number, drop_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
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
      `UPDATE genre_submissions SET genre=$1, week_title=$2, title=$3, artist=$4, note=$5,
       youtube_url=$6, spotify_url=$7, week_number=$8, drop_date=$9 WHERE id=$10 RETURNING *`,
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


// ── GET /drop/curator/:slug ──────────────────────────────────────────────────
app.get('/drop/curator/:slug', async (req, res) => {
  const slug = req.params.slug.toLowerCase();
  try {
    const curatorRes = await db.query(
      `SELECT * FROM curators WHERE LOWER(REPLACE(name,' ','-'))=$1 LIMIT 1`,
      [slug]
    );
    if (!curatorRes.rows.length) return res.status(404).send('<h1>Curator not found.</h1>');
    const curator = curatorRes.rows[0];

    const subRes = await db.query(
      `SELECT * FROM curator_submissions WHERE curator_id=$1
       ORDER BY week_number DESC, submitted_at DESC LIMIT 1`,
      [curator.id]
    );
    if (!subRes.rows.length) return res.status(404).send('<h1>No picks yet.</h1>');
    const d = subRes.rows[0];
    const allSubsRes = await db.query(
      `SELECT * FROM curator_submissions WHERE curator_id=$1 ORDER BY week_number ASC`,
      [curator.id]
    );
    const allSubs = allSubsRes.rows;

    // Compute curator tier from lifetime hit votes
    const hitRes = await db.query(
      `SELECT COUNT(*) AS hits FROM curator_submission_votes
        WHERE submission_id IN (
          SELECT id FROM curator_submissions WHERE curator_id = $1
        ) AND vote = 'hit'`,
      [curator.id]
    );
    const totalHits = parseInt(hitRes.rows[0].hits, 10);
    const curatorTier =
      totalHits >= 28 ? '🏆 Legend' :
      totalHits >= 18 ? '👑 Tastemaker' :
      totalHits >= 8  ? '🎯 Hit Hunter' :
                        '🌙 Rising Curator';

    const ytId = d.youtube_url ? (d.youtube_url.match(/(?:v=|youtu\.be\/)([^&?/]+)/) || [])[1] : null;
    const pageUrl = '/drop/curator/' + slug;
    const firstName = curator.name.split(' ')[0];

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${curator.name}'s Pick — UHT</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;1,400&family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:#080808;color:#ede8df;font-family:'Inter',sans-serif;overflow-x:hidden}
.page{max-width:720px;margin:0 auto}

/* Stamp */
.stamp{text-align:center;padding:44px 24px 36px}
.stamp-brand{font-family:'Playfair Display',serif;font-size:clamp(22px,5vw,32px);font-weight:700;letter-spacing:2px;color:rgba(237,232,223,0.85);margin-bottom:10px}
.stamp-month{font-size:9px;letter-spacing:.35em;text-transform:uppercase;color:rgba(237,232,223,0.3)}

/* Hero — full bleed */
.hero{position:relative;width:100%;aspect-ratio:3/4;max-height:90vh;overflow:hidden;background:#111}
.hero img{width:100%;height:100%;object-fit:cover;object-position:center top;display:block}
.hero-grad{position:absolute;inset:0;background:linear-gradient(to bottom,transparent 40%,rgba(8,8,8,0.5) 70%,#080808 100%)}
.hero-name{position:absolute;bottom:0;left:0;right:0;padding:24px 28px 32px;display:flex;justify-content:space-between;align-items:flex-end}
.hero-name-left{}
.c-name{font-family:'Playfair Display',serif;font-size:clamp(40px,10vw,68px);font-weight:700;line-height:1;letter-spacing:-1px;color:#ede8df}
.c-tier{font-size:9px;letter-spacing:.28em;text-transform:uppercase;color:rgba(237,232,223,0.4);margin-top:10px}
.hero-actions{display:flex;flex-direction:column;align-items:flex-end;gap:10px;flex-shrink:0;padding-left:16px}
.hero-follow{font-size:9px;letter-spacing:.2em;text-transform:uppercase;color:rgba(237,232,223,0.7);background:rgba(0,0,0,0.45);border:1px solid rgba(237,232,223,0.25);border-radius:999px;padding:8px 14px;cursor:pointer;font-family:'Inter',sans-serif;white-space:nowrap;backdrop-filter:blur(8px);transition:all .2s}
.hero-follow:hover{background:rgba(237,232,223,0.15);color:#ede8df}
.hero-ig{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:50%;background:rgba(0,0,0,0.45);border:1px solid rgba(237,232,223,0.2);color:rgba(237,232,223,0.6);text-decoration:none;backdrop-filter:blur(8px);transition:all .2s}
.hero-ig:hover{background:rgba(237,232,223,0.15);color:#ede8df}

/* Bio */
.bio{padding:44px 32px;border-bottom:1px solid rgba(255,255,255,0.06)}
.bio p{font-family:'Playfair Display',serif;font-size:16px;line-height:2;color:rgba(237,232,223,0.5);font-style:italic}

/* Pick */
.pick{padding:52px 32px 36px}
.pick-meta{font-size:9px;letter-spacing:.35em;text-transform:uppercase;color:rgba(237,232,223,0.25);margin-bottom:22px}
.song-title{font-family:'Playfair Display',serif;font-size:clamp(38px,9vw,66px);font-weight:700;line-height:1.02;letter-spacing:-1.5px;color:#ede8df;margin-bottom:10px}
.song-artist{font-size:12px;letter-spacing:.22em;text-transform:uppercase;color:rgba(237,232,223,0.35);font-weight:400;margin-bottom:32px}
.song-note{font-family:'Playfair Display',serif;font-size:17px;font-style:italic;color:rgba(237,232,223,0.45);line-height:1.9;padding-left:20px;border-left:1px solid rgba(237,232,223,0.18);margin-bottom:0}

/* Player */
.player-outer{width:100%;aspect-ratio:16/9;background:#000;overflow:hidden}
#player,#player iframe{width:100%;height:100%;border:none;display:block}

/* Below player */
.below-player{padding:16px 32px 8px;display:flex;flex-direction:column;gap:10px}
.sp-whisper{font-size:9px;letter-spacing:.22em;text-transform:uppercase;color:rgba(237,232,223,0.2);cursor:pointer;background:none;border:none;font-family:'Inter',sans-serif;padding:0;text-align:left}
.sp-whisper:hover{color:rgba(237,232,223,0.45)}
.sp-embed{width:100%}
.share-cta{font-size:13px;color:rgba(237,232,223,0.55);cursor:pointer;background:none;border:none;font-family:'Playfair Display',serif;font-style:italic;padding:0;letter-spacing:.02em;transition:color .2s}
.share-cta:hover{color:#ede8df}

/* Vote */
.vote-section{padding:32px 32px 28px}
.vote-label{font-size:9px;letter-spacing:.35em;text-transform:uppercase;color:rgba(237,232,223,0.2);text-align:center;margin-bottom:20px}
.vote-row{display:flex;flex-direction:column;gap:12px}
.vote-btn{width:100%;padding:20px;border-radius:12px;border:1px solid rgba(255,255,255,0.09);background:rgba(255,255,255,0.025);color:rgba(237,232,223,0.75);font-family:'Inter',sans-serif;font-size:16px;cursor:pointer;transition:all .25s;text-align:center;letter-spacing:.03em}
.vote-btn:hover{background:rgba(255,255,255,0.07);border-color:rgba(255,255,255,0.18);color:#ede8df;transform:translateY(-2px)}
.vote-btn:active{transform:translateY(0)}
.vote-btn:disabled{opacity:.2;cursor:default;transform:none}
.vote-msg{text-align:center;font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:rgba(237,232,223,0.3);min-height:22px;padding:12px 0 0}
@media(min-width:600px){
  .vote-row{flex-direction:row}
  .vote-btn{flex:1}
}

/* Archive */
.archive{padding:44px 32px 20px;border-top:1px solid rgba(255,255,255,0.06)}
.archive-label{font-size:9px;letter-spacing:.35em;text-transform:uppercase;color:rgba(237,232,223,0.2);margin-bottom:28px}
.archive-item{padding:24px 0;border-bottom:1px solid rgba(255,255,255,0.05)}
.archive-item:last-child{border-bottom:none}
.archive-week{font-size:9px;letter-spacing:.28em;text-transform:uppercase;color:rgba(237,232,223,0.25);margin-bottom:8px}
.archive-title{font-family:'Playfair Display',serif;font-size:22px;font-weight:700;color:#ede8df;margin-bottom:4px}
.archive-artist{font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:rgba(237,232,223,0.35);margin-bottom:8px}
.archive-note{font-family:'Playfair Display',serif;font-size:14px;font-style:italic;color:rgba(237,232,223,0.35);line-height:1.7}
.archive-votes{font-size:11px;color:rgba(237,232,223,0.2);margin-top:8px;letter-spacing:.05em}

/* Bottom */
.bottom{padding:20px 32px 72px;text-align:center}
.bottom-share{font-size:9px;letter-spacing:.25em;text-transform:uppercase;color:rgba(237,232,223,0.2);cursor:pointer;background:none;border:none;font-family:'Inter',sans-serif}
.bottom-share:hover{color:rgba(237,232,223,0.5)}

/* Follow modal */
.modal-bg{position:fixed;inset:0;background:rgba(0,0,0,0.8);backdrop-filter:blur(8px);z-index:999;display:none;align-items:flex-end;justify-content:center}
.modal-bg.open{display:flex}
.modal{background:#141414;border-radius:20px 20px 0 0;width:100%;max-width:480px;padding:32px 28px 48px}
.modal-title{font-family:'Playfair Display',serif;font-size:22px;font-weight:700;color:#ede8df;margin-bottom:6px}
.modal-sub{font-size:12px;letter-spacing:.1em;color:rgba(237,232,223,0.35);margin-bottom:24px;text-transform:uppercase}
.modal input{width:100%;padding:16px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);border-radius:10px;color:#ede8df;font-family:'Inter',sans-serif;font-size:16px;outline:none;margin-bottom:12px}
.modal-btn{width:100%;padding:16px;background:#ede8df;color:#080808;border:none;border-radius:10px;font-family:'Inter',sans-serif;font-size:15px;font-weight:600;cursor:pointer;transition:opacity .2s}
.modal-btn:hover{opacity:.9}
.modal-close{position:absolute;top:16px;right:20px;background:none;border:none;color:rgba(237,232,223,0.4);font-size:20px;cursor:pointer;font-family:'Inter',sans-serif}
.modal-msg{text-align:center;font-size:12px;color:rgba(237,232,223,0.4);margin-top:12px;min-height:18px}
</style>
</head>
<body>
<div class="page">

<div class="stamp">
  <div class="stamp-brand">Undeniable Hit Theory</div>
  <div class="stamp-month">${curator.curator_month ? '🌙 Curator of the Month · ' + curator.curator_month : '🌙 Curator Pick'}</div>
</div>

<div class="hero">
  ${curator.image_url ? `<img src="${curator.image_url}" alt="${curator.name}">` : ''}
  <div class="hero-grad"></div>
  <div class="hero-name">
    <div class="hero-name-left">
      <div class="c-name">${curator.name}</div>
      <div class="c-tier">${curatorTier}</div>
    </div>
    <div class="hero-actions">
      ${curator.instagram ? `<a class="hero-ig" href="https://instagram.com/${curator.instagram.replace('@','')}" target="_blank" title="@${curator.instagram}"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="5" ry="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/></svg></a>` : ''}
      <button class="hero-follow" onclick="openFollowModal()">+ Follow</button>
    </div>
  </div>
</div>

${curator.bio ? `<div class="bio"><p>${curator.bio}</p></div>` : ''}

<div class="pick">
  <div class="pick-meta">${d.theme ? d.theme.toUpperCase() + ' · ' : ''}Week ${d.week_number}</div>
  <div class="song-title">${d.title}</div>
  <div class="song-artist">${d.artist}</div>
  ${d.curator_note ? `<div class="song-note">"${d.curator_note}"</div>` : ''}
</div>

${ytId ? `<div class="player-outer" id="ytWrap"><div id="player"></div></div>` : ''}
${!ytId && d.spotify_url ? `<div class="player-outer" style="height:152px"><iframe src="https://open.spotify.com/embed/track/${d.spotify_url.match(/track\/([a-zA-Z0-9]+)/)?.[1]}" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" loading="lazy"></iframe></div>` : ''}

<div class="below-player">
  ${ytId && d.spotify_url ? `
  <button class="sp-whisper" onclick="var w=document.getElementById('spWrap');w.style.display=w.style.display==='none'?'block':'none'">Prefer Spotify?</button>
  <div id="spWrap" style="display:none">
    <iframe style="border-radius:10px;display:block" src="https://open.spotify.com/embed/track/${d.spotify_url.match(/track\/([a-zA-Z0-9]+)/)?.[1]}" width="100%" height="152" frameBorder="0" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" loading="lazy"></iframe>
  </div>
  ` : ''}
  <button class="share-cta" onclick="sharePick()">↗ Share this pick with a friend</button>
</div>

<div class="vote-section">
  <div class="vote-label">Is this an undeniable hit?</div>
  <div class="vote-row">
    <button class="vote-btn" id="vMega" onclick="vote('mega_hit')">🔥 Mega Hit</button>
    <button class="vote-btn" id="vHit" onclick="vote('hit')">🎯 Hit</button>
    <button class="vote-btn" id="vDenied" onclick="vote('deny')">💀 Denied</button>
  </div>
  <div class="vote-msg" id="voteMsg"></div>
</div>

${allSubs && allSubs.length > 0 ? `
<div class="archive">
  <div class="archive-label">Archive · ${curator.name.split(' ')[0]}'s Picks</div>
  ${allSubs.map((sub, i) => `
  <div class="archive-item">
    <div class="archive-week">Week ${sub.week_number} of 4</div>
    <div class="archive-title">${sub.title}</div>
    <div class="archive-artist">${sub.artist}</div>
    ${sub.curator_note ? `<div class="archive-note">"${sub.curator_note}"</div>` : ''}
    <div class="archive-votes">🔥 ${sub.mega_hits||0} · 🎯 ${sub.hits||0} · 💀 ${sub.denies||0}</div>
  </div>
  `).join('')}
</div>
` : ''}

<div class="bottom">
  <button class="bottom-share" onclick="sharePick()">Share this pick</button>
</div>

</div>

<!-- Follow Modal -->
<div class="modal-bg" id="followModal" onclick="if(event.target===this)closeFollowModal()">
  <div class="modal" style="position:relative">
    <button class="modal-close" onclick="closeFollowModal()">✕</button>
    <div class="modal-title">Follow ${firstName}</div>
    <div class="modal-sub">Get his pick every Monday by text</div>
    <input type="tel" id="followPhone" placeholder="+1 (212) 555-1234" onkeydown="if(event.key==='Enter')submitFollow()">
    <button class="modal-btn" onclick="submitFollow()">Follow ${firstName} →</button>
    <div class="modal-msg" id="followMsg"></div>
  </div>
</div>

${ytId ? `<script src="https://www.youtube.com/iframe_api"></script>
<script>
var player;
function onYouTubeIframeAPIReady(){
  player=new YT.Player('player',{videoId:'${ytId}',playerVars:{rel:0,modestbranding:1,playsinline:1}});
}
</script>` : ''}

<script>
function vote(v){
  ['vMega','vHit','vDenied'].forEach(function(id){var b=document.getElementById(id);if(b)b.disabled=true;});
  var msg=document.getElementById('voteMsg');
  fetch('/api/vote',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({submission_id:${d.id},vote:v,page:'curator'})})
  .then(function(r){return r.json();})
  .then(function(){
    var labels={mega_hit:'🔥 Mega Hit recorded!',hit:'🎯 Hit recorded!',deny:'💀 Denied recorded!'};
    if(msg) msg.textContent=labels[v]||'Recorded!';
  })
  .catch(function(){
    if(msg)msg.textContent='Try again.';
    ['vMega','vHit','vDenied'].forEach(function(id){var b=document.getElementById(id);if(b)b.disabled=false;});
  });
}

function sharePick(){
  var url=window.location.href.split('?')[0]+'?ref=share';
  if(navigator.share){navigator.share({title:'${d.title} — ${d.artist}',text:'Is this an undeniable hit?',url:url});}
  else{navigator.clipboard.writeText(url).then(function(){document.getElementById('voteMsg').textContent='Link copied!';});}
}

function openFollowModal(){
  document.getElementById('followModal').classList.add('open');
  setTimeout(function(){document.getElementById('followPhone').focus();},100);
}

function closeFollowModal(){
  document.getElementById('followModal').classList.remove('open');
}

function submitFollow(){
  var phone=document.getElementById('followPhone').value.trim();
  var msg=document.getElementById('followMsg');
  if(!phone){document.getElementById('followPhone').style.borderColor='rgba(237,232,223,0.5)';return;}
  msg.textContent='...';
  fetch('/api/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({phone:phone,curator_id:${curator.id}})})
  .then(function(r){return r.json();})
  .then(function(data){
    if(data.message||data.ok||data.subscriber){
      msg.textContent='You are now following ${firstName} 🌙';
      document.getElementById('followPhone').disabled=true;
      document.querySelector('.modal-btn').disabled=true;
      document.querySelector('.modal-btn').textContent='✓ Following';
    } else {
      msg.textContent=data.error||'Something went wrong.';
    }
  })
  .catch(function(){msg.textContent='Network error. Try again.';});
}
</script>
</body>
</html>`);
  } catch(e) { res.status(500).send('<h1>Error: ' + e.message + '</h1>'); }
});


// ── Shared: submit modal HTML appended to all drop pages ─────────────────────
function submitModalHTML(genre) {
  return `
<div class="uht-submit-wrap">
  <div class="uht-submit-title">Do you have a hit you'd like to share?</div>
  <div class="uht-submit-copy">Submit it for a chance to be selected and shared with the community.</div>
  <button type="button" class="uht-submit-btn" onclick="openSubmitModal()">Submit a Hit</button>
</div>
<div class="uht-modal" id="uhtSubmitModal">
  <div class="uht-modal-card">
    <button onclick="closeSubmitModal()" class="uht-modal-close">×</button>
    <h2 class="uht-modal-title">Send your wildcard</h2>
    <form class="uht-form" id="uhtSubmitForm" onsubmit="submitHit(event,'${genre}')">
      <input type="text" id="uhtName" placeholder="Your Name" required>
      <input type="text" id="uhtPhone" placeholder="Phone Number" required>
      <input type="text" id="uhtArtist" placeholder="Artist Name" required>
      <input type="text" id="uhtSong" placeholder="Song Title" required>
      <input type="url" id="uhtLink" placeholder="YouTube Link (required)" required>
      <textarea id="uhtWhy" placeholder="Why is this a hit?" required></textarea>
      <button type="submit" class="uht-form-submit" id="uhtSubmitBtn">Submit</button>
    </form>
    <div id="uhtSubmitMsg" style="margin-top:12px;font-size:14px;opacity:.7;display:none"></div>
  </div>
</div>
<script>
function openSubmitModal(){document.getElementById('uhtSubmitModal').classList.add('show');document.body.style.overflow='hidden';}
function closeSubmitModal(){document.getElementById('uhtSubmitModal').classList.remove('show');document.body.style.overflow='';}
document.addEventListener('click',function(e){if(e.target===document.getElementById('uhtSubmitModal'))closeSubmitModal();});
document.addEventListener('keydown',function(e){if(e.key==='Escape')closeSubmitModal();});
async function submitHit(e, genre){
  e.preventDefault();
  var btn=document.getElementById('uhtSubmitBtn');
  btn.disabled=true; btn.textContent='Submitting...';
  try{
    var r=await fetch('/api/community-submissions',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        name:document.getElementById('uhtName').value,
        phone:document.getElementById('uhtPhone').value,
        artist:document.getElementById('uhtArtist').value,
        song:document.getElementById('uhtSong').value,
        youtube_url:document.getElementById('uhtLink').value,
        why:document.getElementById('uhtWhy').value,
        genre:genre
      })
    });
    if(!r.ok) throw new Error('Server error');
    document.getElementById('uhtSubmitForm').style.display='none';
    var msg=document.getElementById('uhtSubmitMsg');
    msg.textContent='Submitted. We appreciate the pick.';
    msg.style.display='block';
  }catch(err){
    btn.disabled=false; btn.textContent='Submit';
    alert('Something went wrong. Try again.');
  }
}
</script>`;
}

const submitModalCSS = `
.uht-submit-wrap{margin:16px auto 0;max-width:520px;padding:0 16px 16px;text-align:center;color:#f3f1ea;font-family:Georgia,"Times New Roman",serif}
.uht-submit-title{font-size:12px;letter-spacing:.18em;text-transform:uppercase;opacity:.7;margin-bottom:10px}
.uht-submit-copy{font-size:14px;line-height:1.6;opacity:.6;margin-bottom:20px}
.uht-submit-btn{appearance:none;background:rgba(255,255,255,.04);color:#f3f1ea;border:1px solid rgba(243,241,234,.22);padding:12px 22px;border-radius:999px;font-size:11px;letter-spacing:.18em;text-transform:uppercase;cursor:pointer;transition:.25s;font-family:inherit}
.uht-submit-btn:hover{background:#f3f1ea;color:#000}
.uht-modal{position:fixed;inset:0;background:rgba(0,0,0,.82);display:flex;align-items:center;justify-content:center;padding:20px;opacity:0;pointer-events:none;transition:.25s;z-index:9999}
.uht-modal.show{opacity:1;pointer-events:auto}
.uht-modal-card{position:relative;width:100%;max-width:520px;background:#050505;border:1px solid rgba(243,241,234,.16);border-radius:18px;padding:24px;color:#f3f1ea;text-align:center;font-family:Georgia,"Times New Roman",serif}
.uht-modal-close{position:absolute;top:12px;right:12px;background:none;border:none;color:#fff;font-size:18px;cursor:pointer}
.uht-modal-title{margin:0 0 18px;font-size:24px}
.uht-form{display:flex;flex-direction:column;gap:12px}
.uht-form input,.uht-form textarea{background:rgba(255,255,255,.04);border:1px solid rgba(243,241,234,.2);color:#fff;padding:12px;border-radius:10px;font-family:inherit}
.uht-form textarea{min-height:100px}
.uht-form-submit{background:#f3f1ea;color:#000;border:none;padding:12px;border-radius:999px;cursor:pointer}
`;

// ── GET /drop/community ───────────────────────────────────────────────────────
app.get('/drop/community', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM genre_submissions WHERE is_community_pick = TRUE ORDER BY created_at DESC LIMIT 1`
    );
    if (!rows.length) return res.status(404).send('<h1 style="font-family:sans-serif;color:#fff;background:#000;padding:40px">No community pick selected yet.</h1>');
    const d = rows[0];
    const ytId = d.youtube_url ? (d.youtube_url.match(/(?:v=|youtu\.be\/)([^&?/]+)/) || [])[1] : null;

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Undeniable Community Hit of the Week</title>
<style>
html,body{background:#000;margin:0;padding:0;overflow-x:hidden;font-family:Georgia,"Times New Roman",serif;color:#f3f1ea}
.uht-hit{background:#000;display:flex;flex-direction:column;padding:12px 0 0}
.uht-header{text-align:center;padding:0 14px;margin-bottom:14px}
.uht-label{font-size:11px;letter-spacing:.25em;opacity:.6;margin-bottom:10px;text-transform:uppercase}
.uht-title{margin:0;font-size:42px;line-height:1.05;font-weight:600}
.uht-sub{margin:16px 0 0}
.uht-song-name{display:block;font-size:24px;font-weight:600;opacity:.98}
.uht-artist-name{display:block;margin-top:4px;font-size:18px;opacity:.72}
.uht-note{margin-top:14px;font-size:17px;font-style:italic;opacity:.75}
.uht-badge{margin-top:10px;font-size:10px;letter-spacing:.3em;opacity:.45}
.uht-play{margin-top:12px;font-size:11px;letter-spacing:.3em;opacity:.6;transition:opacity .4s ease;text-transform:uppercase}
.uht-video{position:relative;width:100%;aspect-ratio:16/9}
#player{width:100%;height:100%}
.uht-end{position:absolute;inset:0;background:rgba(0,0,0,.82);display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:20px;opacity:0;pointer-events:none;transition:opacity .45s ease}
.uht-end.show{opacity:1;pointer-events:auto}
.uht-end p{margin:0 0 20px;font-size:20px;line-height:1.6}
.uht-replay{font-size:11px;letter-spacing:.25em;opacity:.7;border:1px solid rgba(255,255,255,.2);padding:10px 16px;cursor:pointer;transition:all .3s ease}
.uht-replay:hover{opacity:1;border-color:rgba(255,255,255,.5)}
.no-video{padding:40px 14px;text-align:center}
@media(min-width:768px){.uht-hit{align-items:center;padding:20px 0 60px}.uht-title{font-size:clamp(48px,6vw,82px)}.uht-song-name{font-size:32px}.uht-artist-name{font-size:20px}.uht-note{font-size:19px}.uht-video{max-width:1400px}.uht-end p{font-size:26px}}
${submitModalCSS}
</style>
</head>
<body>
<section class="uht-hit">
  <div class="uht-header">
    <div class="uht-label">WILDCARD</div>
    <h1 class="uht-title">Undeniable Community Hit of the Week</h1>
    <p class="uht-sub">
      <span class="uht-song-name">${d.title}</span>
      <span class="uht-artist-name">${d.artist}</span>
    </p>
    ${d.note ? `<p class="uht-note">${d.note}</p>` : ''}
    <div class="uht-badge">COMMUNITY PICK</div>
    ${ytId ? `<div class="uht-play" id="uhtPlay">Press Play.</div>` : ''}
  </div>
  ${ytId ? `
  <div class="uht-video">
    <div id="player"></div>
    <div class="uht-end" id="endMessage">
      <p>This one came from the community.<br><br>Got one of your own?</p>
      <div class="uht-replay" onclick="replayVideo()">REPLAY</div>
    </div>
  </div>` : `<div class="no-video"><p style="opacity:.4">No playback source available.</p></div>`}
</section>
${submitModalHTML('community')}
${ytId ? `
<script src="https://www.youtube.com/iframe_api"></script>
<script>
let player,shown=false,timerStarted=false;
function onYouTubeIframeAPIReady(){player=new YT.Player('player',{videoId:'${ytId}',playerVars:{rel:0,modestbranding:1,playsinline:1},events:{onStateChange:onPlayerStateChange}});}
function onPlayerStateChange(e){if(e.data===YT.PlayerState.PLAYING){var p=document.getElementById('uhtPlay');if(p)p.style.opacity='0';if(!timerStarted){timerStarted=true;setInterval(checkTime,500);}}}
function checkTime(){if(!player||shown)return;var c=player.getCurrentTime(),d=player.getDuration();if(d&&(d-c<=10)){document.getElementById('endMessage').classList.add('show');shown=true;}}
function replayVideo(){if(!player)return;player.seekTo(0);player.playVideo();document.getElementById('endMessage').classList.remove('show');shown=false;}
</script>` : ''}
</body>
</html>`);
  } catch(e) { res.status(500).send('<h1>Error: ' + e.message + '</h1>'); }
});

// ── PATCH /api/genre-submissions/:id/community-pick ──────────────────────────
app.patch('/api/genre-submissions/:id/community-pick', async (req, res) => {
  try {
    await db.query(`UPDATE genre_submissions SET is_community_pick = FALSE`);
    await db.query(`UPDATE genre_submissions SET is_community_pick = TRUE WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/community-submissions ──────────────────────────────────────────
app.post('/api/community-submissions', async (req, res) => {
  const { name, phone, artist, song, youtube_url, why, genre } = req.body;
  if (!artist || !song) return res.status(400).json({ error: 'artist and song required' });
  try {
    await db.query(
      `INSERT INTO community_submissions (name, phone, artist, song, youtube_url, why, genre)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [name||'', phone||'', artist, song, youtube_url||'', why||'', genre||'']
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/community-submissions ───────────────────────────────────────────
app.get('/api/community-submissions', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM community_submissions ORDER BY submitted_at DESC`
    );
    res.json({ submissions: rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/community-submissions/:id ────────────────────────────────────
app.delete('/api/community-submissions/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM community_submissions WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/migrate-community-pick ─────────────────────────────────────────
app.post('/api/migrate-community-pick', async (req, res) => {
  try {
    await db.query(`ALTER TABLE genre_submissions ADD COLUMN IF NOT EXISTS is_community_pick BOOLEAN DEFAULT FALSE`);
    await db.query(`
      CREATE TABLE IF NOT EXISTS community_submissions (
        id           SERIAL PRIMARY KEY,
        name         TEXT,
        phone        TEXT,
        artist       TEXT NOT NULL,
        song         TEXT NOT NULL,
        youtube_url  TEXT,
        why          TEXT,
        genre        TEXT,
        submitted_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /drop/:genre ─────────────────────────────────────────────────────────
app.get('/drop/:genre', async (req, res) => {
  const genre = req.params.genre.toLowerCase();
  try {
    const { rows } = await db.query(
      `SELECT gs.*,
         COUNT(*) FILTER (WHERE v.vote='hit') AS hits,
         COUNT(*) FILTER (WHERE v.vote='denied') AS denies
       FROM genre_submissions gs
       LEFT JOIN curator_submission_votes v ON v.submission_id = gs.id
       WHERE LOWER(gs.genre)=$1
       GROUP BY gs.id
       ORDER BY gs.drop_date DESC NULLS LAST, gs.created_at DESC`,
      [genre]
    );
    if (!rows.length) return res.status(404).send('<h1>No drop found for this genre.</h1>');
    const d = rows[0];
    const archive = rows.slice(1);
    const ytId = d.youtube_url ? (d.youtube_url.match(/(?:v=|youtu\.be\/)([^&?/]+)/) || [])[1] : null;
    const weekTitle = d.week_title || ('Undeniable ' + genre.charAt(0).toUpperCase() + genre.slice(1) + ' Hit of the Week');

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${weekTitle}</title>
<style>
html,body{background:#000;margin:0;padding:0;overflow-x:hidden;font-family:Georgia,"Times New Roman",serif;color:#f3f1ea}
.uht-hit{background:#000;display:flex;flex-direction:column;padding:36px 0 0}
.uht-header{text-align:center;padding:0 20px;margin-bottom:48px}
.uht-label{font-size:11px;letter-spacing:.25em;opacity:.6;margin-bottom:32px;text-transform:uppercase}
.uht-title{margin:0;font-size:42px;line-height:1.1;font-weight:600}
.uht-sub{margin:28px 0 0}
.uht-song-name{display:block;font-size:24px;font-weight:600;opacity:.98}
.uht-artist-name{display:block;margin-top:10px;font-size:18px;opacity:.72}
.uht-note{margin-top:24px;font-size:17px;font-style:italic;opacity:.75}
.uht-play{margin-top:24px;font-size:11px;letter-spacing:.3em;opacity:.6;transition:opacity .4s ease;text-transform:uppercase}
.uht-video{position:relative;width:100%;aspect-ratio:16/9;margin-top:8px}
#player{width:100%;height:100%}
.uht-end{position:absolute;inset:0;background:rgba(0,0,0,.82);display:flex;align-items:center;justify-content:center;text-align:center;padding:20px;opacity:0;pointer-events:none;transition:opacity .45s ease}
.uht-end.show{opacity:1;pointer-events:all}
.uht-end p{margin:0;font-size:20px;line-height:1.6}
.below-player{padding:16px 20px 8px;display:flex;flex-direction:column;align-items:center;gap:8px}
.sp-whisper{font-size:9px;letter-spacing:.22em;text-transform:uppercase;color:rgba(243,241,234,0.2);cursor:pointer;background:none;border:none;font-family:Georgia,serif;padding:0;text-align:center}
.sp-whisper:hover{color:rgba(243,241,234,0.45)}
.vote-section{padding:36px 24px 24px;text-align:center}
.vote-label{font-size:9px;letter-spacing:.35em;text-transform:uppercase;color:rgba(243,241,234,0.45);margin-bottom:20px}
.vote-row{display:flex;flex-direction:column;gap:10px;align-items:center}
.vote-btn{width:100%;max-width:320px;padding:20px;border-radius:12px;border:1px solid rgba(255,255,255,0.09);background:rgba(255,255,255,0.025);color:rgba(243,241,234,0.75);font-family:Georgia,serif;font-size:16px;cursor:pointer;transition:all .25s;letter-spacing:.03em}
.vote-btn:hover{background:#f3f1ea;border-color:#f3f1ea;color:#000;transform:translateY(-2px)}
.vote-btn:disabled{opacity:.2;cursor:default;transform:none}
.vote-btn.voted{background:#f3f1ea;border-color:#f3f1ea;color:#000}
.vote-msg{text-align:center;font-size:13px;letter-spacing:.15em;text-transform:uppercase;color:#f3f1ea;min-height:28px;padding:16px 0 0;opacity:0;transition:opacity .4s ease}
.vote-msg.show{opacity:1}
@keyframes pulse{0%{transform:scale(1)}50%{transform:scale(1.03)}100%{transform:scale(1)}}
.vote-btn.pulse{animation:pulse .3s ease}
@keyframes slideUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}
.slide-up{animation:slideUp .5s ease forwards}
.sp-whisper{font-size:9px;letter-spacing:.22em;text-transform:uppercase;color:rgba(243,241,234,0.2);cursor:pointer;background:none;border:none;font-family:Georgia,serif;padding:0;text-align:center;width:100%}
@media(min-width:768px){.vote-row{flex-direction:row;justify-content:center}.vote-btn{width:auto;flex:1}}
.uht-footer{text-align:center;padding:32px 20px 32px;font-size:9px;letter-spacing:.3em;text-transform:uppercase;opacity:.2;color:#f3f1ea}
.archive-section{padding:48px 24px 0;max-width:640px;margin:0 auto;width:100%}
.archive-heading{font-size:9px;letter-spacing:.35em;text-transform:uppercase;color:rgba(243,241,234,0.3);text-align:center;margin-bottom:36px}
.archive-card{border-top:1px solid rgba(243,241,234,0.08);padding:32px 0 0;margin-bottom:40px}
.archive-card-meta{font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:rgba(243,241,234,0.3);margin-bottom:10px}
.archive-card-title{font-size:22px;font-weight:600;margin:0 0 4px}
.archive-card-artist{font-size:15px;opacity:.55;margin:0 0 16px}
.archive-card-note{font-size:14px;font-style:italic;opacity:.5;margin:0 0 16px}
.archive-video{position:relative;width:100%;aspect-ratio:16/9;margin-bottom:16px}
.archive-video iframe,.archive-video div{width:100%;height:100%}
.archive-votes-row{display:flex;flex-direction:column;gap:8px;align-items:center;margin-bottom:8px}
.archive-vote-btn{width:100%;max-width:320px;padding:16px;border-radius:12px;border:1px solid rgba(255,255,255,0.09);background:rgba(255,255,255,0.025);color:rgba(243,241,234,0.75);font-family:Georgia,serif;font-size:15px;cursor:pointer;transition:all .25s}
.archive-vote-btn:hover{background:#f3f1ea;border-color:#f3f1ea;color:#000;transform:translateY(-2px)}
.archive-vote-btn:disabled{opacity:.2;cursor:default;transform:none}
.archive-vote-btn.voted{background:#f3f1ea;border-color:#f3f1ea;color:#000}
.archive-tally{text-align:center;font-size:11px;letter-spacing:.1em;opacity:.35;padding:8px 0 0}
.archive-vote-msg{text-align:center;font-size:12px;letter-spacing:.15em;text-transform:uppercase;color:#f3f1ea;min-height:20px;opacity:0;transition:opacity .4s ease;padding:8px 0 0}
.archive-vote-msg.show{opacity:1}
.next-drop-btn{display:none;margin:20px auto 0;width:100%;max-width:320px;padding:16px;border-radius:12px;border:1px solid rgba(255,255,255,0.15);background:none;color:#f3f1ea;font-family:Georgia,serif;font-size:14px;letter-spacing:.08em;cursor:pointer;transition:all .25s}
.next-drop-btn:hover{background:#f3f1ea;color:#000;border-color:#f3f1ea}
.next-drop-btn.show{display:block;animation:slideUp .4s ease forwards}
.share-btn{display:none;margin:20px auto 0;width:100%;max-width:320px;padding:16px;border-radius:12px;border:1px solid rgba(255,255,255,0.2);background:none;color:#f3f1ea;font-family:Georgia,serif;font-size:14px;letter-spacing:.1em;cursor:pointer;transition:all .25s}
.share-btn:hover{background:#f3f1ea;color:#000;border-color:#f3f1ea}
.share-btn.show{display:block;animation:slideUp .4s ease forwards}
.no-video{padding:40px 14px;text-align:center}
.spotify-btn{display:inline-block;margin-top:16px;padding:12px 28px;border-radius:999px;background:#1DB954;color:#fff;text-decoration:none;font-size:15px;letter-spacing:1px}
${submitModalCSS}
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
    <h1 class="uht-title">${weekTitle}</h1>
    <p class="uht-sub">
      <span class="uht-song-name">${d.title}</span>
      <span class="uht-artist-name">${d.artist}</span>
    </p>
    ${d.note ? `<p class="uht-note">${d.note}</p>` : ''}
  </div>

  ${ytId ? `
  <div class="uht-video">
    <div id="player"></div>
    <div class="uht-end" id="endMessage">
      <p>This one's yours.<br><br>Your next hit arrives via text next Friday.</p>
    </div>
  </div>` : `
  <div class="no-video">
    ${d.spotify_url ? `<a class="spotify-btn" href="${d.spotify_url}" target="_blank">🎵 Play on Spotify</a>` : '<p style="opacity:.4">No playback source available.</p>'}
  </div>`}

  ${ytId && d.spotify_url ? `
  <div class="below-player">
    <button class="sp-whisper" onclick="var w=document.getElementById('spWrap');w.style.display=w.style.display==='none'?'block':'none'">Prefer Spotify?</button>
    <div id="spWrap" style="display:none">
      <iframe style="border-radius:10px;display:block" src="https://open.spotify.com/embed/track/${(d.spotify_url.match(/track\/([a-zA-Z0-9]+)/)||[])[1]}" width="100%" height="152" frameBorder="0" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" loading="lazy"></iframe>
    </div>
  </div>` : ''}

  <div class="vote-section">
    <div class="vote-label">Is this an undeniable hit?</div>
    <div class="vote-row">
      <button class="vote-btn" id="vMega" onclick="castVote('mega_hit')">🔥 Mega Hit</button>
      <button class="vote-btn" id="vHit" onclick="castVote('hit')">🎯 Hit</button>
      <button class="vote-btn" id="vDenied" onclick="castVote('denied')">💀 Denied</button>
    </div>
    <div class="vote-msg" id="voteConfirm"></div>
    <button class="share-btn" id="shareBtn" onclick="shareVote()">↗ Share this pick</button>
  </div>
</section>

${ytId ? `
<script src="https://www.youtube.com/iframe_api"></script>
<script>
let player, shown=false, timerStarted=false;
function onYouTubeIframeAPIReady(){
  player = new YT.Player('player',{
    videoId:'${ytId}',
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
</script>` : ''}

<script>
function castVote(type){
  var btnMap={mega_hit:'vMega',hit:'vHit',denied:'vDenied'};
  var voted=document.getElementById(btnMap[type]);
  if(voted){voted.classList.add('voted','pulse');setTimeout(function(){voted.classList.remove('pulse');},300);}
  ['vMega','vHit','vDenied'].forEach(function(id){var b=document.getElementById(id);if(b)b.disabled=true;});
  var labels={mega_hit:'🔥 Mega Hit recorded!',hit:'🎯 Hit recorded!',denied:'💀 Denied recorded!'};
  var shareLabels={mega_hit:'🔥 Mega Hit —',hit:'🎯 Hit —',denied:'💀 Denied —'};
  _voteLabel=shareLabels[type]||'I voted on';
  var msg=document.getElementById('voteConfirm');
  msg.textContent=labels[type]||'Recorded!';
  setTimeout(function(){msg.classList.add('show');},100);
  setTimeout(function(){document.getElementById('shareBtn').classList.add('show');},400);
  setTimeout(function(){
    var pv=document.getElementById('post-vote');
    pv.style.display='block';
    pv.classList.add('slide-up');
    var arc=document.getElementById('archive-section');
    if(arc){setTimeout(function(){arc.style.display='block';arc.classList.add('slide-up');},400);}
  },600);
  fetch('/api/genre-vote', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({submission_id:${d.id}, vote:type})
  }).then(function(r){if(!r.ok)r.json().then(function(e){console.error('[vote error]',e);});})
    .catch(function(e){console.error('[vote network error]',e);});
}
var _voteLabel='';
function shareVote(){
  var url=window.location.href.split('?')[0];
  var text=_voteLabel+' '+${JSON.stringify(d.title)}+' by '+${JSON.stringify(d.artist)}+' — what do you think?\\n'+url;
  if(navigator.share){
    navigator.share({title:${JSON.stringify(weekTitle)},text:text,url:url}).catch(function(){});
  } else {
    navigator.clipboard.writeText(text).then(function(){
      var btn=document.getElementById('shareBtn');
      btn.textContent='Copied!';
      setTimeout(function(){btn.textContent='↗ Share this pick';},2000);
    });
  }
}
</script>
<div id="post-vote" style="display:none"></div>

${archive.length ? `
<div class="archive-section" id="archive-section" style="display:none">
  <div class="archive-heading">Previous Drops</div>
  ${archive.map((a, i) => {
    const aYtId = a.youtube_url ? (a.youtube_url.match(/(?:v=|youtu\.be\/)([^&?/]+)/) || [])[1] : null;
    const total = parseInt(a.hits||0) + parseInt(a.denies||0);
    const hitPct = total ? Math.round(parseInt(a.hits||0)/total*100) : null;
    const nextId = i + 1 < archive.length ? `arc-${archive[i+1].id}` : 'arc-end';
    return `
  <div class="archive-card" id="arc-${a.id}">
    <div class="archive-card-meta">${(() => { const dt = a.drop_date || a.created_at; if(!dt) return 'Previous Drop'; const d = new Date(dt); return 'Week of ' + d.toLocaleDateString('en-US',{month:'short',day:'numeric'}); })()}</div>
    <div class="archive-card-title">${a.title}</div>
    <div class="archive-card-artist">${a.artist}</div>
    ${a.note ? `<div class="archive-card-note">"${a.note}"</div>` : ''}
    ${aYtId ? `
    <div class="archive-video">
      <iframe src="https://www.youtube.com/embed/${aYtId}?rel=0&modestbranding=1" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen loading="lazy"></iframe>
    </div>` : ''}
    <div class="archive-votes-row" id="avr-${a.id}">
      <button class="archive-vote-btn" onclick="archiveVote(${a.id},'mega_hit',this,'${nextId}')">🔥 Mega Hit</button>
      <button class="archive-vote-btn" onclick="archiveVote(${a.id},'hit',this,'${nextId}')">🎯 Hit</button>
      <button class="archive-vote-btn" onclick="archiveVote(${a.id},'denied',this,'${nextId}')">💀 Denied</button>
    </div>
    <div class="archive-vote-msg" id="avm-${a.id}"></div>
    ${hitPct !== null ? `<div class="archive-tally">${hitPct}% said Hit · ${total} vote${total===1?'':'s'}</div>` : ''}
    <button class="next-drop-btn" id="nxt-${a.id}" onclick="scrollToNext('${nextId}')">Next Drop →</button>
  </div>`;
  }).join('')}
  <div id="arc-end">${submitModalHTML(genre)}</div>
  <div class="uht-footer">UHT · Your next hit arrives Friday</div>
</div>` : `
<div id="arc-end">${submitModalHTML(genre)}</div>
<div class="uht-footer">UHT · Your next hit arrives Friday</div>
`}

<script>
function archiveVote(id, type, btn, nextId){
  var row = document.getElementById('avr-'+id);
  var msg = document.getElementById('avm-'+id);
  var nxt = document.getElementById('nxt-'+id);
  row.querySelectorAll('button').forEach(function(b){b.disabled=true;});
  btn.classList.add('voted');
  var labels={mega_hit:'🔥 Mega Hit recorded!',hit:'🎯 Hit recorded!',denied:'💀 Denied recorded!'};
  msg.textContent = labels[type]||'Recorded!';
  setTimeout(function(){msg.classList.add('show');},100);
  setTimeout(function(){if(nxt)nxt.classList.add('show');},400);
  fetch('/api/genre-vote',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({submission_id:id,vote:type})
  }).catch(function(e){console.error(e);});
}
function scrollToNext(targetId){
  var el=document.getElementById(targetId);
  if(el){el.scrollIntoView({behavior:'smooth',block:'start'});}
}
</script>
</body>
</html>`);
  } catch(e) { res.status(500).send('<h1>Error: ' + e.message + '</h1>'); }
});


// ── POST /api/genre-vote ─────────────────────────────────────
app.post('/api/genre-vote', async (req, res) => {
  const { submission_id, vote } = req.body;
  if (!submission_id || !vote) {
    return res.status(400).json({ error: 'submission_id and vote are required.' });
  }
  const dbVote = vote === 'mega_hit' ? 'hit' : vote === 'deny' ? 'denied' : vote;
  if (!['hit', 'denied'].includes(dbVote)) {
    return res.status(400).json({ error: 'vote must be hit, denied, mega_hit, or deny.' });
  }
  // Compute voter fingerprint from IP + user agent
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
  const ua = req.headers['user-agent'] || '';
  const voterHash = require('crypto').createHash('sha256').update(ip + ua).digest('hex');
  try {
    const { rows } = await db.query(
      `INSERT INTO curator_submission_votes (submission_id, vote, voter_hash)
       VALUES ($1, $2, $3)
       ON CONFLICT (submission_id, voter_hash) WHERE voter_hash IS NOT NULL
       DO NOTHING RETURNING *`,
      [submission_id, dbVote, voterHash]
    );
    if (rows.length === 0) {
      return res.json({ ok: true, duplicate: true });
    }
    res.json({ ok: true, vote: rows[0] });
  } catch (e) {
    console.error('[genre-vote error]', e.message);
    res.status(500).json({ error: e.message });
  }
});



// =============================================================================
// ADMIN API ROUTES  (used by admin.html)
// =============================================================================

// ── GET /api/songs ────────────────────────────────────────────────────────────
app.get('/api/songs', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT s.*, 
        COALESCE(c.name, g.name) AS target_name
      FROM songs s
      LEFT JOIN curators c ON c.id = s.curator_id
      LEFT JOIN genres   g ON g.id = s.genre_id
      ORDER BY s.id DESC
    `);
    res.json({ songs: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/songs ───────────────────────────────────────────────────────────
app.post('/api/songs', async (req, res) => {
  const { title, artist, url, genre_id, curator_id } = req.body;
  if (!title || !artist) return res.status(400).json({ error: 'title and artist required.' });
  try {
    const { rows } = await db.query(
      `INSERT INTO songs (title, artist, url, genre_id, curator_id)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [title, artist, url || null, genre_id || null, curator_id || null]
    );
    res.json({ song: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/songs/:id ─────────────────────────────────────────────────────
app.delete('/api/songs/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM songs WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/genres-admin (with counts) ──────────────────────────────────────
app.get('/api/genres-admin', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT g.*,
        COUNT(DISTINCT s.id)  AS song_count,
        COUNT(DISTINCT sb.id) AS sub_count
      FROM genres g
      LEFT JOIN songs s ON s.genre_id = g.id
      LEFT JOIN subscriptions sb ON sb.genre_id = g.id
      GROUP BY g.id ORDER BY g.name
    `);
    res.json({ genres: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/genres ──────────────────────────────────────────────────────────
app.post('/api/genres', async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required.' });
  try {
    const { rows } = await db.query(
      `INSERT INTO genres (name) VALUES ($1) RETURNING *`, [name]
    );
    res.json({ genre: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/genres/:id ────────────────────────────────────────────────────
app.delete('/api/genres/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM genres WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/curators-admin (with counts) ────────────────────────────────────
app.get('/api/curators-admin', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT c.*,
        COUNT(DISTINCT s.id)  AS song_count,
        COUNT(DISTINCT sb.id) AS sub_count,
        COUNT(DISTINCT f.id)  AS follower_count
      FROM curators c
      LEFT JOIN songs s ON s.curator_id = c.id
      LEFT JOIN subscriptions sb ON sb.curator_id = c.id
      LEFT JOIN follows f ON f.curator_id = c.id
      GROUP BY c.id ORDER BY c.name
    `);
    res.json({ curators: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/curators ────────────────────────────────────────────────────────
app.post('/api/curators', async (req, res) => {
  const { name, bio, image_url, instagram, curator_month, monthly_theme } = req.body;
  if (!name) return res.status(400).json({ error: 'name required.' });
  try {
    const { rows } = await db.query(
      `INSERT INTO curators (name, bio, image_url, instagram, curator_month, monthly_theme) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [name, bio || null, image_url || null, instagram || null, curator_month || null, monthly_theme || null]
    );
    res.json({ curator: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/curators/:id ──────────────────────────────────────────────────
app.delete('/api/curators/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM curators WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/subscribers (joined with target name) ────────────────────────────
app.get('/api/subscribers', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT sb.*, u.phone, u.name, u.email,
        COALESCE(c.name, g.name) AS target_name
      FROM subscriptions sb
      JOIN users u ON u.id = sb.user_id
      LEFT JOIN curators c ON c.id = sb.curator_id
      LEFT JOIN genres   g ON g.id = sb.genre_id
      ORDER BY sb.id DESC
    `);
    res.json({ subscribers: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/subscribers/:id  (pause/resume) ───────────────────────────────
app.patch('/api/subscribers/:id', async (req, res) => {
  const { is_active } = req.body;
  try {
    await db.query('UPDATE subscriptions SET is_active=$1 WHERE id=$2', [is_active, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/subscribers/:id ───────────────────────────────────────────────
app.delete('/api/subscribers/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM subscriptions WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ── PATCH /api/users/:id (update name + email) ───────────────────────────────
app.patch('/api/users/:id', async (req, res) => {
  const { name, email } = req.body;
  try {
    await db.query('UPDATE users SET name=$1, email=$2 WHERE id=$3', [name, email, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/messages/test ───────────────────────────────────────────────────
app.post('/api/messages/test', async (req, res) => {
  const { to, message } = req.body;
  if (!to || !message) return res.status(400).json({ error: 'to and message required' });
  try {
    const msg = await twilioClient.messages.create({
      body: message,
      from: process.env.TWILIO_FROM,
      to: to
    });
    res.json({ ok: true, sid: msg.sid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/messages/send  (broadcast to all active subscribers) ────────────
app.post('/api/messages/send', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  try {
    const { rows } = await db.query(
      `SELECT DISTINCT u.phone FROM subscriptions sb JOIN users u ON u.id = sb.user_id WHERE sb.is_active = true`
    );
    const results = await Promise.allSettled(
      rows.map(async (row) => {
        const msg = await twilioClient.messages.create({
          body: message,
          from: process.env.TWILIO_FROM,
          to: row.phone,
        });
        await db.query(
          `INSERT INTO sms_log (to_phone, body, status) VALUES ($1, $2, $3)`,
          [row.phone, message, msg.status]
        );
        return msg.sid;
      })
    );
    const sent = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;
    res.json({ ok: true, sent, failed });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/messages  (recent broadcast log) ─────────────────────────────────
app.get('/api/messages', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT to_phone AS "to", body, status, sent_at FROM sms_log ORDER BY sent_at DESC LIMIT 100`
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/deliveries  (recent 50, joined) ──────────────────────────────────
app.get('/api/deliveries', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT d.*, u.phone, s.title, s.artist, v.vote
      FROM deliveries d
      JOIN users u ON u.id = d.user_id
      JOIN songs s ON s.id = d.song_id
      LEFT JOIN votes v ON v.delivery_id = d.id
      ORDER BY d.sent_at DESC
      LIMIT 50
    `);
    res.json({ deliveries: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/votes ────────────────────────────────────────────────────────────
app.get('/api/votes', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT v.*, u.phone, s.title, s.artist
      FROM votes v
      JOIN users u ON u.id = v.user_id
      JOIN songs s ON s.id = v.song_id
      ORDER BY v.updated_at DESC
    `);
    res.json({ votes: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/curators/:id ───────────────────────────────────────────────────
app.patch('/api/curators/:id', async (req, res) => {
  console.log('PATCH body:', req.body);
  const { name, bio, image_url, instagram, curator_month, monthly_theme } = req.body;
  if (!name) return res.status(400).json({ error: 'name required.' });
  try {
    const { rows } = await db.query(
      `UPDATE curators SET name=$1, bio=$2, image_url=$3, instagram=$4, curator_month=$5, monthly_theme=$6 WHERE id=$7 RETURNING *`,
      [name, bio || null, image_url || null, instagram || null, curator_month || null, monthly_theme || null, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Curator not found.' });
    res.json({ curator: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ── POST /api/vote ────────────────────────────────────────────
app.post('/api/vote', async (req, res) => {
  const { subscriber_id, curator_id, playlist_id, song_id, vote_type } = req.body;
  if (!subscriber_id || !song_id || !vote_type) {
    return res.status(400).json({ error: 'subscriber_id, song_id, and vote_type are required.' });
  }
  if (!['hit', 'deny', 'mega_hit'].includes(vote_type)) {
    return res.status(400).json({ error: 'vote_type must be hit, deny, or mega_hit.' });
  }
  try {
    const { rows } = await db.query(`
      INSERT INTO song_votes (subscriber_id, curator_id, playlist_id, song_id, vote_type)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (subscriber_id, song_id, playlist_id)
      DO UPDATE SET vote_type = EXCLUDED.vote_type, created_at = NOW()
      RETURNING *
    `, [subscriber_id, curator_id || null, playlist_id || null, song_id, vote_type === 'mega_hit' ? 'ultra_hit' : vote_type]);
    res.json({ vote: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/curators/:id/stats ───────────────────────────────
app.get('/api/curators/:id/stats', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM curator_stats WHERE curator_id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Curator not found.' });
    res.json({ stats: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Leaderboard query (aggregates from curator_submission_votes) ──────────────
function leaderboardQuery() {
  return `
    SELECT
      c.id                                                          AS curator_id,
      c.name                                                        AS curator_name,
      c.image_url,
      COUNT(CASE WHEN v.vote = 'hit'    THEN 1 END)                AS total_hits,
      COUNT(CASE WHEN v.vote = 'denied' THEN 1 END)                AS total_denies,
      COUNT(v.id)                                                   AS total_votes,
      CASE WHEN COUNT(v.id) = 0 THEN 0
        ELSE ROUND(COUNT(CASE WHEN v.vote = 'hit' THEN 1 END)::NUMERIC / COUNT(v.id) * 100, 1)
      END                                                           AS hit_rate
    FROM curators c
    LEFT JOIN curator_submissions cs ON cs.curator_id = c.id
    LEFT JOIN curator_submission_votes v ON v.submission_id = cs.id
    GROUP BY c.id, c.name, c.image_url
    HAVING COUNT(v.id) >= 1
    ORDER BY hit_rate DESC
  `;
}

// ── GET /api/curators/leaderboard ────────────────────────────
app.get('/api/curators/leaderboard', async (req, res) => {
  try {
    const { rows } = await db.query(leaderboardQuery());
    res.json({ leaderboard: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /leaderboard ─────────────────────────────────────────────────────────
app.get('/leaderboard', async (req, res) => {
  try {
    const { rows } = await db.query(leaderboardQuery());
    const cards = rows.map((c, i) => {
      const slug = c.curator_name.toLowerCase().replace(/\s+/g, '-');
      const hitPct = c.hit_rate ?? 0;
      const rank = i + 1;
      const medal = rank === 1 ? '◈' : rank === 2 ? '◉' : rank === 3 ? '◎' : `${rank}`;
      return `
      <a class="card" href="/drop/curator/${slug}">
        <div class="rank">${medal}</div>
        <div class="avatar">${c.image_url
          ? `<img src="${c.image_url}" alt="${c.curator_name}">`
          : `<span>🎧</span>`}</div>
        <div class="info">
          <div class="name">${c.curator_name}</div>
          <div class="bar-wrap"><div class="bar" style="width:${hitPct}%"></div></div>
          <div class="votes">${hitPct}% hit rate &middot; ${c.total_votes} votes &middot; ${c.total_hits} HIT &middot; ${c.total_denies} DENIED</div>
        </div>
        <div class="pct">${hitPct}<span>%</span></div>
      </a>`;
    }).join('');

    const empty = rows.length === 0
      ? `<p class="empty">Not enough votes yet. Be the first to vote.</p>`
      : '';

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hit Theory Leaderboard — UHT</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;1,400&family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0d0d0d;--surface:#141414;--border:rgba(255,255,255,0.07);--ink:#ede8df;--muted:rgba(237,232,223,0.38);--accent:#c0392b;--green:#27ae60;--serif:'Playfair Display',Georgia,serif;--sans:'Inter',sans-serif}
html,body{background:var(--bg);color:var(--ink);font-family:var(--sans);min-height:100vh}
header{padding:48px 24px 12px;text-align:center;border-bottom:1px solid var(--border)}
.eyebrow{font-size:10px;letter-spacing:.3em;text-transform:uppercase;color:var(--accent);margin-bottom:12px}
h1{font-family:var(--serif);font-size:clamp(28px,5vw,48px);font-weight:400;line-height:1.15}
.subtitle{font-size:13px;color:var(--muted);margin-top:10px;letter-spacing:.04em}
main{max-width:680px;margin:0 auto;padding:40px 16px 80px}
.card{display:flex;align-items:center;gap:16px;padding:18px 20px;background:var(--surface);border:1px solid var(--border);border-radius:10px;margin-bottom:12px;text-decoration:none;color:inherit;transition:border-color .2s,background .2s}
.card:hover{border-color:rgba(255,255,255,0.18);background:#1a1a1a}
.rank{font-family:var(--serif);font-size:22px;width:32px;text-align:center;color:var(--accent);flex-shrink:0}
.avatar{width:52px;height:52px;border-radius:50%;overflow:hidden;border:1px solid var(--border);flex-shrink:0;display:flex;align-items:center;justify-content:center;background:var(--bg);font-size:22px}
.avatar img{width:100%;height:100%;object-fit:cover}
.info{flex:1;min-width:0}
.name{font-family:var(--serif);font-size:17px;margin-bottom:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bar-wrap{height:3px;background:rgba(255,255,255,0.06);border-radius:2px;margin-bottom:7px}
.bar{height:100%;background:var(--accent);border-radius:2px;transition:width .6s ease}
.votes{font-size:11px;color:var(--muted);letter-spacing:.03em}
.pct{font-family:var(--serif);font-size:28px;color:var(--accent);flex-shrink:0;text-align:right;line-height:1}
.pct span{font-size:14px}
.empty{text-align:center;color:var(--muted);font-size:14px;padding:60px 0}
footer{text-align:center;padding:24px;font-size:11px;color:var(--muted);letter-spacing:.1em;border-top:1px solid var(--border)}
</style>
</head>
<body>
<header>
  <div class="eyebrow">Undeniable Hit Theory</div>
  <h1>Hit Theory<br><em>Leaderboard</em></h1>
  <p class="subtitle">Ranked by hit rate &middot; minimum 5 votes to qualify</p>
</header>
<main>
  ${empty}
  ${cards}
</main>
<footer>UHT &mdash; Silver Glider Line &middot; +1 (844) 261-6758</footer>
</body>
</html>`);
  } catch (e) { res.status(500).send('<h1>Error: ' + e.message + '</h1>'); }
});

// ── POST /api/playlists ───────────────────────────────────────
app.post('/api/playlists', async (req, res) => {
  const { curator_id, theme, week } = req.body;
  if (!curator_id || !theme) return res.status(400).json({ error: 'curator_id and theme required.' });
  try {
    const { rows } = await db.query(
      'INSERT INTO playlists (curator_id, theme, week) VALUES ($1, $2, $3) RETURNING *',
      [curator_id, theme, week || 1]
    );
    res.json({ playlist: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/playlists/:id/songs ─────────────────────────────
app.post('/api/playlists/:id/songs', async (req, res) => {
  const { song_id, curator_note, position } = req.body;
  if (!song_id) return res.status(400).json({ error: 'song_id required.' });
  try {
    const { rows } = await db.query(
      'INSERT INTO playlist_songs (playlist_id, song_id, curator_note, position) VALUES ($1, $2, $3, $4) RETURNING *',
      [req.params.id, song_id, curator_note || null, position || 1]
    );
    res.json({ playlist_song: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/playlists/:id ────────────────────────────────────
app.get('/api/playlists/:id', async (req, res) => {
  try {
    const playlist = await db.query(`
      SELECT p.*, c.name AS curator_name, c.instagram AS curator_instagram
      FROM playlists p LEFT JOIN curators c ON c.id = p.curator_id
      WHERE p.id = $1
    `, [req.params.id]);
    if (!playlist.rows.length) return res.status(404).json({ error: 'Playlist not found.' });
    const songs = await db.query(`
      SELECT ps.*, s.title, s.artist
      FROM playlist_songs ps LEFT JOIN songs s ON s.id = ps.song_id
      WHERE ps.playlist_id = $1 ORDER BY ps.position ASC
    `, [req.params.id]);
    res.json({ playlist: playlist.rows[0], songs: songs.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/curators/:id/scorecard', async (req, res) => {
  try {
    const id = req.params.id;
    const stats = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE v.vote='hit')    AS mega_hits,
        COUNT(*) FILTER (WHERE v.vote='hit')    AS hits,
        COUNT(*) FILTER (WHERE v.vote='denied') AS denies,
        COUNT(*)                                AS total,
        ROUND(
          100.0 * COUNT(*) FILTER (WHERE v.vote='hit')
          / NULLIF(COUNT(*),0), 1
        ) AS hit_rate
      FROM curator_submissions cs
      LEFT JOIN curator_submission_votes v ON v.submission_id = cs.id
      WHERE cs.curator_id=$1`, [id]);

    const submissions = await db.query(`
      SELECT cs.*,
        COUNT(*) FILTER (WHERE v.vote='hit')    AS mega_hits,
        COUNT(*) FILTER (WHERE v.vote='hit')    AS hits,
        COUNT(*) FILTER (WHERE v.vote='denied') AS denies
      FROM curator_submissions cs
      LEFT JOIN curator_submission_votes v ON v.submission_id = cs.id
      WHERE cs.curator_id=$1
      GROUP BY cs.id
      ORDER BY cs.week_number DESC, cs.submitted_at DESC`, [id]);

    // Combined lifetime hits from both SMS votes and web votes
    const combinedHits = await db.query(`
      SELECT
        COALESCE((
          SELECT COUNT(*) FROM song_votes
          WHERE curator_id=$1 AND vote_type IN ('hit','mega_hit','ultra_hit')
        ),0)
        +
        COALESCE((
          SELECT COUNT(*) FROM curator_submission_votes
          WHERE submission_id IN (
            SELECT id FROM curator_submissions WHERE curator_id=$1
          ) AND vote='hit'
        ),0) AS total_hits
    `, [id]);

    const totalHits = parseInt(combinedHits.rows[0].total_hits, 10);
    const tier =
      totalHits >= 28 ? '🏆 Legend' :
      totalHits >= 18 ? '👑 Tastemaker' :
      totalHits >= 8  ? '🎯 Hit Hunter' :
                        '🌙 Rising Curator';

    res.json({ stats: stats.rows[0], submissions: submissions.rows, totalHits, tier });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/test-new', (req, res) => res.json({ ok: true }));

// ── One-time migration: create genre_submissions table ───────────────────────
app.post('/api/migrate-genre-submissions', async (req, res) => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS genre_submissions (
        id          SERIAL PRIMARY KEY,
        genre       TEXT NOT NULL,
        week_title  TEXT,
        title       TEXT NOT NULL,
        artist      TEXT NOT NULL,
        note        TEXT,
        youtube_url TEXT,
        spotify_url TEXT,
        week_number INT DEFAULT 1,
        drop_date   DATE,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── One-time migration: add curator_month + monthly_theme columns ─────────────
app.post('/api/migrate-curator-fields', async (req, res) => {
  try {
    await db.query(`ALTER TABLE curators ADD COLUMN IF NOT EXISTS curator_month TEXT`);
    await db.query(`ALTER TABLE curators ADD COLUMN IF NOT EXISTS monthly_theme TEXT`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
require('./curator-scheduler');

app.listen(PORT, () => {
  console.log(`\nUHT server running on port ${PORT}`);
  console.log(`  API:     GET  http://localhost:${PORT}/api/genres`);
  console.log(`  API:     GET  http://localhost:${PORT}/api/curators`);
  console.log(`  API:     POST http://localhost:${PORT}/api/subscribe`);
  console.log(`  Webhook: POST http://localhost:${PORT}/sms\n`);
});
