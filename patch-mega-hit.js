const fs = require('fs');
let s = fs.readFileSync('server.js', 'utf8');

// 1. SMS inbound (support BOTH ultra + mega)
s = s.replace(
  /else if \(upper === 'ULTRA HIT' \|\| upper === '3'\) voteValue = 'ultra_hit';/,
  `else if (upper === 'MEGA HIT' || upper === 'ULTRA HIT' || upper === '3') voteValue = 'mega_hit';`
);

// 2. Legacy fallback
s = s.replaceAll(
  `voteValue === 'ultra_hit'`,
  `voteValue === 'mega_hit'`
);

// 3. Emoji
s = s.replaceAll(
  `voteValue === 'ultra_hit'`,
  `voteValue === 'mega_hit'`
);

// 4. Validation
s = s.replaceAll(`'ultra_hit'`, `'mega_hit'`);

// 5. Stats + queries
s = s.replaceAll(`ultra_hit`, `mega_hit`);
s = s.replaceAll(`ultra_hits`, `mega_hits`);

fs.writeFileSync('server.js', s);
console.log('✅ ultra_hit → mega_hit patch applied safely');
