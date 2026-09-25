(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const socket = io();

  /* ================= anime.js v4 (safe if the CDN fails) ================= */
  const AN = window.anime || {};
  const hasAnim = typeof AN.animate === 'function';
  const anim = (t, p) => (hasAnim ? AN.animate(t, p) : null);
  const staggerOf = (n, o) => (hasAnim && AN.stagger ? AN.stagger(n, o) : 0);
  const springOf = (o) => (hasAnim && AN.spring ? AN.spring(o) : 'outExpo');
  const timelineOf = (o) => (hasAnim && AN.createTimeline ? AN.createTimeline(o) : null);

  /* ================= tiny sound synth ================= */
  let audioCtx = null;
  let muted = localStorage.getItem('hwdym_muted') === '1';
  function tone(freq, dur = 0.15, type = 'sine', vol = 0.1, delay = 0) {
    if (muted) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const t = audioCtx.currentTime + delay;
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = type;
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(audioCtx.destination);
      o.start(t);
      o.stop(t + dur + 0.05);
    } catch (e) { /* audio unavailable — stay silent */ }
  }
  const sfx = {
    click()  { tone(720, 0.06, 'sine', 0.05); },
    pop()    { tone(540, 0.1, 'triangle', 0.1); },
    tick()   { tone(880, 0.05, 'square', 0.035); },
    chime()  { tone(659, 0.14, 'triangle', 0.1); tone(880, 0.16, 'triangle', 0.1, 0.09); tone(1318, 0.24, 'sine', 0.09, 0.18); },
    sad()    { tone(330, 0.18, 'sine', 0.09); tone(262, 0.3, 'sine', 0.09, 0.14); },
    fanfare(){ [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.16, 'triangle', 0.1, i * 0.11)); },
  };
  const soundBtn = $('#sound-toggle');
  function renderSoundBtn() { soundBtn.textContent = muted ? '🔇' : '🔊'; }
  soundBtn.addEventListener('click', () => {
    muted = !muted;
    localStorage.setItem('hwdym_muted', muted ? '1' : '0');
    renderSoundBtn();
    if (!muted) sfx.pop();
  });
  renderSoundBtn();

  /* ================= state ================= */
  const state = {
    name: localStorage.getItem('hwdym_name') || '',
    code: '',
    isHost: false,
    players: [],
    settings: { pack: 'all', rounds: 5 },
    timerAnim: null,
    countdownInt: null,
    answered: false,
    scores: {},
  };
  if (state.name) $('#name-input').value = state.name;

  // invite link support: ?room=ABCD
  const inviteCode = new URLSearchParams(location.search).get('room');
  if (inviteCode) {
    $('#code-input').value = inviteCode.toUpperCase().slice(0, 4);
    $('#invite-hint').classList.remove('hidden');
  }

  /* ================= floating background hearts ================= */
  function spawnBgHearts() {
    const wrap = $('#bg-hearts');
    const emojis = ['💗', '💖', '💕', '🤍', '💜'];
    for (let i = 0; i < 14; i++) {
      const h = document.createElement('div');
      h.className = 'bg-heart';
      h.style.left = Math.random() * 100 + 'vw';
      h.style.fontSize = 14 + Math.random() * 26 + 'px';
      h.innerHTML = `<span class="inner">${emojis[i % emojis.length]}</span>`;
      wrap.appendChild(h);
      if (!hasAnim) { h.style.top = Math.random() * 100 + '%'; continue; }
      const rise = 14000 + Math.random() * 12000;
      anim(h, { translateY: [0, -(window.innerHeight + 240)], duration: rise, ease: 'linear', loop: true, delay: -Math.random() * rise });
      anim(h.querySelector('.inner'), {
        translateX: [0, 26], rotate: [-14, 14],
        duration: 2200 + Math.random() * 1800, ease: 'inOutSine', loop: true, alternate: true,
      });
    }
  }
  spawnBgHearts();

  /* ================= helpers ================= */
  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    anim(t, { opacity: [0, 1], translateY: [14, 0], duration: 300, ease: 'outExpo' });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      const a = anim(t, { opacity: [1, 0], duration: 300, ease: 'inExpo', onComplete: () => t.classList.add('hidden') });
      if (!a) t.classList.add('hidden');
    }, 2600);
  }

  let currentScreen = 'screen-home';
  function showScreen(id) {
    if (id === currentScreen) return;
    const from = document.getElementById(currentScreen);
    const to = document.getElementById(id);
    currentScreen = id;
    if (!hasAnim) { from.classList.add('hidden'); to.classList.remove('hidden'); return; }
    anim(from, {
      opacity: [1, 0], translateY: [0, -18], duration: 220, ease: 'inExpo',
      onComplete: () => {
        from.classList.add('hidden');
        to.classList.remove('hidden');
        anim(to, { opacity: [0, 1], translateY: [26, 0], scale: [0.98, 1], duration: 450, ease: springOf({ stiffness: 220, damping: 20 }) });
      },
    });
  }

  function splitLetters(el, text) {
    el.innerHTML = '';
    [...text].forEach((c) => {
      const s = document.createElement('span');
      s.className = 'ch';
      s.innerHTML = c === ' ' ? '&nbsp;' : c;
      el.appendChild(s);
    });
    return el.querySelectorAll('.ch');
  }

  function burstHearts(x, y, n = 14) {
    if (!hasAnim) return;
    for (let i = 0; i < n; i++) {
      const s = document.createElement('div');
      s.className = 'burst-heart';
      s.textContent = ['💗', '💖', '💕', '✨'][i % 4];
      s.style.left = x + 'px';
      s.style.top = y + 'px';
      document.body.appendChild(s);
      const ang = Math.random() * Math.PI * 2;
      const dist = 70 + Math.random() * 130;
      anim(s, {
        x: Math.cos(ang) * dist, y: Math.sin(ang) * dist - 40,
        scale: [0.4, 1.15], opacity: [1, 0], rotate: (Math.random() - 0.5) * 120,
        duration: 900 + Math.random() * 500, ease: 'outExpo',
        onComplete: () => s.remove(),
      });
    }
  }

  function confettiRain() {
    if (!hasAnim) return;
    const emojis = ['💗', '💖', '💕', '✨', '🎉', '💜'];
    for (let i = 0; i < 46; i++) {
      const s = document.createElement('div');
      s.className = 'confetti-heart';
      s.textContent = emojis[i % emojis.length];
      s.style.left = Math.random() * 100 + 'vw';
      s.style.fontSize = 14 + Math.random() * 22 + 'px';
      document.body.appendChild(s);
      anim(s, {
        translateY: [0, window.innerHeight + 120],
        rotate: [(Math.random() - 0.5) * 360, (Math.random() - 0.5) * 720],
        duration: 2400 + Math.random() * 1800, ease: 'inQuad', delay: Math.random() * 900,
        onComplete: () => s.remove(),
      });
    }
  }

  function countUp(el, from, to) {
    if (!hasAnim || from === to) { el.textContent = to; return; }
    const o = { v: from };
    anim(o, { v: to, duration: 900, ease: 'outExpo', onUpdate: () => { el.textContent = Math.round(o.v); } });
  }

  /* ================= home ================= */
  function myName() {
    const n = $('#name-input').value.trim().slice(0, 16);
    if (!n) { toast('Please enter your name first 💗'); $('#name-input').focus(); return null; }
    localStorage.setItem('hwdym_name', n);
    return n;
  }

  $('#btn-create').addEventListener('click', () => {
    const name = myName(); if (!name) return;
    sfx.click();
    socket.emit('create-room', { name }, (res) => {
      if (!res.ok) return toast(res.error);
      state.name = name; state.code = res.code;
      showScreen('screen-lobby');
    });
  });

  $('#btn-join').addEventListener('click', () => {
    const name = myName(); if (!name) return;
    const code = $('#code-input').value.trim().toUpperCase();
    if (code.length !== 4) { toast('Enter the 4-letter room code 💌'); return; }
    sfx.click();
    socket.emit('join-room', { code, name }, (res) => {
      if (!res.ok) return toast(res.error);
      state.name = name; state.code = res.code;
      history.replaceState(null, '', location.pathname);
      showScreen('screen-lobby');
    });
  });

  /* ================= lobby ================= */
  function renderLobby(data) {
    state.code = data.code;
    state.players = data.players;
    state.settings = data.settings;
    const me = data.players.find((p) => p.name === state.name);
    state.isHost = !!(me && me.isHost);

    $('#room-code').textContent = data.code;

    // players
    const wrap = $('#players');
    wrap.innerHTML = '';
    for (let i = 0; i < 2; i++) {
      const p = data.players[i];
      const slot = document.createElement('div');
      slot.className = 'player-slot';
      if (p) {
        const isMe = p.name === state.name;
        slot.innerHTML = `<div class="avatar ${isMe ? 'you' : ''}">${p.name[0].toUpperCase()}</div>
          <div class="player-name">${p.name}</div>
          <div class="player-tag">${isMe ? 'you 💫' : ''}${p.isHost ? ' 👑 host' : ''}</div>`;
      } else {
        slot.innerHTML = `<div class="avatar empty">?</div><div class="player-name">waiting…</div><div class="player-tag">send the invite link 💌</div>`;
      }
      wrap.appendChild(slot);
    }
    anim(wrap.children, { scale: [0.85, 1], opacity: [0, 1], duration: 450, delay: staggerOf(90), ease: springOf({ stiffness: 260, damping: 16 }) });

    // settings
    $$('#packs .pack').forEach((b) => b.classList.toggle('sel', b.dataset.pack === data.settings.pack));
    $('#rounds-val').textContent = data.settings.rounds;
    $('#settings-card').classList.toggle('locked', !state.isHost);

    const ready = data.players.length === 2;
    const showStart = state.isHost && ready;
    const wasShown = !$('#btn-start').classList.contains('hidden');
    $('#btn-start').classList.toggle('hidden', !showStart);
    $('#lobby-wait').classList.toggle('hidden', state.isHost || !ready);

    if (showStart && !wasShown) {
      anim('#btn-start', { scale: [0.6, 1], opacity: [0, 1], duration: 500, ease: springOf({ stiffness: 260, damping: 14 }) });
      state.startPulsing = anim('#btn-start', { scale: [1, 1.045], duration: 750, ease: 'inOutSine', loop: true, alternate: true, delay: 500 });
    } else if (!showStart && state.startPulsing && state.startPulsing.pause) {
      state.startPulsing.pause();
      state.startPulsing = null;
    }

    if (data.state === 'lobby' && (currentScreen === 'screen-game' || currentScreen === 'screen-over')) {
      showScreen('screen-lobby');
    }
  }

  $$('#packs .pack').forEach((b) => b.addEventListener('click', () => {
    if (!state.isHost) return;
    sfx.click();
    socket.emit('update-settings', { pack: b.dataset.pack, rounds: state.settings.rounds });
  }));
  $('#rounds-minus').addEventListener('click', () => {
    if (!state.isHost || state.settings.rounds <= 3) return;
    sfx.click();
    socket.emit('update-settings', { pack: state.settings.pack, rounds: state.settings.rounds - 1 });
  });
  $('#rounds-plus').addEventListener('click', () => {
    if (!state.isHost || state.settings.rounds >= 10) return;
    sfx.click();
    socket.emit('update-settings', { pack: state.settings.pack, rounds: state.settings.rounds + 1 });
  });

  $('#btn-start').addEventListener('click', () => { sfx.pop(); socket.emit('start-game'); });

  $('#btn-copy-code').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(state.code); toast('Code copied! Send it to your love 💌'); sfx.pop(); }
    catch (e) { toast('Code: ' + state.code); }
  });
  $('#btn-copy-link').addEventListener('click', async () => {
    const link = `${location.origin}${location.pathname}?room=${state.code}`;
    try { await navigator.clipboard.writeText(link); toast('Invite link copied! 💞'); sfx.pop(); }
    catch (e) { toast(link); }
  });
  $('#btn-leave').addEventListener('click', () => { socket.emit('leave-room'); showScreen('screen-home'); });

  /* ================= game ================= */
  function stopTimer() {
    if (state.timerAnim && state.timerAnim.pause) state.timerAnim.pause();
    state.timerAnim = null;
    clearInterval(state.countdownInt);
    state.countdownInt = null;
    const t = $('.timer');
    if (t) t.classList.remove('urgent');
  }

  function renderHudScores(scores) {
    const wrap = $('#hud-scores');
    wrap.innerHTML = '';
    scores.forEach((p) => {
      const d = document.createElement('div');
      d.className = 'hud-score';
      d.innerHTML = `${p.name} <b data-score="${p.name}">${p.score}</b>`;
      wrap.appendChild(d);
    });
  }

  socket.on('round-start', (d) => {
    stopTimer();
    state.answered = false;
    $('#game-play').classList.remove('hidden');
    $('#game-reveal').classList.add('hidden');
    showScreen('screen-game');

    $('#hud-round').textContent = `Question ${d.round}/${d.total}`;
    state.scores = {};
    renderHudScores(d.scores || []);

    // star banner
    const banner = $('#star-banner');
    banner.textContent = d.isStar ? `⭐ You're in the hot seat — be honest!` : `⭐ ${d.starName} is in the hot seat`;
    anim(banner, { scale: [0.7, 1], opacity: [0, 1], duration: 600, ease: springOf({ stiffness: 240, damping: 14 }) });

    // question letters cascade in
    const chars = splitLetters($('#question-text'), d.question);
    anim(chars, { translateY: [26, 0], opacity: [0, 1], rotate: [6, 0], duration: 480, delay: staggerOf(16), ease: 'outExpo' });

    // answer form
    $('#answer-label').textContent = d.isStar ? 'Your honest answer' : `Guess what ${d.starName} answered`;
    $('#answer-input').placeholder = d.isStar ? 'The truth, the whole truth…' : 'What would they say? 🤔';
    $('#answer-input').value = '';
    $('#answer-input').disabled = false;
    $('#answer-form').querySelector('button').disabled = false;
    setTimeout(() => $('#answer-input').focus(), 350);
    $('#waiting-pill').classList.add('hidden');
    $('#partner-pill').classList.add('hidden');

    // timer
    const fill = $('#timer-fill');
    fill.style.transform = 'scaleX(1)';
    let left = d.timeLimit;
    $('#timer-num').textContent = left;
    state.timerAnim = anim(fill, { scaleX: [1, 0], duration: d.timeLimit * 1000, ease: 'linear' });
    state.countdownInt = setInterval(() => {
      left -= 1;
      $('#timer-num').textContent = Math.max(0, left);
      if (left <= 10) { const t = $('.timer'); if (t) t.classList.add('urgent'); }
      if (left <= 5 && left > 0) sfx.tick();
      if (left <= 0) clearInterval(state.countdownInt);
    }, 1000);
  });

  // keep HUD scores fresh if server sends them with round-start

  $('#answer-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (state.answered) return;
    const text = $('#answer-input').value.trim();
    if (!text) { toast('Type an answer first ✍️'); return; }
    state.answered = true;
    sfx.pop();
    socket.emit('submit-answer', { text });
    $('#answer-input').disabled = true;
    $('#answer-form').querySelector('button').disabled = true;
    anim('#answer-form', { scale: [1, 0.96], duration: 200, ease: 'outExpo' });
    const w = $('#waiting-pill');
    w.classList.remove('hidden');
    anim(w, { opacity: [0, 1], translateY: [10, 0], duration: 300, ease: 'outExpo' });
  });

  socket.on('partner-answered', () => {
    const p = $('#partner-pill');
    p.classList.remove('hidden');
    anim(p, { scale: [0.8, 1], opacity: [0, 1], duration: 400, ease: springOf({ stiffness: 300, damping: 15 }) });
  });

  /* ---------- reveal ---------- */
  socket.on('reveal', (d) => {
    stopTimer();
    $('#game-play').classList.add('hidden');
    const rev = $('#game-reveal');
    rev.classList.remove('hidden');
    $('#reveal-cards').classList.add('hidden');
    const cd = $('#countdown');
    cd.classList.remove('hidden');

    if (!hasAnim) { showAnswers(d); return; } // CDN failed — skip the countdown theatre

    let n = 3;
    const step = () => {
      if (n === 0) { showAnswers(d); return; }
      cd.textContent = n;
      sfx.tick();
      anim(cd, { scale: [2.2, 1], opacity: [0, 1], duration: 380, ease: springOf({ stiffness: 320, damping: 13 }), onComplete: () => {
        setTimeout(() => { n -= 1; step(); }, 420);
      }});
    };
    step();
  });

  function showAnswers(d) {
    $('#countdown').classList.add('hidden');
    const cards = $('#reveal-cards');
    cards.classList.remove('hidden');

    $('#star-tag').textContent = `⭐ ${d.starName}'s answer`;
    $('#guesser-tag').textContent = `🔮 ${d.guesserName}'s guess`;
    const sa = $('#star-answer'), ga = $('#guesser-answer');
    sa.textContent = d.starAnswer || '(no answer 🙈)';
    ga.textContent = d.guessAnswer || '(no answer 🙈)';
    sa.classList.toggle('empty', !d.starAnswer);
    ga.classList.toggle('empty', !d.guessAnswer);
    $('#btn-next').textContent = d.isLast ? 'See results 🏆' : 'Next question ➜';

    const tl = timelineOf({ defaults: { ease: 'outExpo' } });
    if (tl) {
      tl.add('.ans-card', { rotateY: [90, 0], opacity: [0, 1], duration: 550 })
        .add('#verdict', { scale: [0.4, 1], opacity: [0, 1], duration: 500, ease: springOf({ stiffness: 260, damping: 12 }) }, '-=200')
        .add('.points-badge', { scale: [0, 1], opacity: [0, 1], duration: 400, ease: springOf({ stiffness: 300, damping: 14 }) }, '-=250')
        .add('#btn-next', { opacity: [0, 1], translateY: [14, 0], duration: 350 }, '-=150');
    } else {
      cards.style.opacity = 1;
    }

    // verdict
    const v = $('#verdict');
    setTimeout(() => {
      if (d.match) {
        v.textContent = "It's a match! 💞";
        v.className = 'verdict match';
        sfx.chime();
        const r = v.getBoundingClientRect();
        burstHearts(r.left + r.width / 2, r.top, 18);
      } else {
        v.textContent = 'So close! 🙈';
        v.className = 'verdict miss';
        sfx.sad();
        anim(v, { x: [0, -10, 10, -6, 6, 0], duration: 450, ease: 'inOutSine' });
      }
    }, hasAnim ? 650 : 0);

    // points badges
    const pr = $('#points-row');
    pr.innerHTML = '';
    Object.entries(d.points).forEach(([name, pts]) => {
      if (!pts) return;
      const b = document.createElement('div');
      b.className = 'points-badge';
      b.textContent = `${name} +${pts}`;
      pr.appendChild(b);
    });

    // score count-up in HUD
    setTimeout(() => {
      renderHudScores(d.scores);
      d.scores.forEach((p) => {
        const el = document.querySelector(`[data-score="${CSS.escape(p.name)}"]`);
        if (el) countUp(el, state.scores[p.name] || 0, p.score);
      });
      state.scores = Object.fromEntries(d.scores.map((p) => [p.name, p.score]));
    }, hasAnim ? 900 : 0);
  }

  $('#btn-next').addEventListener('click', () => { sfx.click(); socket.emit('next-round'); });

  /* ---------- game over ---------- */
  socket.on('game-over', (d) => {
    stopTimer();
    showScreen('screen-over');
    const wt = $('#winner-text');
    const sub = $('#winner-sub');
    if (d.winner) {
      const chars = splitLetters(wt, `${d.winner} wins! 💖`);
      anim(chars, { translateY: [30, 0], opacity: [0, 1], rotate: [8, 0], duration: 500, delay: staggerOf(35), ease: springOf({ stiffness: 240, damping: 13 }) });
      const [a, b] = d.scores;
      const loser = a.name === d.winner ? b : a;
      sub.textContent = `${d.winner} knows ${loser.name} best… for now 😉`;
    } else {
      const chars = splitLetters(wt, "It's a tie! 💞");
      anim(chars, { translateY: [30, 0], opacity: [0, 1], duration: 500, delay: staggerOf(35), ease: 'outExpo' });
      sub.textContent = 'Two hearts, perfectly in sync ✨';
    }
    anim('#trophy', { scale: [0, 1.15, 1], rotate: [-12, 8, 0], duration: 900, ease: springOf({ stiffness: 200, damping: 10 }) });
    const fs = $('#final-scores');
    fs.innerHTML = '';
    [...d.scores].sort((x, y) => y.score - x.score).forEach((p, i) => {
      const row = document.createElement('div');
      row.className = 'final-row' + (d.winner === p.name ? ' winner-row' : '');
      row.innerHTML = `<div class="avatar">${p.name[0].toUpperCase()}</div><div class="fname">${p.name}${d.winner === p.name ? ' 👑' : ''}</div><div class="fscore">${p.score}</div>`;
      fs.appendChild(row);
    });
    anim('.final-row', { translateX: [-40, 0], opacity: [0, 1], duration: 500, delay: staggerOf(120), ease: 'outExpo' });
    sfx.fanfare();
    confettiRain();
  });

  $('#btn-again').addEventListener('click', () => { sfx.click(); socket.emit('play-again'); });
  $('#btn-newroom').addEventListener('click', () => { sfx.click(); socket.emit('leave-room'); showScreen('screen-home'); });

  /* ---------- lobby + misc events ---------- */
  socket.on('lobby-update', renderLobby);
  socket.on('partner-left', () => toast('Your partner left the room 💔'));

  // logo + title entrance
  anim('#logo-hearts', { scale: [0, 1.2, 1], duration: 800, ease: springOf({ stiffness: 200, damping: 9 }) });
  anim('#game-title span', { translateY: [34, 0], opacity: [0, 1], duration: 600, delay: staggerOf(110), ease: 'outExpo' });
})();
