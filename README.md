# 💗 How Well Do You Know Me?

A real-time 2-player quiz game for couples — one room, two phones, zero distance.
Built with **Node + Express + Socket.IO** (websockets) and **anime.js v4** for the cute 2D animations.

## How to play

1. Start the server:
   ```bash
   npm install
   npm start
   # → http://localhost:3000
   ```
2. Player 1: enter your name → **Create a room** → share the 4-letter code or the invite link (`?room=ABCD`).
3. Player 2: enter your name → **Join** with the code.
4. Host picks a question pack (💗 Sweet / 😂 Funny / 🌶️ Spicy / 🎲 Mix) and rounds, then hits **Start game**.

Each round one player is in the **hot seat** ⭐ — a question about them appears, both answer secretly
(the star answers honestly, the partner guesses), then a 3-2-1 countdown reveals both answers side by side.
Match = the guesser scores **+100**, the star **+50**. Answers are matched fuzzily, so typos,
capitalization and punctuation don't ruin a good guess.

## Project layout

| File | What it does |
|---|---|
| `server.js` | Rooms, game state machine, timers, fuzzy answer matching (Levenshtein) |
| `questions.js` | Question bank — 56 questions across sweet / funny / spicy packs (`{name}` = hot-seat player) |
| `public/index.html` | All screens: home, lobby, game, reveal, game over |
| `public/style.css` | Pastel cozy styling, mobile-first |
| `public/client.js` | Socket.IO client + all anime.js animation choreography (letter cascades, card flips, heart bursts, confetti, score count-ups) |
| `scripts/simulate.js` | Automated test: two fake players through a full 3-round game |

## Test it

```bash
npm test   # starts nothing itself — run the server on :3456 in another terminal first,
           # or: (PORT=3456 npm start &) && TEST_PORT=3456 node scripts/simulate.js
```

## Notes

- 2 players per room, 30s to answer, auto-advance if someone goes AFK.
- Sounds are tiny WebAudio synth blips — toggle with 🔊 bottom-right.
- If the anime.js CDN is unreachable, the game still works — animations gracefully no-op.
- To play over the internet (not just local network), deploy this folder to any Node host
  (Render, Railway, Fly.io…) — both players just open the public URL.
