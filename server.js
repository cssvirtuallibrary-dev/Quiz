require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { google } = require('googleapis');
const QRCode = require('qrcode');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const DEFAULT_QUESTIONS_TAB = 'Questions';
const RESULTS_SHEET = 'Results';
const RESULTS_DETAIL_SHEET = 'ResultsDetail';

app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (req, res) => res.status(200).send('ok'));

// ---------------------------------------------------------------------------
// Google Sheets helpers
// ---------------------------------------------------------------------------
let sheetsClientPromise = null;

function getSheetsClient() {
  if (!sheetsClientPromise) {
    sheetsClientPromise = (async () => {
      let authOptions = { scopes: ['https://www.googleapis.com/auth/spreadsheets'] };

      if (process.env.GOOGLE_CREDENTIALS_JSON) {
        let creds;
        try {
          creds = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
        } catch (err) {
          throw new Error('GOOGLE_CREDENTIALS_JSON env var is not valid JSON. Re-check it was pasted as a single line.');
        }
        authOptions.credentials = creds;
      } else if (SPREADSHEET_ID) {
        authOptions.keyFile = path.join(__dirname, 'credentials.json');
      } else {
        throw new Error('No Google credentials configured. Set GOOGLE_CREDENTIALS_JSON (Render) or provide credentials.json (local).');
      }

      const auth = new google.auth.GoogleAuth(authOptions);
      const client = await auth.getClient();
      return google.sheets({ version: 'v4', auth: client });
    })();
  }
  return sheetsClientPromise;
}

// Sheet columns (row 1 = header, data starts row 2), matching exactly:
// A: id | B: Question_VN | C: Question_EN |
// D: OptionA_VN | E: OptionA_EN | F: OptionB_VN | G: OptionB_EN |
// H: OptionC_VN | I: OptionC_EN | J: OptionD_VN | K: OptionD_EN |
// L: CorrectIndex (1=A,2=B,3=C,4=D) | M: timelimit (sec) | N: points
async function loadQuestionsFromSheet(sheetTab) {
  if (!SPREADSHEET_ID) throw new Error('SPREADSHEET_ID environment variable is not set.');
  const tab = (sheetTab || DEFAULT_QUESTIONS_TAB).trim();
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${tab}!A2:N`,
  });
  const rows = res.data.values || [];
  return rows
    .filter((r) => r[1] || r[2])
    .map((r, idx) => ({
      id: r[0] || String(idx + 1),
      question_vn: r[1] || '',
      question_en: r[2] || '',
      options_vn: [r[3], r[5], r[7], r[9]],
      options_en: [r[4], r[6], r[8], r[10]],
      correctIndex: parseInt(r[11], 10) - 1,
      timeLimit: parseInt(r[12], 10) || 20,
      points: parseInt(r[13], 10) || 1000,
    }));
}

async function appendSummaryResults(sessionName, pin, players) {
  if (!players.length) return;
  const sheets = await getSheetsClient();
  const ts = new Date().toISOString();
  const values = players.map((p) => [sessionName, pin, p.name, p.score, ts]);
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${RESULTS_SHEET}!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });
}

async function appendDetailResults(sessionName, pin, answerHistory) {
  const sheets = await getSheetsClient();
  const ts = new Date().toISOString();
  const values = [];
  answerHistory.forEach((h) => {
    h.perPlayerAnswers.forEach((pa) => {
      values.push([
        sessionName,
        pin,
        pa.name,
        h.index + 1,
        h.question_en,
        pa.answerIndex === null || pa.answerIndex === undefined ? '(no answer)' : (h.options_en[pa.answerIndex] || ''),
        h.correctText_en,
        pa.correct ? 'Yes' : 'No',
        pa.timeTaken === null ? '' : pa.timeTaken.toFixed(1),
        pa.scoreGain,
        ts,
      ]);
    });
  });
  if (!values.length) return;
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${RESULTS_DETAIL_SHEET}!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });
}

// ---------------------------------------------------------------------------
// In-memory game state
// ---------------------------------------------------------------------------
const games = {};

function generatePin() {
  let pin;
  do {
    pin = String(Math.floor(100000 + Math.random() * 900000));
  } while (games[pin]);
  return pin;
}

function publicPlayerList(game) {
  return Object.entries(game.players).map(([id, p]) => ({ id, name: p.name, score: p.score }));
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
  if (!q) return finalizeGame(game);

  Object.values(game.players).forEach((p) => {
    p.currentAnswer = null;
    p.answerTime = null;
  });

  game.state = 'question';
  game.questionStartedAt = Date.now();

  io.to(game.pin).emit('question:show', {
    index: game.currentIndex,
    total: game.questions.length,
    question_vn: q.question_vn,
    question_en: q.question_en,
    options_vn: q.options_vn,
    options_en: q.options_en,
    timeLimit: q.timeLimit,
  });

  game.questionTimer = setTimeout(() => closeQuestion(game), q.timeLimit * 1000);
}

// Closes the current question WITHOUT revealing right/wrong to players.
// Scores are computed and stored internally; discussion happens later.
function closeQuestion(game) {
  clearQuestionTimer(game);
  if (game.state === 'closed') return;
  game.state = 'closed';

  const q = game.questions[game.currentIndex];
  const tally = [0, 0, 0, 0];
  const perPlayerAnswers = [];

  Object.entries(game.players).forEach(([id, p]) => {
    const answerIndex = p.currentAnswer;
    const correct = answerIndex !== null && answerIndex === q.correctIndex;
    let scoreGain = 0;
    if (correct) {
      const remaining = Math.max(0, q.timeLimit - (p.answerTime || q.timeLimit));
      scoreGain = Math.round(q.points * (0.5 + 0.5 * (remaining / q.timeLimit)));
      p.score += scoreGain;
    }
    if (answerIndex !== null && answerIndex !== undefined) tally[answerIndex] += 1;
    perPlayerAnswers.push({
      socketId: id,
      name: p.name,
      answerIndex: answerIndex,
      correct,
      scoreGain,
      timeTaken: p.answerTime,
    });
  });

  game.answerHistory.push({
    index: game.currentIndex,
    question_vn: q.question_vn,
    question_en: q.question_en,
    options_vn: q.options_vn,
    options_en: q.options_en,
    correctIndex: q.correctIndex,
    correctText_en: q.options_en[q.correctIndex],
    correctText_vn: q.options_vn[q.correctIndex],
    tally,
    perPlayerAnswers,
  });

  const isLastQuestion = game.currentIndex === game.questions.length - 1;
  io.to(game.pin).emit('question:closed', { isLastQuestion });
}

async function finalizeGame(game) {
  game.state = 'ended';
  const board = leaderboard(game);
  io.to(game.pin).emit('game:over', { leaderboard: board });
  try {
    await appendSummaryResults(game.sessionName, game.pin, board);
    await appendDetailResults(game.sessionName, game.pin, game.answerHistory);
  } catch (err) {
    console.error('Failed to save results to sheet:', err.message);
    io.to(game.hostSocketId).emit('error:message', `Saved game but failed to write results to Sheet: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Socket.io game logic
// ---------------------------------------------------------------------------
io.on('connection', (socket) => {
  socket.on('host:create', async ({ sheetTab, sessionName, origin } = {}) => {
    try {
      const questions = await loadQuestionsFromSheet(sheetTab);
      if (!questions.length) {
        socket.emit('error:message', `No questions found in the "${sheetTab || DEFAULT_QUESTIONS_TAB}" tab.`);
        return;
      }
      const pin = generatePin();
      const game = {
        pin,
        hostSocketId: socket.id,
        sessionName: (sessionName || 'Untitled Session').toString().slice(0, 60),
        sheetTab: sheetTab || DEFAULT_QUESTIONS_TAB,
        questions,
        currentIndex: -1,
        state: 'lobby',
        players: {},
        questionTimer: null,
        answerHistory: [],
        reviewIndex: -1,
      };
      games[pin] = game;
      socket.join(pin);
      socket.data.pin = pin;
      socket.data.isHost = true;

      const joinUrl = `${origin || ''}/player.html?pin=${pin}`;
      let qrDataUrl = null;
      try {
        qrDataUrl = await QRCode.toDataURL(joinUrl, { width: 400, margin: 1 });
      } catch (qrErr) {
        console.error('QR generation failed:', qrErr.message);
      }

      socket.emit('host:created', {
        pin,
        questionCount: questions.length,
        sessionName: game.sessionName,
        sheetTab: game.sheetTab,
        joinUrl,
        qrDataUrl,
      });
    } catch (err) {
      console.error(err);
      socket.emit('error:message', `Could not load questions from Google Sheets: ${err.message}`);
    }
  });

  socket.on('host:start', () => {
    const game = games[socket.data.pin];
    if (!game || game.hostSocketId !== socket.id) return;
    game.currentIndex = 0;
    sendQuestion(game);
  });

  socket.on('host:closeQuestion', () => {
    const game = games[socket.data.pin];
    if (!game || game.hostSocketId !== socket.id) return;
    closeQuestion(game);
  });

  socket.on('host:next', () => {
    const game = games[socket.data.pin];
    if (!game || game.hostSocketId !== socket.id) return;
    game.currentIndex += 1;
    if (game.currentIndex >= game.questions.length) {
      finalizeGame(game);
    } else {
      sendQuestion(game);
    }
  });

  // ---- Post-quiz discussion / review mode ----
  socket.on('host:reviewStart', () => {
    const game = games[socket.data.pin];
    if (!game || game.hostSocketId !== socket.id) return;
    game.reviewIndex = 0;
    emitReviewSlide(game);
  });

  socket.on('host:reviewNext', () => {
    const game = games[socket.data.pin];
    if (!game || game.hostSocketId !== socket.id) return;
    if (game.reviewIndex < game.answerHistory.length - 1) game.reviewIndex += 1;
    emitReviewSlide(game);
  });

  socket.on('host:reviewPrev', () => {
    const game = games[socket.data.pin];
    if (!game || game.hostSocketId !== socket.id) return;
    if (game.reviewIndex > 0) game.reviewIndex -= 1;
    emitReviewSlide(game);
  });

  function emitReviewSlide(game) {
    const h = game.answerHistory[game.reviewIndex];
    if (!h) return;
    io.to(game.pin).emit('review:show', {
      index: game.reviewIndex,
      total: game.answerHistory.length,
      question_vn: h.question_vn,
      question_en: h.question_en,
      options_vn: h.options_vn,
      options_en: h.options_en,
      correctIndex: h.correctIndex,
      tally: h.tally,
    });
  }

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
    const game = games[socket.data.pin];
    if (!game || game.state !== 'question') return;
    const player = game.players[socket.id];
    if (!player || player.currentAnswer !== null) return;

    const elapsed = (Date.now() - game.questionStartedAt) / 1000;
    player.currentAnswer = answerIndex;
    player.answerTime = elapsed;

    // No correct/wrong feedback here on purpose -- discussion happens after the quiz.
    socket.emit('player:answerLocked', { answerIndex });

    io.to(game.hostSocketId).emit('host:answerCount', {
      answered: Object.values(game.players).filter((p) => p.currentAnswer !== null).length,
      total: Object.keys(game.players).length,
    });

    const allAnswered = Object.values(game.players).every((p) => p.currentAnswer !== null);
    if (allAnswered) closeQuestion(game);
  });

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

server.listen(PORT, HOST, () => {
  console.log(`Kahoot-clone server running on http://${HOST}:${PORT}`);
});
