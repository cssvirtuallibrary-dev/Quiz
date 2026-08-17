require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { google } = require('googleapis');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const QUESTIONS_SHEET = 'Questions';
const RESULTS_SHEET = 'Results';

app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Google Sheets helpers
// ---------------------------------------------------------------------------
let sheetsClientPromise = null;

function getSheetsClient() {
  if (!sheetsClientPromise) {
    sheetsClientPromise = (async () => {
      const auth = new google.auth.GoogleAuth({
        keyFile: path.join(__dirname, 'credentials.json'),
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
      const client = await auth.getClient();
      return google.sheets({ version: 'v4', auth: client });
    })();
  }
  return sheetsClientPromise;
}

async function loadQuestionsFromSheet() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${QUESTIONS_SHEET}!A2:I`,
  });
  const rows = res.data.values || [];
  return rows
    .filter((r) => r[1]) // must have a question text
    .map((r, idx) => ({
      id: r[0] || String(idx + 1),
      question: r[1],
      options: [r[2], r[3], r[4], r[5]],
      correctIndex: parseInt(r[6], 10) - 1, // sheet is 1-indexed
      timeLimit: parseInt(r[7], 10) || 20, // seconds
      points: parseInt(r[8], 10) || 1000,
    }));
}

async function appendResultsToSheet(gamePin, players) {
  if (!players.length) return;
  const sheets = await getSheetsClient();
  const values = players.map((p) => [
    gamePin,
    p.name,
    p.score,
    new Date().toISOString(),
  ]);
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${RESULTS_SHEET}!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });
}

// ---------------------------------------------------------------------------
// In-memory game state
// ---------------------------------------------------------------------------
// games[pin] = {
//   pin, hostSocketId, questions, currentIndex, state,
//   players: { socketId: { name, score, currentAnswer, answerTime } },
//   questionStartedAt, questionTimer
// }
const games = {};

function generatePin() {
  let pin;
  do {
    pin = String(Math.floor(100000 + Math.random() * 900000));
  } while (games[pin]);
  return pin;
}

function publicPlayerList(game) {
  return Object.entries(game.players).map(([id, p]) => ({
    id,
    name: p.name,
    score: p.score,
  }));
}

function leaderboard(game) {
  return publicPlayerList(game).sort((a, b) => b.score - a.score);
}

function clearQuestionTimer(game) {
  if (game.questionTimer) {
    clearTimeout(game.questionTimer);
    game.questionTimer = null;
  }
}

function sendQuestion(game) {
  clearQuestionTimer(game);
  const q = game.questions[game.currentIndex];
  if (!q) return endGame(game);

  // reset answers for this round
  Object.values(game.players).forEach((p) => {
    p.currentAnswer = null;
    p.answerTime = null;
  });

  game.state = 'question';
  game.questionStartedAt = Date.now();

  const payload = {
    index: game.currentIndex,
    total: game.questions.length,
    question: q.question,
    options: q.options,
    timeLimit: q.timeLimit,
  };

  io.to(game.pin).emit('question:show', payload);

  game.questionTimer = setTimeout(() => revealAnswer(game), q.timeLimit * 1000);
}

function revealAnswer(game) {
  clearQuestionTimer(game);
  if (game.state === 'reveal') return;
  game.state = 'reveal';

  const q = game.questions[game.currentIndex];

  // score anyone who hasn't been scored yet defensively (already scored on answer)
  const board = leaderboard(game);

  io.to(game.pin).emit('question:reveal', {
    correctIndex: q.correctIndex,
    correctText: q.options[q.correctIndex],
    leaderboard: board,
    isLastQuestion: game.currentIndex === game.questions.length - 1,
  });
}

async function endGame(game) {
  game.state = 'ended';
  const board = leaderboard(game);
  io.to(game.pin).emit('game:over', { leaderboard: board });
  try {
    await appendResultsToSheet(game.pin, board);
  } catch (err) {
    console.error('Failed to save results to sheet:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Socket.io game logic
// ---------------------------------------------------------------------------
io.on('connection', (socket) => {
  // ----- HOST -----
  socket.on('host:create', async () => {
    try {
      const questions = await loadQuestionsFromSheet();
      if (!questions.length) {
        socket.emit('error:message', 'No questions found in the Google Sheet.');
        return;
      }
      const pin = generatePin();
      const game = {
        pin,
        hostSocketId: socket.id,
        questions,
        currentIndex: -1,
        state: 'lobby',
        players: {},
        questionTimer: null,
      };
      games[pin] = game;
      socket.join(pin);
      socket.data.pin = pin;
      socket.data.isHost = true;
      socket.emit('host:created', { pin, questionCount: questions.length });
    } catch (err) {
      console.error(err);
      socket.emit('error:message', 'Could not load questions from Google Sheets. Check credentials/spreadsheet ID.');
    }
  });

  socket.on('host:start', () => {
    const pin = socket.data.pin;
    const game = games[pin];
    if (!game || game.hostSocketId !== socket.id) return;
    game.currentIndex = 0;
    sendQuestion(game);
  });

  socket.on('host:next', () => {
    const pin = socket.data.pin;
    const game = games[pin];
    if (!game || game.hostSocketId !== socket.id) return;
    game.currentIndex += 1;
    if (game.currentIndex >= game.questions.length) {
      endGame(game);
    } else {
      sendQuestion(game);
    }
  });

  socket.on('host:skipToReveal', () => {
    const pin = socket.data.pin;
    const game = games[pin];
    if (!game || game.hostSocketId !== socket.id) return;
    revealAnswer(game);
  });

  // ----- PLAYER -----
  socket.on('player:join', ({ pin, name }) => {
    const game = games[pin];
    if (!game) {
      socket.emit('error:message', 'Game PIN not found.');
      return;
    }
    if (game.state !== 'lobby') {
      socket.emit('error:message', 'Game already started.');
      return;
    }
    const cleanName = (name || 'Player').toString().trim().slice(0, 20) || 'Player';
    game.players[socket.id] = { name: cleanName, score: 0, currentAnswer: null, answerTime: null };
    socket.join(pin);
    socket.data.pin = pin;
    socket.data.isHost = false;

    socket.emit('player:joined', { pin, name: cleanName });
    io.to(game.hostSocketId).emit('host:playerJoined', { players: publicPlayerList(game) });
  });

  socket.on('player:answer', ({ answerIndex }) => {
    const pin = socket.data.pin;
    const game = games[pin];
    if (!game || game.state !== 'question') return;
    const player = game.players[socket.id];
    if (!player || player.currentAnswer !== null) return; // already answered

    const q = game.questions[game.currentIndex];
    const elapsed = (Date.now() - game.questionStartedAt) / 1000;
    player.currentAnswer = answerIndex;
    player.answerTime = elapsed;

    const correct = answerIndex === q.correctIndex;
    if (correct) {
      const remaining = Math.max(0, q.timeLimit - elapsed);
      const scoreGain = Math.round(q.points * (0.5 + 0.5 * (remaining / q.timeLimit)));
      player.score += scoreGain;
      socket.emit('player:answerResult', { correct: true, scoreGain, totalScore: player.score });
    } else {
      socket.emit('player:answerResult', { correct: false, scoreGain: 0, totalScore: player.score });
    }

    io.to(game.hostSocketId).emit('host:answerCount', {
      answered: Object.values(game.players).filter((p) => p.currentAnswer !== null).length,
      total: Object.keys(game.players).length,
    });

    // if everyone answered, reveal early
    const allAnswered = Object.values(game.players).every((p) => p.currentAnswer !== null);
    if (allAnswered) revealAnswer(game);
  });

  // ----- DISCONNECT -----
  socket.on('disconnect', () => {
    const pin = socket.data.pin;
    const game = games[pin];
    if (!game) return;

    if (socket.data.isHost) {
      io.to(pin).emit('error:message', 'Host disconnected. Game ended.');
      delete games[pin];
    } else if (game.players[socket.id]) {
      delete game.players[socket.id];
      io.to(game.hostSocketId).emit('host:playerJoined', { players: publicPlayerList(game) });
    }
  });
});

server.listen(PORT, () => {
  console.log(`Kahoot-clone server running on http://localhost:${PORT}`);
});
