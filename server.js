const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const QUESTION_PACKS = require('./questions');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Health check for hosts / uptime monitors
app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
const ROUND_SECONDS = 30;   // time to answer each question
const REVEAL_SECONDS = 12;  // auto-advance after reveal

/* ---------- Drex semantic answer matching (optional, graceful fallback) ----------
   Set DREX_API_KEY to let Drex judge whether two answers mean the same thing,
   with partial credit for close-but-not-identical answers. Without a key (or if
   the API is unreachable) the local fuzzy matcher is used instead. */
const DREX_API_KEY = process.env.DREX_API_KEY || '';
const DREX_URL = 'https://drex.nace.ai/v1/systemone';

async function drexSimilarity(a, b) {
  if (!DREX_API_KEY) return null;
  const x = String(a || '').trim(), y = String(b || '').trim();
  if (!x || !y) return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(DREX_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${DREX_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'drex-latest',
        state: `Answer 1: "${x}"\nAnswer 2: "${y}"`,
        questions: {
          same: {
            type: 'noul',
            instructions: 'Do these two answers mean essentially the same thing? Ignore differences in wording, case, and punctuation.',
          },
        },
      }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const data = await res.json();
    const p = data && data.answers && data.answers.same && data.answers.same.noul;
    return typeof p === 'number' ? Math.min(1, Math.max(0, p)) : null;
  } catch {
    return null;
  }
}

const rooms = new Map();
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const VALID_PACKS = ['all', 'sweet', 'funny', 'spicy'];

function makeCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function cleanName(name) {
  return String(name || '').trim().slice(0, 16);
}

/* ---------- fuzzy answer matching (typo / case / punctuation tolerant) ---------- */
function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array(n + 1), cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

function answersMatch(a, b) {
  const x = normalize(a), y = normalize(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const dist = levenshtein(x, y);
  return dist <= Math.max(1, Math.floor(Math.max(x.length, y.length) * 0.25));
}

/* ---------- room helpers ---------- */
function getRoom(socket) {
  const code = socket.data.roomCode;
  return code ? rooms.get(code) : null;
}

function publicPlayers(room) {
  return room.players.map(p => ({ id: p.id, name: p.name, score: p.score, isHost: p.isHost }));
}

function emitLobby(room) {
  io.to(room.code).emit('lobby-update', {
    code: room.code,
    players: publicPlayers(room),
    settings: room.settings,
    state: room.state,
  });
}

function removePlayer(socket) {
  const room = getRoom(socket);
  if (!room) return;
  clearTimeout(room.timer);
  room.players = room.players.filter(p => p.id !== socket.id);
  socket.leave(room.code);
  socket.data.roomCode = null;
  if (room.players.length === 0) {
    rooms.delete(room.code);
    return;
  }
  // remaining player becomes host, back to lobby
  room.players[0].isHost = true;
  room.state = 'lobby';
  io.to(room.code).emit('partner-left');
  emitLobby(room);
}

/* ---------- game flow ---------- */
function startRound(room) {
  room.state = 'answering';
  room.answers = {};
  room.advanced = false;
  const raw = room.questions[room.round];
  const star = room.players[room.starIdx];
  const question = raw.replaceAll('{name}', star.name);
  for (const p of room.players) {
    io.to(p.id).emit('round-start', {
      round: room.round + 1,
      total: room.questions.length,
      question,
      starName: star.name,
      isStar: p.id === star.id,
      timeLimit: ROUND_SECONDS,
      scores: publicPlayers(room),
    });
  }
  clearTimeout(room.timer);
  room.timer = setTimeout(() => {
    for (const p of room.players) {
      if (!(p.id in room.answers)) room.answers[p.id] = '';
    }
    doReveal(room);
  }, ROUND_SECONDS * 1000);
}

async function doReveal(room) {
  if (room.state !== 'answering') return;
  clearTimeout(room.timer);
  room.state = 'revealed'; // set before any await — keeps the guard race-safe
  const star = room.players[room.starIdx];
  const guesser = room.players[1 - room.starIdx];
  const starAnswer = String(room.answers[star.id] || '').slice(0, 140);
  const guessAnswer = String(room.answers[guesser.id] || '').slice(0, 140);

  // semantic similarity via Drex, falling back to the local fuzzy matcher
  let sim = await drexSimilarity(starAnswer, guessAnswer);
  if (sim == null) sim = answersMatch(starAnswer, guessAnswer) ? 1 : 0;

  let verdict = 'miss', starPts = 0, guessPts = 0;
  if (sim >= 0.75) {
    verdict = 'match';
    guessPts = 100; starPts = 50;
  } else if (sim >= 0.45) {
    verdict = 'partial';
    guessPts = 50; starPts = 25;
  }
  guesser.score += guessPts;
  star.score += starPts;
  io.to(room.code).emit('reveal', {
    round: room.round + 1,
    total: room.questions.length,
    question: room.questions[room.round].replaceAll('{name}', star.name),
    starName: star.name,
    guesserName: guesser.name,
    starAnswer,
    guessAnswer,
    match: verdict === 'match',
    partial: verdict === 'partial',
    verdict,
    similarity: Math.round(sim * 100) / 100,
    points: { [star.name]: starPts, [guesser.name]: guessPts },
    scores: publicPlayers(room),
    isLast: room.round + 1 >= room.questions.length,
  });
  room.timer = setTimeout(() => advance(room), REVEAL_SECONDS * 1000);
}

function advance(room) {
  if (room.state !== 'revealed' || room.advanced) return;
  room.advanced = true;
  clearTimeout(room.timer);
  room.round += 1;
  if (room.round >= room.questions.length) {
    room.state = 'over';
    const [a, b] = room.players;
    const winner = a.score === b.score ? null : (a.score > b.score ? a.name : b.name);
    io.to(room.code).emit('game-over', { scores: publicPlayers(room), winner });
  } else {
    room.starIdx = (room.starIdx + 1) % room.players.length;
    startRound(room);
  }
}

/* ---------- socket events ---------- */
io.on('connection', (socket) => {
  socket.on('create-room', ({ name }, cb) => {
    const clean = cleanName(name);
    if (!clean) return cb({ ok: false, error: 'Please enter your name first 💗' });
    const code = makeCode();
    const room = {
      code,
      players: [{ id: socket.id, name: clean, score: 0, isHost: true }],
      state: 'lobby',
      settings: { pack: 'all', rounds: 5 },
      questions: [],
      round: 0,
      starIdx: 0,
      answers: {},
      timer: null,
      advanced: false,
    };
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    cb({ ok: true, code });
    emitLobby(room);
  });

  socket.on('join-room', ({ code, name }, cb) => {
    const clean = cleanName(name);
    if (!clean) return cb({ ok: false, error: 'Please enter your name first 💗' });
    const c = String(code || '').trim().toUpperCase();
    const room = rooms.get(c);
    if (!room) return cb({ ok: false, error: 'Room not found — check the code 💔' });
    if (room.state !== 'lobby') return cb({ ok: false, error: 'That game already started 💔' });
    if (room.players.length >= 2) return cb({ ok: false, error: 'Room is full (2 players max) 💔' });
    room.players.push({ id: socket.id, name: clean, score: 0, isHost: false });
    socket.join(c);
    socket.data.roomCode = c;
    cb({ ok: true, code: c });
    emitLobby(room);
  });

  socket.on('update-settings', ({ pack, rounds }) => {
    const room = getRoom(socket);
    if (!room || room.state !== 'lobby') return;
    const me = room.players.find(p => p.id === socket.id);
    if (!me || !me.isHost) return;
    if (VALID_PACKS.includes(pack)) room.settings.pack = pack;
    const r = parseInt(rounds, 10);
    if (r >= 3 && r <= 10) room.settings.rounds = r;
    emitLobby(room);
  });

  socket.on('start-game', () => {
    const room = getRoom(socket);
    if (!room) return;
    const me = room.players.find(p => p.id === socket.id);
    if (!me || !me.isHost) return;
    if (room.players.length < 2) return;
    if (room.state !== 'lobby' && room.state !== 'over') return;
    const pool = room.settings.pack === 'all'
      ? [...QUESTION_PACKS.sweet, ...QUESTION_PACKS.funny, ...QUESTION_PACKS.spicy]
      : QUESTION_PACKS[room.settings.pack];
    room.questions = shuffle(pool).slice(0, room.settings.rounds);
    room.players.forEach(p => { p.score = 0; });
    room.round = 0;
    room.starIdx = Math.random() < 0.5 ? 0 : 1;
    startRound(room);
  });

  socket.on('submit-answer', ({ text }) => {
    const room = getRoom(socket);
    if (!room || room.state !== 'answering') return;
    if (!(room.players.some(p => p.id === socket.id))) return;
    room.answers[socket.id] = String(text || '').slice(0, 140);
    socket.to(room.code).emit('partner-answered');
    if (room.players.every(p => p.id in room.answers)) {
      doReveal(room);
    }
  });

  socket.on('next-round', () => {
    const room = getRoom(socket);
    if (room) advance(room);
  });

  socket.on('play-again', () => {
    const room = getRoom(socket);
    if (!room) return;
    room.state = 'lobby';
    room.players.forEach(p => { p.score = 0; });
    clearTimeout(room.timer);
    emitLobby(room);
  });

  socket.on('leave-room', () => removePlayer(socket));
  socket.on('disconnect', () => removePlayer(socket));
});

server.listen(PORT, () => {
  console.log(`💗 How Well Do You Know Me — http://localhost:${PORT}`);
});
