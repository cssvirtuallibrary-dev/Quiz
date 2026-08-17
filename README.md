# Kahoot-style Quiz App (Google Sheets backed)

A real-time multiplayer quiz game (like Kahoot!) built with:
- **Node.js + Express + Socket.io** — real-time game engine (rooms, timers, scoring, leaderboard)
- **Google Sheets API** — question bank storage AND results logging (no database needed)
- **Vanilla HTML/CSS/JS** — Host screen (big screen / projector) and Player screen (phones)

---

## 1. Project structure

```
kahoot-clone/
├── package.json
├── server.js
├── credentials.json        <-- you provide this (Google service account key)
├── .env                    <-- you provide this (see below)
└── public/
    ├── index.html          <-- landing page (choose Host or Join)
    ├── host.html           <-- host/big-screen view
    ├── player.html         <-- player view (phones)
    └── style.css
```

---

## 2. Set up the Google Sheet

Create a Google Sheet with **two tabs**:

### Tab 1: `Questions`
Row 1 = headers, data starts at row 2.

| A (id) | B (question) | C (option1) | D (option2) | E (option3) | F (option4) | G (correctOption 1-4) | H (timeLimit sec) | I (points) |
|---|---|---|---|---|---|---|---|---|
| 1 | What is 2+2? | 3 | 4 | 5 | 6 | 2 | 15 | 1000 |
| 2 | Capital of France? | Berlin | Paris | Rome | Madrid | 2 | 15 | 1000 |

### Tab 2: `Results` (leave empty, headers optional)
| gamePin | playerName | score | timestamp |
|---|---|---|---|

Copy the Spreadsheet ID from the sheet URL:
`https://docs.google.com/spreadsheets/d/`**`THIS_PART_IS_THE_ID`**`/edit`

---

## 3. Create a Google Service Account (so the server can read/write the sheet)

1. Go to https://console.cloud.google.com/ → create/select a project.
2. Enable the **Google Sheets API** (APIs & Services → Enable APIs → search "Google Sheets API").
3. Go to **APIs & Services → Credentials → Create Credentials → Service Account**.
4. Give it a name, click through, then open the service account → **Keys → Add Key → Create new key → JSON**. This downloads a `.json` file.
5. Rename that file `credentials.json` and put it in the project root.
6. Open your Google Sheet, click **Share**, and share it with the service account's email address (found inside credentials.json, field `client_email`) with **Editor** access.

---

## 4. Configure environment

Create a `.env` file in the project root:

```
SPREADSHEET_ID=your_google_sheet_id_here
PORT=3000
```

---

## 5. Install & run

```bash
npm install
npm start
```

Then open:
- Host: `http://localhost:3000/host.html`
- Player: `http://localhost:3000/player.html`

Deploy to any Node host (Render, Railway, Fly.io, a VM, etc.) — just keep `credentials.json` and `.env` out of version control (secrets!).

---

## 6. How it works

1. Host opens `host.html` → clicks "Create Game" → server loads questions from the `Questions` sheet, generates a 6-digit PIN, creates an in-memory game room.
2. Players open `player.html` on their phones → enter the PIN + their name → join the room (they see it live on the host screen).
3. Host clicks "Start" → server pushes question 1 to everyone simultaneously, starts a countdown timer.
4. Players tap an answer button (colored/shaped like Kahoot). Server timestamps each answer to compute speed-based scoring:
   `score = correct ? round(points * (0.5 + 0.5 * remainingTime/timeLimit)) : 0`
5. When time is up (or all players answered), server reveals the correct answer + updated leaderboard to everyone.
6. Host clicks "Next" to continue through all questions.
7. At the end, final leaderboard is shown AND appended to the `Results` tab of the Google Sheet automatically.

---

## 7. Notes / things you may want to extend

- Add sheet columns for images/media per question.
- Add a lobby "kick player" button.
- Persist game state to survive server restarts (currently in-memory only — fine for a single-process demo/small event).
- Add authentication so random people can't create games.
- For very large audiences, put Socket.io behind a Redis adapter for horizontal scaling.
