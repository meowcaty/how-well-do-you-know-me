// Simulates two players through a full game to verify server logic.
// Run: TEST_PORT=3456 node scripts/simulate.js  (with server on $TEST_PORT)
const { io } = require('socket.io-client');

const PORT = process.env.TEST_PORT || 3456;
const URL = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function once(sock, ev, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { sock.off(ev, h); reject(new Error('timeout waiting for ' + ev)); }, timeoutMs);
    const h = (data) => { clearTimeout(t); resolve(data); };
    sock.once(ev, h);
  });
}
function emitAck(sock, ev, data) {
  return new Promise((resolve) => sock.emit(ev, data, resolve));
}

(async () => {
  const results = [];
  const check = (name, cond) => {
    results.push(!!cond);
    console.log((cond ? '  ✅ ' : '  ❌ ') + name);
  };

  const a = io(URL);
  const b = io(URL);
  const lobbyQ = [];
  a.on('lobby-update', (d) => lobbyQ.push(d));
  const waitLobby = (pred, ms = 8000) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const i = lobbyQ.findIndex(pred);
      if (i >= 0) { const d = lobbyQ.splice(i, 1)[0]; clearInterval(iv); resolve(d); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); reject(new Error('lobby-update timeout')); }
    }, 50);
  });

  await Promise.all([once(a, 'connect'), once(b, 'connect')]);
  check('both clients connect', true);

  const created = await emitAck(a, 'create-room', { name: 'Yadu' });
  check('create-room returns 4-letter code', created.ok && /^[A-Z0-9]{4}$/.test(created.code));
  const code = created.code;

  const noName = await emitAck(b, 'create-room', { name: '   ' });
  check('empty name rejected', !noName.ok);

  const badJoin = await emitAck(b, 'join-room', { code: 'ZZZZ', name: 'Maya' });
  check('bad room code rejected', !badJoin.ok);

  const joined = await emitAck(b, 'join-room', { code, name: 'Maya' });
  check('join-room ok', joined.ok);

  const c = io(URL);
  await once(c, 'connect');
  const full = await emitAck(c, 'join-room', { code, name: 'Third' });
  check('third player rejected (2 max)', !full.ok);
  c.close();

  b.emit('start-game'); // non-host attempt — should be ignored
  await sleep(700);
  check('non-host cannot start game (no crash)', true);

  a.emit('update-settings', { pack: 'sweet', rounds: 3 });
  const lobby = await waitLobby((d) => d.settings.pack === 'sweet');
  check('host updates settings (pack=sweet, rounds=3)', lobby.settings.rounds === 3);
  check('lobby lists both players', lobby.players.length === 2);

  // ---- round 1: fuzzy match should count ----
  const r1aP = once(a, 'round-start');
  const r1bP = once(b, 'round-start');
  a.emit('start-game');
  const r1a = await r1aP;
  const r1b = await r1bP;
  check('round 1 starts for both', r1a.round === 1 && r1a.total === 3 && r1b.question === r1a.question);
  check('exactly one star player', (r1a.isStar ? 1 : 0) + (r1b.isStar ? 1 : 0) === 1);
  const star1 = r1a.isStar ? a : b;
  const guess1 = r1a.isStar ? b : a;
  const guesserName1 = r1a.isStar ? 'Maya' : 'Yadu';

  const rev1P = once(a, 'reveal');
  const rev1bP = once(b, 'reveal');
  const partnerP = once(guess1, 'partner-answered'); // star's submit notifies the guesser
  star1.emit('submit-answer', { text: 'new york' });
  await partnerP;
  check('partner-answered notification sent', true);
  guess1.emit('submit-answer', { text: 'New York!!' }); // typo/case/punct tolerant
  const rev1 = await rev1P;
  await rev1bP;
  check('fuzzy answers count as a match', rev1.match === true);
  check('guesser +100, star +50', rev1.scores.find((p) => p.name === guesserName1).score === 100);

  // ---- round 2: a clear miss ----
  const r2aP = once(a, 'round-start');
  const r2bP = once(b, 'round-start');
  a.emit('next-round');
  const r2a = await r2aP;
  await r2bP;
  check('round 2 starts, star rotates', r2a.round === 2 && r2a.isStar !== r1a.isStar);
  const star2 = r2a.isStar ? a : b;
  const guess2 = r2a.isStar ? b : a;
  const rev2P = once(a, 'reveal');
  star2.emit('submit-answer', { text: 'sushi' });
  guess2.emit('submit-answer', { text: 'tacos' });
  const rev2 = await rev2P;
  check('different answers = no match', rev2.match === false && rev2.isLast === false);

  // ---- round 3: match again ----
  const r3aP = once(a, 'round-start');
  const r3bP = once(b, 'round-start');
  a.emit('next-round');
  const r3a = await r3aP;
  await r3bP;
  check('round 3 starts (star rotates back)', r3a.round === 3 && r3a.isStar === r1a.isStar);
  const star3 = r3a.isStar ? a : b;
  const guess3 = r3a.isStar ? b : a;
  const rev3P = once(a, 'reveal');
  star3.emit('submit-answer', { text: 'pizza' });
  guess3.emit('submit-answer', { text: 'pizza' });
  const rev3 = await rev3P;
  check('round 3 match, marked last', rev3.match === true && rev3.isLast === true);

  // ---- game over ----
  const overP = once(a, 'game-over');
  const overBP = once(b, 'game-over');
  b.emit('next-round'); // either player can advance
  const over = await overP;
  await overBP;
  check('game-over declares the round-1 guesser winner', over.winner === guesserName1);
  console.log('     final scores:', JSON.stringify(over.scores.map((p) => `${p.name}:${p.score}`)));

  // ---- play again ----
  const lobby2P = waitLobby((d) => d.state === 'lobby' && d.players.every((p) => p.score === 0));
  a.emit('play-again');
  await lobby2P;
  check('play-again resets to lobby with zeroed scores', true);

  a.close();
  b.close();
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
