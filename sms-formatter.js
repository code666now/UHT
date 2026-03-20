// SMS DROP FORMATTER
function formatDropSMS({ curatorName, theme, week, artist, track, note }) {
  return [
    `🎵 UHT — Week ${week}`,
    `Curator: ${curatorName}`,
    `Theme: ${theme}`,
    ``,
    `${artist} — ${track}`,
    ``,
    note ? `"${note}"` : null,
    ``,
    `Reply:`,
    `1 — Hit`,
    `2 — Deny`,
    `3 — Ultra Hit`,
  ].filter(line => line !== null).join('\n');
}

// 1 = Hit, 2 = Deny, 3 = Ultra Hit, anything else = IGNORE (not stored)
function parseVoteReply(body) {
  const normalized = (body || '').trim();
  if (normalized === '1') return 'hit';
  if (normalized === '2') return 'deny';
  if (normalized === '3') return 'ultra_hit';
  return null;
}

module.exports = { formatDropSMS, parseVoteReply };
