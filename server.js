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

// ── Startup migrations ────────────────────────────────────────────────────────
db.query('ALTER TABLE curators ADD COLUMN IF NOT EXISTS playlist_image_url TEXT')
  .then(() => console.log('[Migration] playlist_image_url column ready'))
  .catch(e => console.error('[Migration] playlist_image_url:', e.message));

db.query('ALTER TABLE songs ADD COLUMN IF NOT EXISTS youtube_url TEXT')
  .then(() => console.log('[Migration] songs.youtube_url column ready'))
  .catch(e => console.error('[Migration] songs.youtube_url:', e.message));

// Make deliveries.song_id cascade on delete so songs can be removed freely
db.query(`ALTER TABLE deliveries DROP CONSTRAINT IF EXISTS deliveries_song_id_fkey`)
  .then(() => db.query(`ALTER TABLE deliveries ADD CONSTRAINT deliveries_song_id_fkey FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE`))
  .then(() => console.log('[Migration] deliveries FK cascade ready'))
  .catch(e => console.error('[Migration] deliveries FK cascade:', e.message));

const app  = express();
const PORT = process.env.PORT || 3000;

// CORS — WordPress PHP makes server-side calls, so open is fine.
// Restrict via ALLOWED_ORIGIN env var if needed.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Twilio sends form-encoded; WP plugin sends JSON
app.use(express.urlencoded({ extended: false, limit: "50mb" }));
app.use(express.json({ limit: "50mb" }));
app.use(require("express").static(require("path").join(__dirname, "public")));

// Admin panel
app.get("/admin", (req, res) => res.sendFile(require("path").join(__dirname, "public", "admin.html")));

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'UHT SMS Platform running', version: '1.0.0', deploy: 'apr24-v28' });
});

// ── GET / — Home page ─────────────────────────────────────────────────────────
app.get('/', async (req, res) => {
  try {
    const [genresResult, curatorsResult, currentDropsResult, communityDropResult, featuredDropResult] = await Promise.all([
      db.query('SELECT id, name FROM genres ORDER BY name ASC'),
      db.query('SELECT id, name, bio, statement, image_url, playlist_image_url, instagram, curator_month FROM curators ORDER BY name ASC'),
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
      `),
      // Featured drop
      db.query('SELECT * FROM featured_drop WHERE id=1').catch(() => ({ rows: [] }))
    ]);
    const genres = genresResult.rows;
    const curators = curatorsResult.rows;
    const fd = featuredDropResult.rows[0] || null;
    const fdYtId = fd && fd.youtube_url ? (fd.youtube_url.match(/(?:v=|youtu\.be\/)([^&?/]+)/) || [])[1] : null;

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
      community: { emoji: '🃏', label: 'Wildcard',  path: '/drop/community' }
    };

    const allGenres = [
      ...genres.map(g => ({ key: g.name.toLowerCase(), ...genreConfig[g.name.toLowerCase()], id: g.id })),
      { key: 'community', emoji: '🃏', label: 'Wildcard',  path: '/drop/community', id: null }
    ].filter((g, i, arr) => g.label && arr.findIndex(x => x.key === g.key) === i);


    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>UHT — Undeniable Hits</title>
<meta name="description" content="A weekly music drop. Vote HIT or DENIED. Subscribe by text.">
<style>
/* ── Design tokens ────────────────────────────────────────── */
:root{
  --bg:#0a0a0a;
  --surface:#111111;
  --surface2:#181818;
  --ink:#e8e4d9;
  --border:rgba(232,228,217,0.07);
  --border-hi:rgba(232,228,217,0.18);
  --muted:rgba(232,228,217,0.38);
  --muted-mid:rgba(232,228,217,0.6);
  --accent:#E8B84B;
  --accent-hit:#E8B84B;
  --green:#27ae60;
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:var(--bg);color:var(--ink);font-family:Georgia,"Times New Roman",serif;overflow-x:hidden;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}

/* NAV */
.nav{display:flex;align-items:center;justify-content:space-between;padding:0 40px;height:58px;position:sticky;top:0;z-index:200;background:rgba(0,0,0,0.95);backdrop-filter:blur(10px);border-bottom:1px solid rgba(243,241,234,0.07)}
.nav-logo{font-size:13px;letter-spacing:.4em;text-transform:uppercase;font-weight:700}
.nav-links{display:flex;gap:36px;font-size:10px;letter-spacing:.25em;text-transform:uppercase;color:#f3f1ea}
.nav-links a:hover{opacity:.7}
.nav-cta{font-size:10px;letter-spacing:.25em;text-transform:uppercase;padding:9px 22px;border:1px solid rgba(243,241,234,0.28);border-radius:999px;background:transparent;color:#f3f1ea;font-family:Georgia,serif;cursor:pointer;transition:all .2s}
.nav-cta:hover{background:#f3f1ea;color:#000}

/* HERO */
.hero{padding:clamp(80px,14vw,160px) 40px clamp(60px,10vw,120px);max-width:1200px;margin:0 auto}
.hero-eyebrow{font-size:10px;letter-spacing:.5em;text-transform:uppercase;color:#f3f1ea;margin-bottom:36px}
.hero-h1{font-weight:700;line-height:.9;letter-spacing:-.03em;margin:0}
.hero-solid{font-size:clamp(64px,12vw,152px);color:#f3f1ea;display:block}
.hero-outline{font-size:clamp(64px,12vw,152px);color:transparent;-webkit-text-stroke:1px rgba(243,241,234,0.22);display:block}
.hero-sub{font-size:clamp(16px,2vw,21px);font-style:italic;opacity:.65;margin:36px 0 48px;max-width:460px}
.hero-btns{display:flex;gap:14px;flex-wrap:wrap}
.btn-fill{padding:15px 44px;background:#f3f1ea;color:#000;border:none;font-family:Georgia,serif;font-size:15px;letter-spacing:.06em;cursor:pointer;border-radius:3px;transition:background .2s}
.btn-fill:hover{background:#fff}
.btn-fill.btn-primary{font-size:17px;padding:20px 56px;letter-spacing:.05em}
.btn-outline{padding:15px 44px;border:1px solid rgba(243,241,234,0.22);font-family:Georgia,serif;font-size:15px;letter-spacing:.06em;border-radius:3px;color:#f3f1ea;display:inline-block;transition:border-color .2s}
.btn-outline:hover{border-color:rgba(243,241,234,0.6)}
.btn-text-link{font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:rgba(243,241,234,0.55);text-decoration:none;display:inline-flex;align-items:center;gap:6px;padding:20px 4px;transition:color .2s;font-family:Georgia,serif;border:none;background:none;cursor:pointer}
.btn-text-link:hover{color:#f3f1ea}
.featured-section{padding:72px 40px;border-top:1px solid rgba(243,241,234,0.07)}
.featured-inner{max-width:860px;margin:0 auto}
.featured-video{width:100%;aspect-ratio:16/9;background:#0a0a0a;margin-bottom:28px;overflow:hidden}
.featured-video iframe{width:100%;height:100%;border:none;display:block}
.featured-meta{display:flex;flex-direction:column;gap:4px;margin-bottom:20px}
.featured-artist{font-size:11px;letter-spacing:.28em;text-transform:uppercase;color:rgba(243,241,234,0.55)}
.featured-title{font-size:clamp(22px,3.5vw,36px);font-weight:700;letter-spacing:-.01em;line-height:1.1}
.featured-note{font-size:13px;font-style:italic;color:rgba(243,241,234,0.5);margin-top:4px}
.featured-sent{font-size:10px;letter-spacing:.28em;text-transform:uppercase;color:rgba(243,241,234,0.3);margin-bottom:20px}
.featured-spotify{font-size:12px;color:rgba(243,241,234,0.45);margin-bottom:28px;display:block}
.featured-spotify:hover{color:#f3f1ea}
.featured-cta{display:inline-flex;align-items:center;padding:16px 40px;background:#f3f1ea;color:#000;border:none;font-family:Georgia,serif;font-size:15px;letter-spacing:.06em;cursor:pointer;transition:background .2s}
.featured-cta:hover{background:#fff}
.curator-helper{font-size:13px;color:rgba(243,241,234,0.55);text-align:center;margin-top:18px;font-style:italic}
.curator-est{font-size:9px;letter-spacing:.4em;text-transform:uppercase;color:rgba(243,241,234,0.5);margin-top:12px;font-family:Georgia,serif;text-align:center}
@media(max-width:768px){.featured-section{padding:48px 20px}.btn-fill.btn-primary{font-size:16px;padding:18px 32px;width:100%;text-align:center}}
.hero-fine{font-size:10px;letter-spacing:.2em;text-transform:uppercase;opacity:.55;margin-top:22px}

/* TICKER */
.ticker{overflow:hidden;border-top:1px solid rgba(243,241,234,0.07);border-bottom:1px solid rgba(243,241,234,0.07);padding:13px 0}
.ticker-track{display:flex;width:max-content;animation:marquee 30s linear infinite}
.ticker-text{font-size:10px;letter-spacing:.4em;text-transform:uppercase;color:#f3f1ea;white-space:nowrap;opacity:.18;font-family:Georgia,serif}
@keyframes marquee{0%{transform:translateX(0)}100%{transform:translateX(-50%)}}

/* SECTION HEADERS */
.sec-head{display:flex;align-items:center;gap:16px;margin-bottom:48px}
.sec-label{font-size:10px;letter-spacing:.4em;text-transform:uppercase;color:#f3f1ea;white-space:nowrap}
.sec-line{flex:1;height:1px;background:rgba(243,241,234,0.07)}

/* CURATORS CAROUSEL */
.curator-track{display:flex;gap:2px;overflow-x:auto;scroll-snap-type:x mandatory;scrollbar-width:none;-webkit-overflow-scrolling:touch;cursor:grab;padding-bottom:2px}
.curator-track:active{cursor:grabbing}
.curator-track::-webkit-scrollbar{display:none}
.curator-card{flex-shrink:0;width:280px;border:1px solid rgba(243,241,234,0.07);display:block;text-decoration:none;color:#f3f1ea;scroll-snap-align:start;transition:all .25s;overflow:hidden}
.curator-card:hover{border-color:rgba(243,241,234,0.22);background:rgba(243,241,234,0.03);transform:translateY(-3px)}
.curator-card:hover .curator-see{opacity:.7}
.curator-img{width:100%;aspect-ratio:1/1;object-fit:cover;display:block;filter:brightness(.85);transition:filter .3s}
.curator-card:hover .curator-img{filter:brightness(1)}
.curator-img-placeholder{width:100%;aspect-ratio:1/1;background:rgba(243,241,234,0.06);display:flex;align-items:center;justify-content:center;font-size:48px}
.curator-body{padding:20px 22px 24px}
.curator-name{font-size:17px;font-weight:600;margin-bottom:6px}
.curator-bio{font-size:13px;opacity:.4;line-height:1.6;margin-bottom:10px}
.curator-insta{font-size:10px;letter-spacing:.2em;text-transform:uppercase;opacity:.28}
.curator-see{font-size:11px;letter-spacing:.2em;text-transform:uppercase;opacity:.28;margin-top:14px;transition:opacity .2s}
.curator-placeholder{flex-shrink:0;width:280px;border:1px solid rgba(243,241,234,0.07);display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px;opacity:.12;min-height:360px}
.curator-placeholder-icon{font-size:32px}
.curator-placeholder-label{font-size:10px;letter-spacing:.3em;text-transform:uppercase}
.curator-carousel-wrap{position:relative}
.curator-nav-btn{position:absolute;top:50%;transform:translateY(-50%);z-index:10;background:none;border:1px solid rgba(243,241,234,0.14);color:rgba(243,241,234,0.35);width:38px;height:38px;border-radius:50%;font-size:15px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .2s;font-family:Georgia,serif;padding:0}
.curator-nav-btn:hover{border-color:rgba(243,241,234,0.45);color:#f3f1ea}
.curator-nav-prev{left:8px}
.curator-nav-next{right:8px}
.curator-month-tag{font-size:9px;letter-spacing:.32em;text-transform:uppercase;color:rgba(243,241,234,0.32);margin-bottom:10px;line-height:1.6}

/* GENRE GRID */
.genre-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:2px;max-width:1400px;margin:0 auto}
.genre-card{display:flex;flex-direction:column;justify-content:space-between;padding:32px 28px 28px;border:1px solid rgba(243,241,234,0.07);border-top:3px solid rgba(243,241,234,0.1);min-height:220px;transition:all .25s;color:#f3f1ea;text-decoration:none;position:relative;overflow:hidden}
.genre-card:hover{background:rgba(243,241,234,0.03);transform:translateY(-4px)}
.genre-card:hover .genre-arrow{opacity:1}
.genre-card-top{display:flex;justify-content:space-between;margin-bottom:18px}
.genre-emoji{font-size:22px}
.genre-arrow{font-size:16px;opacity:0;transition:opacity .2s}
.genre-name{font-size:clamp(13px,1.8vw,28px);font-weight:700;letter-spacing:-.01em;line-height:1;margin-bottom:18px;white-space:nowrap;overflow:hidden;text-overflow:clip}
.genre-song{font-size:13px;font-weight:600;opacity:.9;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.genre-artist{font-size:11px;opacity:.35;letter-spacing:.08em;margin-top:4px}
.genre-coming{font-size:10px;letter-spacing:.3em;text-transform:uppercase;opacity:.22}
.genre-glow{position:absolute;top:0;left:0;right:0;height:60px;pointer-events:none;opacity:0;transition:opacity .25s}
.genre-card:hover .genre-glow{opacity:1}

/* HOW IT WORKS */
.how-row{display:grid;grid-template-columns:100px 1fr;gap:0 40px;align-items:start;padding:40px 0;border-top:1px solid rgba(243,241,234,0.07)}
.how-row:last-child{border-bottom:1px solid rgba(243,241,234,0.07)}
.how-num{font-size:clamp(52px,7vw,88px);font-weight:700;color:rgba(243,241,234,0.07);line-height:1;letter-spacing:-.03em}
.how-title{font-size:clamp(22px,3vw,34px);font-weight:600;margin-bottom:12px;line-height:1.1;padding-top:8px}
.how-desc{font-size:16px;opacity:.38;line-height:1.7}

/* SUBSCRIBE */
.sub-wrap{max-width:1100px;margin:0 auto;display:grid;grid-template-columns:1fr 1fr;gap:0 80px;align-items:start}
.sub-eyebrow{font-size:10px;letter-spacing:.4em;text-transform:uppercase;color:#f3f1ea;margin-bottom:20px}
.sub-headline{font-size:clamp(36px,5vw,64px);font-weight:700;line-height:.95;letter-spacing:-.02em;margin-bottom:24px}
.sub-outline{color:transparent;-webkit-text-stroke:1px rgba(243,241,234,0.2)}
.sub-desc{font-size:16px;opacity:.6;line-height:1.7}
.sub-form{display:flex;flex-direction:column;gap:10px;padding-top:4px}
.sub-input{width:100%;padding:15px 18px;background:rgba(243,241,234,0.05);border:1px solid rgba(243,241,234,0.12);border-radius:8px;color:#f3f1ea;font-family:Georgia,serif;font-size:15px;outline:none;transition:border-color .2s}
.sub-input:focus{border-color:rgba(243,241,234,0.4)}
.sub-input::placeholder{color:rgba(243,241,234,0.25)}
select.sub-input option{background:#111;color:#f3f1ea}
.sub-toggle{display:flex;border:1px solid rgba(243,241,234,0.14);border-radius:999px;overflow:hidden;width:fit-content}
.sub-pill{padding:10px 26px;background:transparent;border:none;color:rgba(243,241,234,0.4);font-family:Georgia,serif;font-size:11px;letter-spacing:.12em;text-transform:uppercase;cursor:pointer;transition:all .2s}
.sub-pill.active{background:#f3f1ea;color:#000}
.sub-check-row{display:flex;align-items:flex-start;gap:12px;cursor:pointer;margin-top:4px}
.sub-checkbox{width:18px;height:18px;flex-shrink:0;margin-top:2px;border:1px solid rgba(243,241,234,0.3);border-radius:3px;display:flex;align-items:center;justify-content:center;transition:all .2s;cursor:pointer}
.sub-checkbox.checked{background:#f3f1ea;border-color:#f3f1ea}
.sub-check-label{font-size:12px;opacity:.42;line-height:1.6}
.sub-btn{padding:17px;background:rgba(243,241,234,0.15);color:rgba(243,241,234,0.3);border:none;border-radius:8px;font-family:Georgia,serif;font-size:15px;cursor:default;transition:all .2s;margin-top:4px}
.sub-btn.ready{background:#f3f1ea;color:#000;cursor:pointer}
.sub-btn.ready:hover{background:#fff}
.sub-msg{font-size:11px;color:#ff6b6b;letter-spacing:.1em;text-transform:uppercase;min-height:16px}

/* FOOTER */
.footer{padding:48px 40px;text-align:center}
.footer-logo{font-size:13px;letter-spacing:.4em;text-transform:uppercase;color:#f3f1ea;margin-bottom:18px}
.footer-links{display:flex;justify-content:center;gap:28px;font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:#f3f1ea;opacity:.7;flex-wrap:wrap;margin-bottom:18px}
.footer-links a:hover{opacity:1}
.footer-copy{font-size:10px;letter-spacing:.12em;text-transform:uppercase;opacity:.4}

/* FIRE MODE — now lives in nav */
.fire-btn{display:flex;align-items:center;gap:6px;padding:7px 14px;background:rgba(243,241,234,0.06);border:1px solid rgba(243,241,234,0.15);border-radius:999px;color:rgba(243,241,234,0.55);font-family:Georgia,serif;font-size:10px;letter-spacing:.18em;text-transform:uppercase;cursor:pointer;transition:all .25s;white-space:nowrap}
.fire-btn:hover{background:rgba(243,241,234,0.1);color:#f3f1ea;border-color:rgba(243,241,234,0.3)}
.fire-btn.on{background:#ff4500;border-color:#ff4500;color:#fff;box-shadow:0 0 18px rgba(255,69,0,.45)}
.fire-overlay{position:fixed;inset:0;pointer-events:none;z-index:50;background:radial-gradient(ellipse at center,transparent 40%,rgba(180,60,0,.18) 100%)}
.ember{position:fixed;bottom:-10%;font-size:20px;animation:emberRise 4s ease-in forwards;opacity:.7}
@keyframes emberRise{0%{transform:translateY(0) rotate(0deg);opacity:.8}100%{transform:translateY(-110vh) rotate(20deg);opacity:0}}


/* CURATOR MODAL */
.cm-bg{position:fixed;inset:0;z-index:400;background:rgba(0,0,0,0.82);display:none;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(6px)}
.cm-bg.open{display:flex}
.cm{position:relative;background:#0a0a0a;border:1px solid rgba(243,241,234,0.12);max-width:420px;width:100%;max-height:90vh;overflow-y:auto;border-radius:4px}
.cm-close{position:absolute;top:14px;right:14px;width:32px;height:32px;border-radius:50%;background:rgba(243,241,234,0.08);border:none;color:#f3f1ea;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;z-index:10;transition:background .2s}
.cm-close:hover{background:rgba(243,241,234,0.18)}
.cm-img{width:100%;aspect-ratio:1/1;object-fit:cover;display:block;filter:brightness(.9)}
.cm-img-ph{width:100%;aspect-ratio:1/1;background:rgba(243,241,234,0.06);display:flex;align-items:center;justify-content:center;font-size:56px;color:rgba(243,241,234,0.2);font-family:Georgia,serif;letter-spacing:.1em}
.cm-body{padding:24px 28px 32px}
.cm-name{font-size:22px;font-weight:700;letter-spacing:.02em;margin-bottom:6px}
.cm-bio{font-size:14px;opacity:.4;line-height:1.6;margin-bottom:6px}
.cm-statement{font-family:Georgia,"Times New Roman",serif;font-size:15px;font-style:italic;color:rgba(243,241,234,0.55);line-height:1.85;margin-top:14px;margin-bottom:6px;white-space:pre-line}
.cm-ig a{display:inline-flex;align-items:center;gap:7px;font-size:11px;letter-spacing:.1em;color:rgba(243,241,234,0.45);text-decoration:none;margin-bottom:20px;transition:color .2s}
.cm-ig a:hover{color:#f3f1ea}
.cm-actions{display:flex;gap:10px;align-items:center;margin-bottom:0}
.cm-follow-btn{padding:11px 24px;background:#f3f1ea;color:#000;border:none;border-radius:6px;font-family:Georgia,serif;font-size:13px;letter-spacing:.08em;cursor:pointer;transition:all .2s}
.cm-follow-btn:hover{background:#fff}
.cm-follow-btn.following{background:rgba(100,220,120,0.12);color:rgba(100,220,120,0.9);border:1px solid rgba(100,220,120,0.25);cursor:default}
.cm-phone-wrap{margin-top:16px;display:none}
.cm-phone-label{font-size:11px;letter-spacing:.2em;text-transform:uppercase;opacity:.4;margin-bottom:8px}
.cm-phone-row{display:flex;gap:8px}
.cm-phone-input{flex:1;padding:11px 14px;background:rgba(243,241,234,0.06);border:1px solid rgba(243,241,234,0.15);border-radius:6px;color:#f3f1ea;font-family:Georgia,serif;font-size:14px;outline:none}
.cm-phone-input:focus{border-color:rgba(243,241,234,0.4)}
.cm-phone-confirm{padding:11px 18px;background:#f3f1ea;color:#000;border:none;border-radius:6px;font-family:Georgia,serif;font-size:13px;cursor:pointer;white-space:nowrap}
.cm-phone-note{font-size:11px;opacity:.3;margin-top:8px;line-height:1.7;letter-spacing:.05em}
.cm-following-perks{margin-top:16px;padding:12px 16px;border-radius:8px;background:rgba(100,220,120,0.06);border:1px solid rgba(100,220,120,0.18);font-size:13px;color:rgba(100,220,120,0.8);line-height:1.8;display:none}
.cm-scorecard{margin-top:20px;padding-top:20px;border-top:1px solid rgba(243,241,234,0.07)}
.cm-score-label{font-size:10px;letter-spacing:.3em;text-transform:uppercase;opacity:.3;margin-bottom:14px}
.cm-score-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:2px}
.cm-score-cell{padding:14px 12px;background:rgba(243,241,234,0.03);text-align:center}
.cm-score-num{font-size:26px;font-weight:700;margin-bottom:4px}
.cm-score-key{font-size:9px;letter-spacing:.25em;text-transform:uppercase;opacity:.3}

/* MOBILE */
@media(max-width:768px){
  .nav{padding:0 20px}
  .nav-links{display:none}
  .hero{padding:52px 20px 52px}
  .hero-eyebrow{letter-spacing:.25em;font-size:9px}
  .hero-btns{flex-direction:column;align-items:stretch}
  .btn-fill,.btn-outline{width:100%;text-align:center;padding:16px 24px;box-sizing:border-box}
  section{padding-left:20px!important;padding-right:20px!important}
  .sec-head{padding-left:0!important;padding-right:0!important}
  .genre-grid{grid-template-columns:1fr 1fr!important}
  .genre-name{font-size:18px!important;white-space:normal!important}
  /* Subscribe */
  .sub-wrap{grid-template-columns:1fr;gap:32px}
  .sub-toggle{width:100%;border-radius:8px}
  .sub-pill{flex:1;text-align:center;padding:12px 10px}
  .sub-headline{font-size:clamp(32px,8vw,52px)}
  /* How it works */
  .how-row{grid-template-columns:56px 1fr;gap:0 16px;padding:28px 0}
  .how-num{font-size:42px!important}
  .how-title{font-size:20px!important}
  .how-desc{font-size:14px}
  /* Curator — prevent fixed width from overflowing */
  .curator-card{width:100%!important;max-width:340px}
  .curator-carousel-wrap [style*="align-items:center"]{padding:0 20px!important}
  /* Footer */
  .footer{padding:40px 20px}
  .fire-btn{font-size:9px;padding:6px 10px}
}
@media(max-width:480px){
  /* Fix UNDENIABLE clipping — clamp min was 64px, too wide at small widths */
  .hero-solid,.hero-outline{font-size:clamp(36px,11.5vw,64px)!important}
}
@media(max-width:400px){
  .genre-grid{grid-template-columns:1fr}
  .hero-eyebrow{letter-spacing:.15em}
}

/* ── Motion & Animation ──────────────────────────────────── */
/* Keyframes */
@keyframes uht-fadeUp{from{opacity:0;transform:translateY(32px)}to{opacity:1;transform:translateY(0)}}
@keyframes uht-fadeIn{from{opacity:0}to{opacity:1}}
@keyframes uht-slideDown{from{opacity:0;transform:translateY(-16px)}to{opacity:1;transform:translateY(0)}}
@keyframes uht-revealRight{from{clip-path:inset(0 100% 0 0)}to{clip-path:inset(0 0% 0 0)}}
@keyframes uht-scaleIn{from{opacity:0;transform:scale(.94)}to{opacity:1;transform:scale(1)}}
@keyframes uht-marqueeRev{0%{transform:translateX(-50%)}100%{transform:translateX(0)}}
@keyframes uht-pulse{0%,100%{box-shadow:0 0 0 0 rgba(232,228,217,0)}50%{box-shadow:0 0 0 8px rgba(232,228,217,0.08)}}
@keyframes uht-borderGlow{0%,100%{border-color:rgba(232,184,75,0.18)}50%{border-color:rgba(232,184,75,0.5)}}

/* Nav entrance */
.nav{animation:uht-slideDown .55s cubic-bezier(.16,1,.3,1) both;animation-delay:.05s}

/* Hero entrance — staggered */
.hero-eyebrow{opacity:0;animation:uht-fadeUp .6s cubic-bezier(.16,1,.3,1) both;animation-delay:.15s}
.hero-solid{opacity:0;animation:uht-fadeUp .9s cubic-bezier(.16,1,.3,1) both;animation-delay:.28s}
.hero-outline{opacity:0;animation:uht-fadeUp .9s cubic-bezier(.16,1,.3,1) both;animation-delay:.44s}
.hero-sub{opacity:0;animation:uht-fadeUp .7s cubic-bezier(.16,1,.3,1) both;animation-delay:.62s}
.hero-btns{opacity:0;animation:uht-fadeUp .65s cubic-bezier(.16,1,.3,1) both;animation-delay:.78s}
.hero-fine{opacity:0;animation:uht-fadeUp .5s ease both;animation-delay:.95s}

/* Scroll-reveal base — only active when JS has run (.js-go on <html>) */
.js-go .reveal{opacity:0;transform:translateY(30px);transition:opacity .75s cubic-bezier(.16,1,.3,1),transform .75s cubic-bezier(.16,1,.3,1)}
.js-go .reveal.in{opacity:1;transform:translateY(0)}

/* Stagger container — only active with JS */
.js-go .stagger>*{opacity:0;transform:translateY(22px);transition:opacity .65s cubic-bezier(.16,1,.3,1),transform .65s cubic-bezier(.16,1,.3,1)}
.js-go .stagger.in>*:nth-child(1){opacity:1;transform:none;transition-delay:.04s}
.js-go .stagger.in>*:nth-child(2){opacity:1;transform:none;transition-delay:.13s}
.js-go .stagger.in>*:nth-child(3){opacity:1;transform:none;transition-delay:.22s}
.js-go .stagger.in>*:nth-child(4){opacity:1;transform:none;transition-delay:.31s}
.js-go .stagger.in>*:nth-child(5){opacity:1;transform:none;transition-delay:.40s}

/* Genre card — enhanced hover */
.genre-card{transition:border-color .3s ease,background .3s ease,transform .3s cubic-bezier(.16,1,.3,1),box-shadow .3s ease}
.genre-card:hover{box-shadow:0 12px 48px rgba(0,0,0,0.5)}
.genre-name{transition:letter-spacing .35s ease}
.genre-card:hover .genre-name{letter-spacing:.04em}

/* How-it-works — number lights up when in view */
.how-num{transition:color .5s ease}
.how-row.in .how-num{color:rgba(232,184,75,0.13)}

/* Curator solo card — shimmer on hover image */
.curator-img{transition:filter .45s ease,transform .45s cubic-bezier(.16,1,.3,1)}
.curator-card:hover .curator-img{filter:brightness(1.05);transform:scale(1.025)}

/* "FOUNDING CURATOR" watermark — slow float */
@keyframes uht-float{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}
.fc-watermark{animation:uht-float 7s ease-in-out infinite}

/* Featured video — scale in on reveal */
.js-go .featured-video{opacity:0;transform:scale(.975);transition:opacity .9s cubic-bezier(.16,1,.3,1),transform .9s cubic-bezier(.16,1,.3,1)}
.js-go .featured-video.in{opacity:1;transform:scale(1)}

/* Subscribe button — pulse when ready */
.sub-btn.ready{animation:uht-pulse 2.4s ease infinite}
.sub-btn.ready:hover{animation:none}

/* Solo curator card glow pulse */
.curator-card[style*="border-color:rgba(232,184,75"]{animation:uht-borderGlow 3.5s ease-in-out infinite}

/* Reversed ticker */
.ticker-rev .ticker-track{animation:uht-marqueeRev 38s linear infinite}

/* Sec-line reveal */
.js-go .sec-line{transform-origin:left;transform:scaleX(0);transition:transform .9s cubic-bezier(.16,1,.3,1) .2s}
.js-go .sec-head.in .sec-line{transform:scaleX(1)}

/* Footer fade */
.js-go .footer{opacity:0;transition:opacity .8s ease}
.js-go .footer.in{opacity:1}

/* ── Scroll progress bar ── */
#scroll-bar{position:fixed;top:0;left:0;height:2px;width:0%;background:#E8B84B;z-index:600;pointer-events:none;transition:width .06s linear}

/* ── Hamburger ── */
.nav-ham{display:none;flex-direction:column;justify-content:center;gap:5px;background:none;border:none;cursor:pointer;padding:8px 4px;z-index:600;flex-shrink:0}
.nav-ham span{display:block;width:22px;height:1.5px;background:#f3f1ea;transition:transform .35s cubic-bezier(.16,1,.3,1),opacity .25s;transform-origin:center}
.nav-ham.open span:nth-child(1){transform:translateY(6.5px) rotate(45deg)}
.nav-ham.open span:nth-child(2){opacity:0;transform:scaleX(0)}
.nav-ham.open span:nth-child(3){transform:translateY(-6.5px) rotate(-45deg)}
@media(max-width:768px){.nav-ham{display:flex}}

/* ── Mobile nav overlay ── */
.mob-nav{position:fixed;inset:0;z-index:400;background:#000;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;transform:translateY(-100%);transition:transform .55s cubic-bezier(.16,1,.3,1);pointer-events:none}
.mob-nav.open{transform:translateY(0);pointer-events:all}
.mob-nav a,.mob-nav button.mob-link{font-family:Georgia,"Times New Roman",serif;font-size:clamp(32px,9vw,56px);font-weight:700;letter-spacing:-.02em;color:#f3f1ea;text-decoration:none;background:none;border:none;cursor:pointer;padding:10px 0;opacity:.18;transition:opacity .2s,transform .2s;line-height:1.1;text-align:center}
.mob-nav.open a,.mob-nav.open button.mob-link{opacity:.18}
.mob-nav a:hover,.mob-nav button.mob-link:hover{opacity:1;transform:translateX(6px)}
.mob-nav .mob-cta{margin-top:32px;font-family:Georgia,serif;font-size:12px;letter-spacing:.3em;text-transform:uppercase;color:#f3f1ea;background:none;border:1px solid rgba(243,241,234,0.35);border-radius:999px;padding:16px 44px;cursor:pointer;transition:all .2s;opacity:.7}
.mob-nav .mob-cta:hover{background:#f3f1ea;color:#000;opacity:1}
.mob-nav .mob-ticker{position:absolute;bottom:28px;font-size:9px;letter-spacing:.35em;text-transform:uppercase;color:#f3f1ea;opacity:.1}

/* ── Active nav link ── */
.nav-links a{transition:color .25s,opacity .25s}
.nav-links a.nav-active{color:#E8B84B;opacity:1}

/* ── How-it-works — brighter number when in view ── */
.how-num{transition:color .6s ease,text-shadow .6s ease}
.how-row.in .how-num{color:rgba(232,184,75,0.28);text-shadow:0 0 60px rgba(232,184,75,0.15)}
.how-row.in .how-title{color:#f3f1ea}

/* ── Magnetic button ripple ── */
.btn-fill,.btn-outline,.nav-cta{will-change:transform}

/* ── Genre card count badge ── */
.genre-count{position:absolute;top:12px;right:28px;font-size:8px;letter-spacing:.3em;text-transform:uppercase;color:rgba(243,241,234,0.2);transition:color .25s}
.genre-card:hover .genre-count{color:rgba(243,241,234,0.5)}

</style>
</head>
<body>
<div id="scroll-bar"></div>

<!-- NAV -->
<nav class="nav">
  <a href="/" class="nav-logo">UHT</a>
  <div class="nav-links" id="navLinks">
    <a href="#curators" data-section="curators">Curators</a>
    <a href="#drops" data-section="drops">Genres</a>
    <a href="#how-it-works" data-section="how-it-works">How It Works</a>
  </div>
  <button class="fire-btn" id="fireBtn" onclick="toggleFire()">🔥 Fire Mode</button>
  <button class="nav-cta" onclick="document.getElementById('subscribe').scrollIntoView({behavior:'smooth'})">Subscribe</button>
  <button class="nav-ham" id="navHam" onclick="toggleMobNav()" aria-label="Menu">
    <span></span><span></span><span></span>
  </button>
</nav>

<!-- MOBILE NAV OVERLAY -->
<div class="mob-nav" id="mobNav">
  <a href="#curators" onclick="closeMobNav()">Curators</a>
  <a href="#drops" onclick="closeMobNav()">Genres</a>
  <a href="#how-it-works" onclick="closeMobNav()">How It Works</a>
  <button class="mob-cta" onclick="closeMobNav();setTimeout(function(){document.getElementById('subscribe').scrollIntoView({behavior:'smooth'})},300)">Subscribe</button>
  <div class="mob-ticker">· ONE HIT · ONE LIFE ·</div>
</div>

<!-- HERO -->
<section class="hero">
  <div class="hero-eyebrow">Weekly SMS · Vote Hit or Denied</div>
  <h1 class="hero-h1">
    <span class="hero-solid">UNDENIABLE</span>
    <span class="hero-outline">HITS</span>
  </h1>
  <p class="hero-sub">A weekly hit, curated by real people. Delivered by text.</p>
  <div class="hero-btns" style="align-items:center;gap:24px">
    <button class="btn-fill btn-primary" onclick="document.getElementById('subscribe').scrollIntoView({behavior:'smooth'})">Get Weekly Hits by Text</button>
    <a class="btn-text-link" href="#drops">Browse genres ↓</a>
  </div>
  <div class="hero-fine">Free · Text only · Unsubscribe anytime</div>
</section>

<!-- TICKER -->
<div class="ticker">
  <div class="ticker-track">
    <span class="ticker-text">· ONE HIT · ONE LIFE · ONE HIT · ONE LIFE · ONE HIT · ONE LIFE · ONE HIT · ONE LIFE · ONE HIT · ONE LIFE · </span>
    <span class="ticker-text">· ONE HIT · ONE LIFE · ONE HIT · ONE LIFE · ONE HIT · ONE LIFE · ONE HIT · ONE LIFE · ONE HIT · ONE LIFE · </span>
  </div>
</div>

<!-- CURATORS OF THE MONTH -->
<section style="padding:80px 0 80px" id="curators">
  <div class="sec-head reveal" style="padding:0 40px">
    <span class="sec-label">Curators of the Month</span>
    <div class="sec-line"></div>
  </div>
  <div class="curator-carousel-wrap" style="margin-top:32px">
    ${curators.length > 1 ? `<button class="curator-nav-btn curator-nav-prev" onclick="scrollCurators(-1)" aria-label="Previous">&#8592;</button>` : ''}
    ${curators.length === 1 ? `
    <div style="display:flex;flex-direction:column;align-items:center;padding:0 40px;position:relative">
      <div class="fc-watermark" style="font-size:clamp(40px,6vw,80px);font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:rgba(243,241,234,0.28);text-align:center;line-height:1;margin-bottom:16px;pointer-events:none;user-select:none;font-family:Georgia,serif;text-shadow:0 0 60px rgba(232,184,75,0.12)">FOUNDING CURATOR</div>
      ${(c => `
      <div class="curator-card" onclick="openCuratorModal(${c.id})" style="cursor:pointer;width:340px;border-color:rgba(232,184,75,0.18);box-shadow:0 0 80px rgba(232,184,75,0.05)">
        <div style="position:relative">
          ${c.image_url
            ? `<img class="curator-img" src="${c.image_url}" alt="${c.name}" loading="lazy" style="aspect-ratio:4/5">`
            : `<div class="curator-img-placeholder" style="aspect-ratio:4/5">🎧</div>`}
          <div style="position:absolute;bottom:0;left:0;right:0;padding:10px 16px 12px;background:linear-gradient(transparent,rgba(0,0,0,0.78));display:flex;align-items:center;gap:8px">
            <span style="font-size:8px;letter-spacing:.42em;text-transform:uppercase;color:rgba(232,228,217,0.72);font-family:Georgia,serif;line-height:1">${c.curator_month || 'May 2026'}</span>
            <span style="width:1px;height:10px;background:rgba(232,228,217,0.2);display:inline-block"></span>
            <span style="font-size:8px;letter-spacing:.42em;text-transform:uppercase;color:rgba(232,184,75,0.7);font-family:Georgia,serif;line-height:1">Undeniable Hits</span>
          </div>
        </div>
        <div class="curator-body">
          <div style="display:inline-flex;align-items:center;gap:8px;padding:4px 12px 4px 10px;background:rgba(232,184,75,0.08);border:1px solid rgba(232,184,75,0.28);border-radius:2px;margin-bottom:14px">
            <span style="color:#E8B84B;font-size:9px;letter-spacing:.32em;text-transform:uppercase;font-family:Georgia,serif">No. 01 · Founding Curator</span>
          </div>
          <div class="curator-name" style="font-size:20px">${c.name}</div>
          ${c.bio ? `<div class="curator-bio">${c.bio}</div>` : ''}
          ${c.instagram ? `<div class="curator-insta">@${c.instagram}</div>` : ''}
          <div class="curator-see">+ Follow</div>
        </div>
      </div>
      <div class="curator-helper">Follow ${c.name.split(' ')[0]} to get his weekly pick every Monday.</div>
      `)(curators[0])}
    </div>
    ` : `
    <div class="curator-track" id="curatorTrack" style="padding-left:60px">
      ${curators.map(c => `
      <div class="curator-card" onclick="openCuratorModal(${c.id})" style="cursor:pointer">
        ${c.image_url
          ? `<img class="curator-img" src="${c.image_url}" alt="${c.name}" loading="lazy">`
          : `<div class="curator-img-placeholder">🎧</div>`}
        <div class="curator-body">
          <div class="curator-month-tag">${c.curator_month || 'May 2026'} · Founding Curator</div>
          <div class="curator-name">${c.name}</div>
          ${c.bio ? `<div class="curator-bio">${c.bio}</div>` : ''}
          ${c.instagram ? `<div class="curator-insta">@${c.instagram}</div>` : ''}
          <div class="curator-see">+ Follow</div>
        </div>
      </div>`).join('')}
    </div>
    `}
    ${curators.length > 1 ? `<button class="curator-nav-btn curator-nav-next" onclick="scrollCurators(1)" aria-label="Next">&#8594;</button>` : ''}
  </div>
</section>

<!-- FEATURED DROP -->
${fd && fdYtId ? `
<section class="featured-section" id="featured">
  <div class="featured-inner">
    <div class="sec-head reveal" style="margin-bottom:32px">
      <span class="sec-label">Last Week's Undeniable Rock Hit</span>
      <div class="sec-line"></div>
    </div>
    <div class="featured-video reveal">
      <iframe src="https://www.youtube.com/embed/${fdYtId}?rel=0&modestbranding=1" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen loading="lazy"></iframe>
    </div>
    <div class="featured-meta">
      <div class="featured-artist">${fd.artist || ''}</div>
      <div class="featured-title">${fd.title || ''}</div>
      ${fd.curator_note ? `<div class="featured-note">"${fd.curator_note}"</div>` : ''}
    </div>
    <div class="featured-sent">Sent to subscribers last week</div>
    ${fd.spotify_url ? `<a class="featured-spotify" href="${fd.spotify_url}" target="_blank" rel="noopener">Prefer Spotify? Listen here ↗</a>` : ''}
    <button class="featured-cta" onclick="document.getElementById('subscribe').scrollIntoView({behavior:'smooth'})">Get Weekly Hits by Text</button>
  </div>
</section>
` : ''}

<!-- GENRE DROPS -->
<section style="padding:80px 40px" id="drops">
  <div class="sec-head reveal" style="max-width:1100px;margin:0 auto 48px">
    <span class="sec-label">This Week's Drops</span>
    <div class="sec-line"></div>
  </div>
  <div class="genre-grid stagger">
    ${allGenres.map(g => {
      const drop = currentDrops[g.key];
      const accentMap = { rock:'#ff3b3b', pop:'#ff85c8', country:'#E8B84B', punk:'#7DF9FF', community:'#f3f1ea' };
      const accent = accentMap[g.key] || '#f3f1ea';
      return `
    <div class="genre-card" onclick="pickGenre('${g.key}')" style="border-top-color:rgba(243,241,234,0.1);cursor:pointer" onmouseover="this.style.borderTopColor='${accent}';this.querySelector('.genre-arrow').style.color='${accent}';this.querySelector('.genre-glow').style.background='linear-gradient(to bottom,${accent}22,transparent)'" onmouseout="this.style.borderTopColor='rgba(243,241,234,0.1)';this.querySelector('.genre-arrow').style.color='inherit'">
      <div class="genre-glow"></div>
      <div>
        <div class="genre-card-top">
          <span class="genre-emoji">${g.emoji}</span>
          <span class="genre-arrow">↗</span>
        </div>
        <div class="genre-name">${g.label.toUpperCase()}</div>
      </div>
      <div>
        ${(drop && g.key !== 'rock')
          ? `<div class="genre-song">${drop.title}</div><div class="genre-artist">${drop.artist}</div>`
          : `<div class="genre-coming">Drop coming Friday</div>`}
      </div>
    </div>`;
    }).join('')}
  </div>
</section>

<!-- TICKER -->
<div class="ticker">
  <div class="ticker-track">
    <span class="ticker-text">· ONE HIT · ONE LIFE · ONE HIT · ONE LIFE · ONE HIT · ONE LIFE · ONE HIT · ONE LIFE · ONE HIT · ONE LIFE · </span>
    <span class="ticker-text">· ONE HIT · ONE LIFE · ONE HIT · ONE LIFE · ONE HIT · ONE LIFE · ONE HIT · ONE LIFE · ONE HIT · ONE LIFE · </span>
  </div>
</div>

<!-- HOW IT WORKS -->
<section style="padding:80px 40px" id="how-it-works">
  <div class="sec-head reveal" style="max-width:1100px;margin:0 auto 56px">
    <span class="sec-label">The Process</span>
    <div class="sec-line"></div>
  </div>
  <div style="max-width:1100px;margin:0 auto">
    <div class="how-row reveal">
      <div class="how-num">01</div>
      <div><div class="how-title">You subscribe</div><div class="how-desc">Drop your number. Choose your genre or follow a curator.</div></div>
    </div>
    <div class="how-row reveal" style="transition-delay:.12s">
      <div class="how-num">02</div>
      <div><div class="how-title">Friday drop</div><div class="how-desc">Every Friday at 10 AM: one song via text. No albums. No playlists.</div></div>
    </div>
    <div class="how-row reveal" style="transition-delay:.24s">
      <div class="how-num">03</div>
      <div><div class="how-title">Vote</div><div class="how-desc">Reply HIT or DENIED. Your vote feeds the leaderboard.</div></div>
    </div>
  </div>
</section>

<!-- TICKER REVERSED -->
<div class="ticker ticker-rev">
  <div class="ticker-track">
    <span class="ticker-text">· ONE HIT · ONE LIFE · ONE HIT · ONE LIFE · ONE HIT · ONE LIFE · ONE HIT · ONE LIFE · ONE HIT · ONE LIFE · </span>
    <span class="ticker-text">· ONE HIT · ONE LIFE · ONE HIT · ONE LIFE · ONE HIT · ONE LIFE · ONE HIT · ONE LIFE · ONE HIT · ONE LIFE · </span>
  </div>
</div>

<!-- SUBSCRIBE -->
<section style="padding:80px 40px" id="subscribe">
  <div class="sub-wrap reveal">
    <div>
      <div class="sub-eyebrow">Get the Drop</div>
      <h2 class="sub-headline">Subscribe.<br><span class="sub-outline">Vote.</span></h2>
      <p class="sub-desc">One text. Every Friday. Vote HIT or DENIED and see how the world hears it.</p>
    </div>
    <div>
      <form class="sub-form" id="subForm" onsubmit="handleSubscribe(event)">
        <input class="sub-input" id="subPhone" type="tel" placeholder="Phone number *" autocomplete="tel">
        <input class="sub-input" id="subName" type="text" placeholder="Name (optional)">
        <input class="sub-input" id="subEmail" type="email" placeholder="Email (optional)">
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
        <label class="sub-check-row" onclick="toggleAgree()">
          <div class="sub-checkbox" id="agreeBox"></div>
          <span class="sub-check-label">I agree to receive weekly SMS messages from UHT. Reply STOP at any time to unsubscribe. Standard rates may apply.</span>
        </label>
        <button class="sub-btn" type="submit" id="subBtn">Send me the drop</button>
        <div class="sub-msg" id="subMsg"></div>
      </form>
      <div id="verifyWrap" style="display:none;flex-direction:column;gap:10px">
        <div style="font-size:13px;opacity:.4;margin-bottom:4px">Code sent — check your texts.</div>
        <input class="sub-input" id="verifyCode" type="text" placeholder="Verification code" maxlength="6" inputmode="numeric">
        <button class="sub-btn ready" onclick="handleVerify()">Verify</button>
        <div class="sub-msg" id="verifyMsg"></div>
      </div>
    </div>
  </div>
</section>

<!-- FOOTER -->
<footer class="footer reveal">
  <div class="footer-logo">UHT</div>
  <div class="footer-links">
    <a href="#curators">Curators</a>
    <a href="#drops">Genres</a>
    <a href="#how-it-works">How It Works</a>
    <a href="/admin">Admin</a>
  </div>
  <div class="footer-copy">© ${new Date().getFullYear()} Undeniable Hits · +1 (844) 261-6758</div>
</footer>


<!-- CURATOR MODAL -->
<div class="cm-bg" id="cmBg" onclick="if(event.target===this)closeCuratorModal()">
  <div class="cm" id="cmBox">
    <button class="cm-close" onclick="closeCuratorModal()">✕</button>
    <div id="cmImgWrap"></div>
    <div class="cm-body">
      <div class="cm-name" id="cmName"></div>
      <div class="cm-bio"  id="cmBio"></div>
      <div class="cm-statement" id="cmStatement"></div>
      <div class="cm-ig"   id="cmIg"></div>
      <div class="cm-actions">
        <button class="cm-follow-btn" id="cmFollowBtn" onclick="handleCuratorFollow()">+ Follow</button>
      </div>
      <div class="cm-phone-wrap" id="cmPhoneWrap">
        <div class="cm-phone-label">Enter your number to follow</div>
        <div class="cm-phone-row">
          <input class="cm-phone-input" id="cmPhone" type="tel" placeholder="+1 (555) 000-0000" onkeydown="if(event.key==='Enter')confirmCuratorFollow()">
          <button class="cm-phone-confirm" onclick="confirmCuratorFollow()">✓ Follow</button>
        </div>
        <div class="cm-phone-note">📱 Weekly drops to your phone &nbsp;·&nbsp; 🔥 Vote on every pick</div>
      </div>
      <div class="cm-following-perks" id="cmFollowingPerks">
        ✓ Following &nbsp;·&nbsp; 📱 Weekly drops &nbsp;·&nbsp; 🔔 Drop alerts &nbsp;·&nbsp; 🔥 Vote on picks
        <div style="margin-top:6px;font-size:11px;opacity:.4;cursor:pointer" onclick="handleCuratorUnfollow()">Unfollow</div>
      </div>
      <div class="cm-scorecard" id="cmScorecard" style="display:none">
        <div class="cm-score-label">Track Record</div>
        <div class="cm-score-grid" id="cmScoreGrid"></div>
      </div>
    </div>
  </div>
</div>

<div id="fireOverlay" class="fire-overlay" style="display:none"></div>

<script>
// Signal JS is running — activates all motion CSS
document.documentElement.classList.add('js-go');
// ── Curator drag + touch scroll ──
(function(){
  var t=document.getElementById('curatorTrack');
  if(!t) return;
  // Mouse drag
  var down=false, startX=0, sl=0;
  t.addEventListener('mousedown',function(e){down=true;startX=e.pageX-t.offsetLeft;sl=t.scrollLeft;t.style.cursor='grabbing'});
  document.addEventListener('mouseup',function(){down=false;if(t)t.style.cursor='grab'});
  t.addEventListener('mousemove',function(e){if(!down)return;e.preventDefault();t.scrollLeft=sl-(e.pageX-t.offsetLeft-startX)});
  // Touch swipe
  var touchX=0, touchSl=0;
  t.addEventListener('touchstart',function(e){touchX=e.touches[0].pageX;touchSl=t.scrollLeft;},{passive:true});
  t.addEventListener('touchmove',function(e){t.scrollLeft=touchSl-(e.touches[0].pageX-touchX);},{passive:true});
})();

// ── Curator nav arrows ──
function scrollCurators(dir){
  var t=document.getElementById('curatorTrack');
  if(t) t.scrollBy({left:dir*300,behavior:'smooth'});
}

// ── Subscribe ──
var _subPhone='', _agreed=false, _activePill='genre';

function toggleAgree(){
  _agreed=!_agreed;
  var b=document.getElementById('agreeBox');
  b.className='sub-checkbox'+(_agreed?' checked':'');
  b.innerHTML=_agreed?'<span style="color:#000;font-size:11px;font-weight:700">✓</span>':'';
  document.getElementById('subBtn').className='sub-btn'+(_agreed?' ready':'');
}

function pickGenre(key) {
  // Activate genre pill
  switchPill('genre');
  // Pre-select the genre in the dropdown
  var sel = document.getElementById('subGenre');
  if(sel) {
    for(var i=0; i<sel.options.length; i++) {
      if(sel.options[i].value === key) { sel.selectedIndex = i; break; }
    }
  }
  // Scroll to subscribe section
  var el = document.getElementById('subscribe');
  if(el) el.scrollIntoView({behavior:'smooth', block:'start'});
}

function switchPill(type){
  _activePill=type;
  document.getElementById('pillGenre').className='sub-pill'+(type==='genre'?' active':'');
  document.getElementById('pillCurator').className='sub-pill'+(type==='curator'?' active':'');
  document.getElementById('genrePanel').style.display=type==='genre'?'block':'none';
  document.getElementById('curatorPanel').style.display=type==='curator'?'block':'none';
}

function handleSubscribe(e){
  e.preventDefault();
  var phone=document.getElementById('subPhone').value.trim();
  var msg=document.getElementById('subMsg');
  var btn=document.getElementById('subBtn');
  if(!phone){msg.textContent='Phone number required.';return}
  if(!_agreed){msg.textContent='Please agree to receive SMS messages.';return}
  if(_activePill==='genre'&&!document.getElementById('subGenre').value){msg.textContent='Choose a genre.';return}
  if(_activePill==='curator'&&!document.getElementById('subCurator').value){msg.textContent='Choose a curator.';return}
  btn.disabled=true;btn.className='sub-btn';btn.textContent='Sending...';msg.textContent='';
  _subPhone=phone;
  var genreEl=document.getElementById('subGenre');
  var genreId=_activePill==='genre'?(genreEl.options[genreEl.selectedIndex]&&genreEl.options[genreEl.selectedIndex].dataset.id):'';
  var curatorId=_activePill==='curator'?document.getElementById('subCurator').value:'';
  var body={phone:phone,name:document.getElementById('subName').value||undefined,email:document.getElementById('subEmail').value||undefined};
  if(curatorId)body.curator_id=parseInt(curatorId);
  else if(genreId)body.genre_id=parseInt(genreId);
  fetch('/api/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
    .then(function(r){return r.json().then(function(d){return{ok:r.ok,data:d}})})
    .then(function(res){
      if(res.ok){
        fetch('/api/send_code',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:phone})});
        document.getElementById('subForm').style.display='none';
        var vw=document.getElementById('verifyWrap');vw.style.display='flex';
      } else {msg.textContent=res.data.error||'Something went wrong.';btn.disabled=false;btn.className='sub-btn ready';btn.textContent='Send me the drop';}
    })
    .catch(function(){msg.textContent='Network error.';btn.disabled=false;btn.className='sub-btn ready';btn.textContent='Send me the drop';});
}

function handleVerify(){
  var code=document.getElementById('verifyCode').value.trim();
  var msg=document.getElementById('verifyMsg');
  if(!code){msg.textContent='Enter the code from your text.';return}
  fetch('/api/verify_code',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:_subPhone,code:code})})
    .then(function(r){return r.json().then(function(d){return{ok:r.ok,data:d}})})
    .then(function(res){
      if(res.ok){document.getElementById('verifyWrap').innerHTML='<div style="font-size:24px;color:#E8B84B;margin-bottom:10px">HIT.</div><div style="font-size:17px;margin-bottom:6px">You\\'re in.</div><div style="font-size:13px;opacity:.4">First drop arrives Friday.</div>';}
      else{msg.textContent=res.data.error||'Invalid code.';}
    }).catch(function(){msg.textContent='Network error.';});
}


// ── Curator data (server-rendered) ──
var _curators = ${JSON.stringify(curators.map(c => ({id:c.id,name:c.name,bio:c.bio||'',statement:c.statement||'',instagram:c.instagram||'',image_url:c.image_url||'',playlist_image_url:c.playlist_image_url||'',curator_month:c.curator_month||''})))};
var _cmCuratorId = null;

function openCuratorModal(id) {
  var c = _curators.find(function(x){ return x.id === id; });
  if(!c) return;
  _cmCuratorId = id;
  // Image
  var imgWrap = document.getElementById('cmImgWrap');
  imgWrap.style.position = 'relative';
  if(c.image_url) {
    var img = document.createElement('img');
    img.className = 'cm-img';
    img.src = c.image_url;
    img.alt = c.name;
    img.onerror = function(){ imgWrap.innerHTML = '<div class="cm-img-ph">'+initials(c.name)+'</div>'; };
    imgWrap.innerHTML = '';
    imgWrap.appendChild(img);
  } else {
    imgWrap.innerHTML = '<div class="cm-img-ph">'+initials(c.name)+'</div>';
  }
  if(c.curator_month) {
    var badge = document.createElement('div');
    badge.style.cssText = 'position:absolute;top:0;left:0;right:0;padding:18px 20px 40px;background:linear-gradient(rgba(0,0,0,0.72),transparent);font-family:Georgia,"Times New Roman",serif;font-size:17px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:#f3f1ea;pointer-events:none;line-height:1';
    badge.textContent = 'Curator · ' + c.curator_month;
    imgWrap.appendChild(badge);
  }
  document.getElementById('cmName').textContent = c.name;
  document.getElementById('cmBio').textContent = c.bio || '';
  var stEl = document.getElementById('cmStatement');
  if(stEl){ stEl.textContent = c.statement || ''; stEl.style.display = c.statement ? 'block' : 'none'; }
  var igEl = document.getElementById('cmIg');
  if(c.instagram) {
    var handle = c.instagram.replace('@','');
    igEl.innerHTML = '<a href="https://instagram.com/'+handle+'" target="_blank" rel="noopener"><svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="5" ry="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/></svg>@'+handle+'</a>';
  } else {
    igEl.innerHTML = '';
  }
  // Reset state
  document.getElementById('cmPhoneWrap').style.display = 'none';
  document.getElementById('cmFollowBtn').style.display = 'inline-block';
  document.getElementById('cmFollowBtn').className = 'cm-follow-btn';
  document.getElementById('cmFollowBtn').textContent = '+ Follow';
  document.getElementById('cmFollowingPerks').style.display = 'none';
  // Check if already following
  var saved = localStorage.getItem('uht_phone');
  if(saved) {
    fetch('/api/follows/check?phone='+encodeURIComponent(saved)+'&curator_id='+id)
      .then(function(r){ return r.json(); })
      .then(function(d){ if(d.following) showCuratorFollowingState(); })
      .catch(function(){});
  }
  // Load scorecard
  loadCuratorScorecard(id);
  // Open
  document.getElementById('cmBg').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeCuratorModal() {
  document.getElementById('cmBg').classList.remove('open');
  document.body.style.overflow = '';
}

function initials(name) {
  return name.split(' ').map(function(w){ return w[0]; }).join('').toUpperCase();
}

function handleCuratorFollow() {
  document.getElementById('cmPhoneWrap').style.display = 'block';
  document.getElementById('cmFollowBtn').style.display = 'none';
  setTimeout(function(){ document.getElementById('cmPhone').focus(); }, 100);
}

function confirmCuratorFollow() {
  var raw = document.getElementById('cmPhone').value.trim();
  if(!raw) return;
  var phone = raw.replace(/\D/g,'');
  if(phone.length===10) phone='+1'+phone;
  else if(phone.length===11&&phone[0]==='1') phone='+'+phone;
  else phone='+'+phone;
  fetch('/api/follows',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({phone:phone,curator_id:_cmCuratorId})
  }).then(function(r){
    if(r.ok){
      localStorage.setItem('uht_phone', phone);
      showCuratorFollowingState();
    }
  }).catch(function(){});
}

function showCuratorFollowingState() {
  document.getElementById('cmPhoneWrap').style.display = 'none';
  document.getElementById('cmFollowBtn').style.display = 'none';
  document.getElementById('cmFollowingPerks').style.display = 'block';
}

function handleCuratorUnfollow() {
  var phone = localStorage.getItem('uht_phone');
  if(!phone) return;
  fetch('/api/follows',{
    method:'DELETE',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({phone:phone,curator_id:_cmCuratorId})
  }).then(function(){
    document.getElementById('cmFollowingPerks').style.display = 'none';
    document.getElementById('cmFollowBtn').style.display = 'inline-block';
  }).catch(function(){});
}

function loadCuratorScorecard(id) {
  var sc = document.getElementById('cmScorecard');
  var grid = document.getElementById('cmScoreGrid');
  sc.style.display = 'none';
  fetch('/api/curators/'+id+'/scorecard')
    .then(function(r){ return r.json(); })
    .then(function(d){
      if(!d) return;
      var st = d.stats || {};
      var subs = d.submissions || [];
      var tier = d.tier || '🌙 Rising Curator';
      var mega = parseInt(st.mega_hits)||0;
      var hits = parseInt(st.hits)||0;
      var denies = parseInt(st.denies)||0;
      var total = parseInt(st.total)||0;
      var hitRate = st.hit_rate ? parseFloat(st.hit_rate) : 0;
      var rateColor = hitRate >= 70 ? '#4ade80' : hitRate >= 40 ? '#E8B84B' : total > 0 ? '#f87171' : 'rgba(243,241,234,0.3)';

      // Tier badge + drop cadence note
      var tierHtml = '<div style="display:inline-block;font-size:9px;letter-spacing:.28em;text-transform:uppercase;color:#E8B84B;border:1px solid rgba(232,184,75,0.3);padding:3px 10px;border-radius:2px;margin-bottom:8px">'+tier+'</div>'
        +'<div style="font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:rgba(243,241,234,0.28);margin-bottom:14px">Drops every Monday</div>';

      // Stats row
      var statsHtml = '';
      if(total > 0) {
        statsHtml = '<div style="display:flex;align-items:center;gap:14px;padding:14px 16px;background:rgba(255,255,255,0.04);border-radius:8px;margin-bottom:16px">'
          +'<div style="flex-shrink:0"><div style="font-family:Georgia,serif;font-size:38px;font-weight:700;line-height:1;color:'+rateColor+'">'+hitRate+'%</div><div style="font-size:9px;letter-spacing:.22em;text-transform:uppercase;color:rgba(243,241,234,0.35);margin-top:2px">Hit Rate</div></div>'
          +'<div style="font-size:13px;color:rgba(243,241,234,0.6);line-height:2">🔥 '+mega+' Mega Hit<br>🎯 '+hits+' Hit<br>💀 '+denies+' Denied</div>'
          +'</div>';
      } else {
        statsHtml = '<div style="font-size:11px;color:rgba(243,241,234,0.25);letter-spacing:.15em;text-transform:uppercase;margin-bottom:16px">No votes yet</div>';
      }

      // Archive picks
      var archiveHtml = '';
      if(subs.length) {
        archiveHtml += '<div style="font-size:9px;letter-spacing:.32em;text-transform:uppercase;color:rgba(243,241,234,0.2);margin-bottom:14px">Archive · Picks</div>';
        subs.forEach(function(s) {
          var smega = parseInt(s.mega_hits)||0, shit = parseInt(s.hits)||0, sdeny = parseInt(s.denies)||0;
          archiveHtml += '<div style="padding:14px 0;border-bottom:1px solid rgba(255,255,255,0.05)">'
            +'<div style="font-size:9px;letter-spacing:.25em;text-transform:uppercase;color:rgba(243,241,234,0.22);margin-bottom:4px">Week '+(s.week_number||'?')+' of 4</div>'
            +'<div style="font-family:Georgia,serif;font-size:18px;font-weight:700;color:#f3f1ea;margin-bottom:2px">'+s.title+'</div>'
            +'<div style="font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:rgba(243,241,234,0.35);margin-bottom:6px">'+s.artist+'</div>'
            +(s.curator_note ? '<div style="font-family:Georgia,serif;font-size:13px;font-style:italic;color:rgba(243,241,234,0.35);line-height:1.7;margin-bottom:6px">&ldquo;'+s.curator_note+'&rdquo;</div>' : '')
            +'<div style="font-size:11px;color:rgba(243,241,234,0.25)">🔥 '+smega+' · 🎯 '+shit+' · 💀 '+sdeny+'</div>'
            +'</div>';
        });
      }

      // Override 3-col grid — use full-width single column
      grid.style.display = 'block';
      grid.innerHTML = tierHtml + statsHtml + archiveHtml;
      sc.style.display = 'block';
    }).catch(function(){});
}

// ── Fire mode ──
var _fireOn=false, _embers=[];
function toggleFire(){
  _fireOn=!_fireOn;
  var btn=document.getElementById('fireBtn');
  var overlay=document.getElementById('fireOverlay');
  btn.className='fire-btn'+(_fireOn?' on':'');
  btn.innerHTML=_fireOn?'🔥 On Fire':'🔥 Fire Mode';
  overlay.style.display=_fireOn?'block':'none';
  if(_fireOn){spawnEmbers();}else{_embers.forEach(function(e){if(e.parentNode)e.parentNode.removeChild(e)});_embers=[];}
}
function spawnEmbers(){
  if(!_fireOn)return;
  for(var i=0;i<3;i++){
    var e=document.createElement('div');
    e.className='ember';
    e.textContent='🔥';
    e.style.left=(5+Math.random()*88)+'%';
    e.style.fontSize=(14+Math.random()*16)+'px';
    e.style.animationDuration=(3+Math.random()*3)+'s';
    e.style.animationDelay=(Math.random()*1)+'s';
    document.body.appendChild(e);
    _embers.push(e);
    e.addEventListener('animationend',function(){if(this.parentNode)this.parentNode.removeChild(this);_embers=_embers.filter(function(x){return x.parentNode});if(_fireOn)setTimeout(spawnEmbers,0);});
  }
}

// ── Motion: Scroll-reveal (IntersectionObserver) ──────────────────
(function(){
  var io = new IntersectionObserver(function(entries){
    entries.forEach(function(e){
      if(e.isIntersecting){ e.target.classList.add('in'); }
    });
  },{threshold:0.08,rootMargin:'0px 0px -48px 0px'});
  document.querySelectorAll('.reveal,.stagger,.featured-video,.sec-head,.how-row').forEach(function(el){
    io.observe(el);
  });
})();

// ── Smooth anchor scroll ──────────────────────────────────────────
document.querySelectorAll('a[href^="#"]').forEach(function(a){
  a.addEventListener('click',function(e){
    var id=this.getAttribute('href').slice(1);
    var el=document.getElementById(id);
    if(el){e.preventDefault();el.scrollIntoView({behavior:'smooth',block:'start'});}
  });
});

// ── Scroll progress bar ───────────────────────────────────────────
(function(){
  var bar = document.getElementById('scroll-bar');
  if(!bar) return;
  window.addEventListener('scroll', function(){
    var st = window.scrollY;
    var dh = document.documentElement.scrollHeight - window.innerHeight;
    bar.style.width = (dh > 0 ? Math.min(100, (st/dh)*100) : 0) + '%';
  }, {passive:true});
})();

// ── Mobile nav toggle ─────────────────────────────────────────────
function toggleMobNav(){
  var ham = document.getElementById('navHam');
  var nav = document.getElementById('mobNav');
  var open = nav.classList.toggle('open');
  ham.classList.toggle('open', open);
  document.body.style.overflow = open ? 'hidden' : '';
}
function closeMobNav(){
  document.getElementById('mobNav').classList.remove('open');
  document.getElementById('navHam').classList.remove('open');
  document.body.style.overflow = '';
}

// ── Active nav link tracking ──────────────────────────────────────
(function(){
  var sections = ['curators','drops','how-it-works','subscribe'];
  var links = document.querySelectorAll('.nav-links a[data-section]');
  var io = new IntersectionObserver(function(entries){
    entries.forEach(function(e){
      if(e.isIntersecting){
        links.forEach(function(l){ l.classList.remove('nav-active'); });
        var active = document.querySelector('.nav-links a[data-section="'+e.target.id+'"]');
        if(active) active.classList.add('nav-active');
      }
    });
  },{threshold:0.3});
  sections.forEach(function(id){
    var el = document.getElementById(id);
    if(el) io.observe(el);
  });
})();

// ── Hero parallax — subtle drift only, no opacity fade (prevents scroll sticking) ──
(function(){
  var hero = document.querySelector('.hero');
  if(!hero || window.matchMedia('(prefers-reduced-motion:reduce)').matches) return;
  if(window.matchMedia('(hover:none)').matches) return; // skip on touch/mobile
  window.addEventListener('scroll', function(){
    var y = window.scrollY;
    hero.style.transform = 'translateY('+( y * 0.12)+'px)';
  }, {passive:true});
})();

// ── Magnetic CTA buttons ──────────────────────────────────────────
(function(){
  if(window.matchMedia('(hover:none)').matches) return; // skip touch
  document.querySelectorAll('.btn-fill, .nav-cta').forEach(function(btn){
    btn.addEventListener('mousemove', function(e){
      var r = btn.getBoundingClientRect();
      var dx = (e.clientX - (r.left + r.width/2)) * 0.22;
      var dy = (e.clientY - (r.top  + r.height/2)) * 0.22;
      btn.style.transform = 'translate('+dx+'px,'+dy+'px)';
    });
    btn.addEventListener('mouseleave', function(){
      btn.style.transform = '';
    });
  });
})();

// ── Staggered mobile nav link entrance ───────────────────────────
(function(){
  var nav = document.getElementById('mobNav');
  if(!nav) return;
  var links = nav.querySelectorAll('a, button');
  var obs = new MutationObserver(function(){
    if(nav.classList.contains('open')){
      links.forEach(function(l, i){
        l.style.transitionDelay = (i * 0.07 + 0.15) + 's';
        l.style.opacity = '1';
        l.style.transform = 'none';
      });
    } else {
      links.forEach(function(l){
        l.style.transitionDelay = '0s';
        l.style.opacity = '';
        l.style.transform = '';
      });
    }
  });
  obs.observe(nav, {attributes:true, attributeFilter:['class']});
})();
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
    const { rows } = await db.query('SELECT id, name, bio, statement, image_url, instagram, curator_month FROM curators ORDER BY name ASC');
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
          body: 'Undeniable Hits: Reply YES to confirm you want curator text drops. 1-2 msgs/month. Reply STOP to opt out.',
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


// ── GET /curator/:slug — Curator intro page (Friday teaser, no song) ─────────
app.get('/curator/:slug', async (req, res) => {
  const slug = req.params.slug.toLowerCase().replace(/-/g, '');
  try {
    const { rows } = await db.query(
      `SELECT * FROM curators WHERE LOWER(REPLACE(name,' ',''))=$1 LIMIT 1`, [slug]
    );
    if (!rows.length) return res.status(404).send('<h1>Curator not found.</h1>');
    const c = rows[0];
    const firstName = c.name.split(' ')[0];
    const month = c.curator_month || 'this month';
    const base = process.env.BASE_URL || '';
    const headshotUrl = c.image_url?.startsWith('data:') ? `${base}/curator-image/${c.id}` : (c.image_url || '');
    const playlistUrl = c.playlist_image_url?.startsWith('data:') ? `${base}/curator-playlist-image/${c.id}` : (c.playlist_image_url || '');

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${c.name} · Undeniable Hits</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%;background:#000;color:#f3f1ea;font-family:Georgia,'Times New Roman',serif}
.page{min-height:100vh;display:flex;flex-direction:column}

/* Hero */
.hero{position:relative;height:65vh;min-height:380px;overflow:hidden;background:#111}
.hero-img{width:100%;height:100%;object-fit:cover;opacity:.7;display:block}
.hero-img-placeholder{width:100%;height:100%;background:linear-gradient(160deg,#1a1a1a,#0a0a0a);display:flex;align-items:center;justify-content:center;font-size:80px}
.hero-overlay{position:absolute;inset:0;background:linear-gradient(to bottom,rgba(0,0,0,0.1) 40%,rgba(0,0,0,0.92) 100%)}
.hero-content{position:absolute;bottom:0;left:0;right:0;padding:32px 28px 36px}
.hero-eyebrow{font-size:9px;letter-spacing:.38em;text-transform:uppercase;color:rgba(243,241,234,0.4);margin-bottom:10px}
.hero-name{font-size:clamp(36px,8vw,64px);font-weight:700;line-height:1;color:#f3f1ea;letter-spacing:-.02em}
.hero-month{font-size:11px;letter-spacing:.3em;text-transform:uppercase;color:#E8B84B;margin-top:8px;opacity:.85}

/* Body */
.body{padding:36px 28px 48px;max-width:540px;margin:0 auto;width:100%;flex:1}
.coming-badge{display:inline-flex;align-items:center;gap:8px;padding:8px 16px;border:1px solid rgba(232,184,75,0.3);border-radius:2px;background:rgba(232,184,75,0.06);margin-bottom:28px}
.coming-dot{width:6px;height:6px;border-radius:50%;background:#E8B84B;animation:pulse 1.8s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.7)}}
.coming-text{font-size:9px;letter-spacing:.32em;text-transform:uppercase;color:#E8B84B}
.bio{font-size:16px;line-height:1.65;color:rgba(243,241,234,0.65);margin-bottom:32px;font-style:italic}
.divider{height:1px;background:rgba(243,241,234,0.08);margin-bottom:32px}

/* Playlist preview card */
.playlist-card{display:flex;align-items:center;gap:16px;background:rgba(255,255,255,0.04);border:1px solid rgba(243,241,234,0.08);border-radius:4px;padding:16px;margin-bottom:28px}
.playlist-art{width:64px;height:64px;border-radius:3px;object-fit:cover;flex-shrink:0;background:#1a1a1a}
.playlist-art-placeholder{width:64px;height:64px;border-radius:3px;background:#1a1a1a;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:28px}
.playlist-info{flex:1;min-width:0}
.playlist-eyebrow{font-size:8px;letter-spacing:.35em;text-transform:uppercase;color:rgba(243,241,234,0.3);margin-bottom:6px}
.playlist-label{font-size:14px;font-weight:700;color:#f3f1ea;line-height:1.2}
.playlist-sub{font-size:11px;color:rgba(243,241,234,0.35);margin-top:4px;letter-spacing:.05em}

/* Follow form */
.follow-label{font-size:9px;letter-spacing:.35em;text-transform:uppercase;color:rgba(243,241,234,0.3);margin-bottom:14px}
.follow-input{width:100%;padding:18px 20px;background:rgba(255,255,255,0.04);border:1px solid rgba(243,241,234,0.12);border-radius:4px;color:#f3f1ea;font-family:Georgia,serif;font-size:16px;outline:none;transition:border-color .2s;margin-bottom:12px}
.follow-input:focus{border-color:rgba(232,184,75,0.5)}
.follow-btn{width:100%;padding:20px;background:#f3f1ea;color:#000;font-family:Georgia,serif;font-size:15px;font-weight:700;letter-spacing:.06em;border:none;border-radius:4px;cursor:pointer;transition:opacity .2s}
.follow-btn:hover{opacity:.88}
.follow-msg{text-align:center;font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:#E8B84B;min-height:20px;padding:14px 0 0;opacity:0;transition:opacity .4s}
.follow-msg.show{opacity:1}
.terms{font-size:10px;color:rgba(243,241,234,0.2);text-align:center;margin-top:14px;letter-spacing:.05em}

/* Nav */
.nav{position:fixed;top:0;left:0;right:0;padding:18px 24px;display:flex;justify-content:space-between;align-items:center;z-index:10;background:linear-gradient(to bottom,rgba(0,0,0,0.6),transparent)}
.nav-logo{font-size:11px;letter-spacing:.38em;text-transform:uppercase;color:rgba(243,241,234,0.6);text-decoration:none}
</style>
</head>
<body>
<nav class="nav">
  <a class="nav-logo" href="${base}">UHT</a>
</nav>

<div class="page">
  <div class="hero">
    ${headshotUrl
      ? `<img class="hero-img" src="${headshotUrl}" alt="${c.name}">`
      : `<div class="hero-img-placeholder">🎧</div>`}
    <div class="hero-overlay"></div>
    <div class="hero-content">
      <div class="hero-eyebrow">Curator of the Month · ${month}</div>
      <div class="hero-name">${c.name}</div>
      <div class="hero-month">Undeniable Hits</div>
    </div>
  </div>

  <div class="body">
    <div class="coming-badge">
      <div class="coming-dot"></div>
      <span class="coming-text">${firstName}'s picks drop every Monday</span>
    </div>

    ${c.statement ? `<p class="bio">"${c.statement}"</p>` : (c.bio ? `<p class="bio">"${c.bio}"</p>` : '')}

    ${playlistUrl ? `
    <div class="playlist-card">
      <img class="playlist-art" src="${playlistUrl}" alt="Playlist">
      <div class="playlist-info">
        <div class="playlist-eyebrow">Playlist · ${month}</div>
        <div class="playlist-label">${firstName}'s Selections</div>
        <div class="playlist-sub">Subscribe to get his picks every Monday</div>
      </div>
    </div>` : ''}

    <div class="divider"></div>

    <div class="follow-label">Follow ${firstName} — get his picks every Monday</div>
    <input class="follow-input" id="phone" type="tel" placeholder="+1 (555) 000-0000" inputmode="tel">
    <button class="follow-btn" onclick="submitFollow()">Follow ${firstName} →</button>
    <div class="follow-msg" id="followMsg"></div>
    <p class="terms">Free · Text only · Reply STOP anytime</p>
  </div>
</div>

<script>
function submitFollow(){
  var phone=document.getElementById('phone').value.trim();
  var msg=document.getElementById('followMsg');
  if(!phone){document.getElementById('phone').style.borderColor='rgba(232,184,75,0.5)';return;}
  document.querySelector('.follow-btn').disabled=true;
  fetch('/api/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({phone:phone,curator_id:${c.id}})})
  .then(function(r){return r.json();})
  .then(function(d){
    if(d.error){
      msg.textContent=d.error;
      msg.classList.add('show');
      document.querySelector('.follow-btn').disabled=false;
    } else {
      msg.textContent='You\\'re in. ${firstName}\\'s pick lands Monday.';
      msg.classList.add('show');
      document.querySelector('.follow-btn').style.display='none';
    }
  })
  .catch(function(){
    msg.textContent='Something went wrong. Try again.';
    msg.classList.add('show');
    document.querySelector('.follow-btn').disabled=false;
  });
}
</script>
</body>
</html>`);
  } catch(e) {
    console.error('/curator/:slug error:', e.message);
    res.status(500).send('<h1>Error loading curator page.</h1>');
  }
});

// ── GET /drop/curator/:slug ──────────────────────────────────────────────────
app.get('/drop/curator/:slug', async (req, res) => {
  if(req.query.ref !== 'sms') return res.redirect('/?src=drop#subscribe');
  const slug = req.params.slug.toLowerCase().replace(/-/g, '');
  try {
    const curatorRes = await db.query(
      `SELECT * FROM curators WHERE LOWER(REPLACE(name,' ',''))=$1 LIMIT 1`,
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
.pick-header{display:flex;gap:20px;align-items:flex-start;margin-bottom:10px}
.pick-art{width:88px;height:88px;border-radius:4px;object-fit:cover;flex-shrink:0;background:#1a1a1a}
.pick-text{flex:1;min-width:0}
.song-title{font-family:'Playfair Display',serif;font-size:clamp(32px,8vw,60px);font-weight:700;line-height:1.02;letter-spacing:-1.5px;color:#ede8df;margin-bottom:10px}
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
/* Listen lock */
.vote-lock{text-align:center;padding:8px 0 22px;transition:opacity .5s,max-height .6s ease,padding .6s ease;max-height:80px;overflow:hidden}
.vote-lock.unlocked{opacity:0;max-height:0;padding:0;pointer-events:none}
.vote-lock-label{font-size:9px;letter-spacing:.28em;text-transform:uppercase;color:rgba(237,232,223,0.3);margin-bottom:10px}
.vote-lock-bar{height:2px;background:rgba(237,232,223,0.08);border-radius:2px;margin:0 auto;max-width:160px;overflow:hidden}
.vote-lock-fill{height:100%;width:0%;background:#E8B84B;transition:width .9s linear}
.vote-btns-wrap{transition:opacity .5s}
.vote-btns-wrap.locked{opacity:.22;pointer-events:none}
@media(min-width:600px){
  .vote-row{flex-direction:row}
  .vote-btn{flex:1}
}
@media(min-width:900px){
  .page{max-width:1100px}
  .hero{aspect-ratio:16/9;max-height:72vh}
  .c-name{font-size:clamp(64px,8vw,110px)}
  .bio{padding:56px 80px}
  .pick{padding:64px 80px 48px}
  .below-player{padding:16px 48px 8px}
  .vote-section{padding:44px 80px}
  .archive{padding:56px 80px 28px}
  .bottom{padding:24px 80px 80px}
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
  <div class="stamp-brand">Undeniable Hits</div>
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
  <div class="pick-header">
    ${curator.playlist_image_url ? `<img class="pick-art" src="${curator.playlist_image_url}" alt="Playlist art">` : ''}
    <div class="pick-text">
      <div class="song-title">${d.title}</div>
      <div class="song-artist">${d.artist}</div>
    </div>
  </div>
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
  <div class="vote-lock" id="voteLock">
    <div class="vote-lock-label" id="lockLabel">Listen for 60s to unlock your vote</div>
    <div class="vote-lock-bar"><div class="vote-lock-fill" id="lockFill"></div></div>
  </div>
  <div class="vote-btns-wrap locked" id="voteBtns">
    <div class="vote-label">Is this an undeniable hit?</div>
    <div class="vote-row">
      <button class="vote-btn" id="vMega" onclick="vote('mega_hit')">🔥 Mega Hit</button>
      <button class="vote-btn" id="vHit" onclick="vote('hit')">🎯 Hit</button>
      <button class="vote-btn" id="vDenied" onclick="vote('deny')">💀 Denied</button>
    </div>
    <div class="vote-msg" id="voteMsg"></div>
  </div>
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
  player=new YT.Player('player',{videoId:'${ytId}',playerVars:{rel:0,modestbranding:1,playsinline:1},
    events:{onStateChange:function(e){
      if(e.data===1) startListenTimer(); else pauseListenTimer();
    }}
  });
}
</script>` : ''}

<script>
var _listenSecs=0,_unlocked=false,_lockIv=null,_LOCK=60;
function startListenTimer(){
  if(_lockIv||_unlocked) return;
  _lockIv=setInterval(function(){
    if(_unlocked) return;
    _listenSecs++;
    var pct=Math.min(100,(_listenSecs/_LOCK)*100);
    var fill=document.getElementById('lockFill');
    if(fill) fill.style.width=pct+'%';
    var lbl=document.getElementById('lockLabel');
    var rem=Math.max(0,_LOCK-_listenSecs);
    if(lbl&&rem>0) lbl.textContent=rem+'s left to unlock your vote';
    if(_listenSecs>=_LOCK) unlockVote();
  },1000);
}
function pauseListenTimer(){ clearInterval(_lockIv); _lockIv=null; }
function unlockVote(){
  if(_unlocked) return; _unlocked=true; pauseListenTimer();
  var lock=document.getElementById('voteLock');
  var btns=document.getElementById('voteBtns');
  if(lock) lock.classList.add('unlocked');
  if(btns) btns.classList.remove('locked');
}
// Fallback: if no YT player, start on page load
${ytId ? '' : 'startListenTimer();'}
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
  if(req.params.genre.toLowerCase() === 'rock') return res.redirect('/?src=drop#subscribe');
  if(req.query.ref !== 'sms') return res.redirect('/?src=drop#subscribe');
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
.vote-lock{text-align:center;padding:8px 0 22px;transition:opacity .5s,max-height .6s ease,padding .6s ease;max-height:80px;overflow:hidden}
.vote-lock.unlocked{opacity:0;max-height:0;padding:0;pointer-events:none}
.vote-lock-label{font-size:9px;letter-spacing:.28em;text-transform:uppercase;color:rgba(243,241,234,0.3);margin-bottom:10px}
.vote-lock-bar{height:2px;background:rgba(243,241,234,0.08);border-radius:2px;margin:0 auto;max-width:160px;overflow:hidden}
.vote-lock-fill{height:100%;width:0%;background:#E8B84B;transition:width .9s linear}
.vote-btns-wrap{transition:opacity .5s}
.vote-btns-wrap.locked{opacity:.22;pointer-events:none}
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
    <div class="vote-lock" id="voteLock">
      <div class="vote-lock-label" id="lockLabel">Listen for 60s to unlock your vote</div>
      <div class="vote-lock-bar"><div class="vote-lock-fill" id="lockFill"></div></div>
    </div>
    <div class="vote-btns-wrap locked" id="voteBtns">
      <div class="vote-label">Is this an undeniable hit?</div>
      <div class="vote-row">
        <button class="vote-btn" id="vMega" onclick="castVote('mega_hit')">🔥 Mega Hit</button>
        <button class="vote-btn" id="vHit" onclick="castVote('hit')">🎯 Hit</button>
        <button class="vote-btn" id="vDenied" onclick="castVote('denied')">💀 Denied</button>
      </div>
      <div class="vote-msg" id="voteConfirm"></div>
      <button class="share-btn" id="shareBtn" onclick="shareVote()">↗ Share this pick</button>
    </div>
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
    startListenTimer();
  } else {
    pauseListenTimer();
  }
}
function checkTime(){
  if(!player||shown) return;
  var c=player.getCurrentTime(), d=player.getDuration();
  if(d&&(d-c<=10)){document.getElementById('endMessage').classList.add('show');shown=true;}
}
</script>` : ''}

<script>
var _listenSecs=0,_unlocked=false,_lockIv=null,_LOCK=60;
function startListenTimer(){
  if(_lockIv||_unlocked) return;
  _lockIv=setInterval(function(){
    if(_unlocked) return;
    _listenSecs++;
    var pct=Math.min(100,(_listenSecs/_LOCK)*100);
    var fill=document.getElementById('lockFill');
    if(fill) fill.style.width=pct+'%';
    var lbl=document.getElementById('lockLabel');
    var rem=Math.max(0,_LOCK-_listenSecs);
    if(lbl&&rem>0) lbl.textContent=rem+'s left to unlock your vote';
    if(_listenSecs>=_LOCK) unlockVote();
  },1000);
}
function pauseListenTimer(){ clearInterval(_lockIv); _lockIv=null; }
function unlockVote(){
  if(_unlocked) return; _unlocked=true; pauseListenTimer();
  var lock=document.getElementById('voteLock');
  var btns=document.getElementById('voteBtns');
  if(lock) lock.classList.add('unlocked');
  if(btns) btns.classList.remove('locked');
}
${ytId ? '' : 'startListenTimer();'}
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
  const { title, artist, url, youtube_url, genre_id, curator_id } = req.body;
  if (!title || !artist) return res.status(400).json({ error: 'title and artist required.' });
  try {
    const { rows } = await db.query(
      `INSERT INTO songs (title, artist, url, youtube_url, genre_id, curator_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [title, artist, url || null, youtube_url || null, genre_id || null, curator_id || null]
    );
    res.json({ song: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/songs/:id ─────────────────────────────────────────────────────
app.patch('/api/songs/:id', async (req, res) => {
  const { title, artist, url, youtube_url, genre_id, curator_id } = req.body;
  if (!title || !artist) return res.status(400).json({ error: 'title and artist required.' });
  try {
    const { rows } = await db.query(
      `UPDATE songs SET title=$1, artist=$2, url=$3, youtube_url=$4, genre_id=$5, curator_id=$6
       WHERE id=$7 RETURNING *`,
      [title, artist, url || null, youtube_url || null, genre_id || null, curator_id || null, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Song not found.' });
    res.json({ song: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/songs/:id ─────────────────────────────────────────────────────
app.delete('/api/songs/:id', async (req, res) => {
  const { id } = req.params;
  try {
    // Remove dependent records first to satisfy FK constraints
    await db.query('DELETE FROM votes     WHERE song_id = $1', [id]);
    await db.query('DELETE FROM song_votes WHERE song_id = $1', [id]).catch(() => {});
    await db.query('DELETE FROM deliveries WHERE song_id = $1', [id]);
    await db.query('DELETE FROM songs WHERE id = $1', [id]);
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
  const { name, bio, statement, image_url, playlist_image_url, instagram, curator_month, monthly_theme } = req.body;
  if (!name) return res.status(400).json({ error: 'name required.' });
  try {
    const { rows } = await db.query(
      `INSERT INTO curators (name, bio, statement, image_url, playlist_image_url, instagram, curator_month, monthly_theme) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [name, bio || null, statement || null, image_url || null, playlist_image_url || null, instagram || null, curator_month || null, monthly_theme || null]
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

// ── POST /api/curators/:id/reset-drops — wipe deliveries + votes for a curator's songs ──
app.post('/api/curators/:id/reset-drops', async (req, res) => {
  const { id } = req.params;
  try {
    // Get all song IDs for this curator
    const { rows: songs } = await db.query('SELECT id FROM songs WHERE curator_id=$1', [id]);
    const songIds = songs.map(s => s.id);

    if (!songIds.length) return res.json({ ok: true, votes: 0, deliveries: 0, message: 'No songs found for this curator.' });

    // Delete votes
    const vRes = await db.query('DELETE FROM votes WHERE song_id = ANY($1)', [songIds]);
    // Delete song_votes (curator intelligence table)
    await db.query('DELETE FROM song_votes WHERE song_id = ANY($1)', [songIds]).catch(() => {});
    // Delete deliveries
    const dRes = await db.query('DELETE FROM deliveries WHERE song_id = ANY($1)', [songIds]);

    console.log(`[ResetDrops] Curator ${id}: deleted ${vRes.rowCount} votes, ${dRes.rowCount} deliveries`);
    res.json({ ok: true, votes: vRes.rowCount, deliveries: dRes.rowCount });
  } catch(e) { res.status(500).json({ error: e.message }); }
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

// ── PATCH /api/subscribers/:id  (pause/resume + genre/curator update) ────────
app.patch('/api/subscribers/:id', async (req, res) => {
  const { is_active, genre_id, curator_id } = req.body;
  try {
    if (is_active !== undefined) {
      await db.query('UPDATE subscriptions SET is_active=$1 WHERE id=$2', [is_active, req.params.id]);
    }
    if (genre_id !== undefined || curator_id !== undefined) {
      await db.query(
        'UPDATE subscriptions SET genre_id=$1, curator_id=$2 WHERE id=$3',
        [genre_id || null, curator_id || null, req.params.id]
      );
    }
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
      SELECT v.*, u.phone, u.name, u.email, s.title, s.artist
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
  const { name, bio, statement, image_url, playlist_image_url, instagram, curator_month, monthly_theme } = req.body;
  if (!name) return res.status(400).json({ error: 'name required.' });
  try {
    // Only overwrite image fields if a value is explicitly provided — prevents wiping images on metadata-only saves
    const fields = ['name=$1','bio=$2','statement=$3','instagram=$4','curator_month=$5','monthly_theme=$6'];
    const vals = [name, bio||null, statement||null, instagram||null, curator_month||null, monthly_theme||null];
    let idx = vals.length + 1;
    if (image_url !== undefined) { fields.push(`image_url=$${idx++}`); vals.push(image_url||null); }
    if (playlist_image_url !== undefined) { fields.push(`playlist_image_url=$${idx++}`); vals.push(playlist_image_url||null); }
    vals.push(req.params.id);
    const { rows } = await db.query(
      `UPDATE curators SET ${fields.join(',')} WHERE id=$${idx} RETURNING *`, vals
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
  <div class="eyebrow">Undeniable Hits</div>
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

// ── One-time migration: add statement column to curators ──────────────────────
app.post('/api/migrate-curator-statement', async (req, res) => {
  try {
    await db.query(`ALTER TABLE curators ADD COLUMN IF NOT EXISTS statement TEXT`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
const { runCuratorDrop: _runCuratorDrop, runCuratorIntroBlast } = require('./curator-scheduler');

// ── POST /api/curator-intro/send — manual Friday intro blast ─────────────────
app.post('/api/curator-intro/send', async (req, res) => {
  const { curator_id } = req.body;
  if (!curator_id) return res.status(400).json({ error: 'curator_id required' });
  try {
    const r = await runCuratorIntroBlast(curator_id);
    res.json({ ok: true, ...r });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /curator-image/:id — serve curator headshot from DB (supports base64 or redirect) ──
app.get('/curator-image/:id', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT image_url FROM curators WHERE id=$1 LIMIT 1', [req.params.id]);
    if (!rows.length || !rows[0].image_url) return res.status(404).send('Not found');
    const url = rows[0].image_url;
    if (url.startsWith('data:')) {
      const [meta, b64] = url.split(',');
      const mime = meta.match(/data:([^;]+)/)[1];
      res.set('Content-Type', mime);
      res.set('Cache-Control', 'public, max-age=86400');
      return res.send(Buffer.from(b64, 'base64'));
    }
    res.redirect(url);
  } catch(e) { res.status(500).send(e.message); }
});

// ── GET /curator-playlist-image/:id — serve curator playlist art from DB ──────
app.get('/curator-playlist-image/:id', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT playlist_image_url FROM curators WHERE id=$1 LIMIT 1', [req.params.id]);
    if (!rows.length || !rows[0].playlist_image_url) return res.status(404).send('Not found');
    const url = rows[0].playlist_image_url;
    if (url.startsWith('data:')) {
      const [meta, b64] = url.split(',');
      const mime = meta.match(/data:([^;]+)/)[1];
      res.set('Content-Type', mime);
      res.set('Cache-Control', 'public, max-age=86400');
      return res.send(Buffer.from(b64, 'base64'));
    }
    res.redirect(url);
  } catch(e) { res.status(500).send(e.message); }
});

// ── POST /api/curator-intro/test — send intro to a single phone ──────────────
app.post('/api/curator-intro/test', async (req, res) => {
  const { curator_id, phone } = req.body;
  if (!curator_id || !phone) return res.status(400).json({ error: 'curator_id and phone required' });
  try {
    const { rows } = await db.query(`SELECT * FROM curators WHERE id=$1 LIMIT 1`, [curator_id]);
    if (!rows.length) return res.status(404).json({ error: 'Curator not found' });
    const c = rows[0];
    const base = process.env.BASE_URL || '';
    const slug = c.name.toLowerCase().replace(/\s+/g, '');
    const link = base ? `${base}/curator/${slug}?ref=sms`.replace('https://','') : null;
    const month = c.curator_month || 'this month';
    let body = `Meet ${c.name}! Our founding 1st Curator of the Month - ${month}. His first pick drops Monday.\n${link || ''}`;
    const msgParams = { from: process.env.TWILIO_FROM || process.env.TWILIO_PHONE_NUMBER, to: phone, body };
    const introImg = c.image_url?.startsWith('data:') ? `${base}/curator-image/${c.id}` : c.image_url;
    if (introImg) msgParams.mediaUrl = [introImg];
    await twilioClient.messages.create(msgParams);
    res.json({ ok: true, body });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/curator-drop/test — send a week N drop to a single phone ───────
app.post('/api/curator-drop/test', async (req, res) => {
  const { curator_id, phone, week } = req.body;
  if (!curator_id || !phone) return res.status(400).json({ error: 'curator_id and phone required' });
  try {
    const { buildCuratorMessage } = require('./curator-scheduler');
    const { rows: curators } = await db.query(`SELECT * FROM curators WHERE id=$1 LIMIT 1`, [curator_id]);
    if (!curators.length) return res.status(404).json({ error: 'Curator not found' });
    const c = curators[0];

    // Get the latest submission for this curator
    const { rows: songs } = await db.query(
      `SELECT * FROM curator_submissions WHERE curator_id=$1 ORDER BY week_number ASC LIMIT 1`,
      [curator_id]
    );

    const song = songs.length
      ? { ...songs[0], week_number: week || songs[0].week_number || 1 }
      : { title: '(no song yet)', artist: '—', week_number: week || 1, theme: null, curator_note: null };

    const base2 = process.env.BASE_URL || '';
    const headshot = c.image_url?.startsWith('data:') ? `${base2}/curator-image/${c.id}` : c.image_url;
    const playlistArt = c.playlist_image_url?.startsWith('data:') ? `${base2}/curator-playlist-image/${c.id}` : c.playlist_image_url;
    const { body, mediaUrl } = buildCuratorMessage(song, c.name, headshot, c.curator_month, playlistArt);
    const msgParams = { from: process.env.TWILIO_FROM || process.env.TWILIO_PHONE_NUMBER, to: phone, body };
    if (mediaUrl) msgParams.mediaUrl = [mediaUrl];
    await twilioClient.messages.create(msgParams);
    res.json({ ok: true, body, week: song.week_number, media: mediaUrl ? mediaUrl.slice(0,80) : 'no image' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Featured Drop table (auto-create on startup) ──────────────────────────────
db.query(`
  CREATE TABLE IF NOT EXISTS featured_drop (
    id          INTEGER PRIMARY KEY DEFAULT 1,
    youtube_url TEXT,
    spotify_url TEXT,
    artist      TEXT,
    title       TEXT,
    curator_note TEXT,
    updated_at  TIMESTAMPTZ DEFAULT NOW()
  )
`).catch(e => console.error('[startup] featured_drop table error:', e.message));

// ── GET /api/featured-drop ────────────────────────────────────────────────────
app.get('/api/featured-drop', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM featured_drop WHERE id=1');
    res.json(rows[0] || {});
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/featured-drop ────────────────────────────────────────────────────
app.put('/api/featured-drop', async (req, res) => {
  const { youtube_url, spotify_url, artist, title, curator_note } = req.body;
  try {
    const { rows } = await db.query(`
      INSERT INTO featured_drop (id, youtube_url, spotify_url, artist, title, curator_note, updated_at)
      VALUES (1, $1, $2, $3, $4, $5, NOW())
      ON CONFLICT (id) DO UPDATE SET
        youtube_url  = EXCLUDED.youtube_url,
        spotify_url  = EXCLUDED.spotify_url,
        artist       = EXCLUDED.artist,
        title        = EXCLUDED.title,
        curator_note = EXCLUDED.curator_note,
        updated_at   = NOW()
      RETURNING *
    `, [youtube_url||null, spotify_url||null, artist||null, title||null, curator_note||null]);
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => {
  console.log(`\nUHT server running on port ${PORT}`);
  console.log(`  API:     GET  http://localhost:${PORT}/api/genres`);
  console.log(`  API:     GET  http://localhost:${PORT}/api/curators`);
  console.log(`  API:     POST http://localhost:${PORT}/api/subscribe`);
  console.log(`  Webhook: POST http://localhost:${PORT}/sms\n`);
});
