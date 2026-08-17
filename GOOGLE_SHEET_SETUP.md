# Google Sheet Setup for the Updated QuizClash

Your spreadsheet needs 3 tabs total. Same spreadsheet, same `SPREADSHEET_ID`,
same credentials — nothing in Render's environment variables changes.

## 1. Questions tab (bilingual) — you can have MULTIPLE of these

You can rename this tab anything you like per quiz (e.g. `Questions`,
`Questions_TeamBuilding`, `Questions_Safety_JP`). On the host screen there is
now a "Question Sheet Tab" field — type the exact tab name there when you
create a game. This is how you run multiple different quizzes/sessions from
the SAME spreadsheet without ever touching your `.env` file again.

**Row 1 = headers (for your own reference), data starts on Row 2.**

| Col | Field | Example |
|---|---|---|
| A | ID | 1 |
| B | Question_EN | What is the capital of France? |
| C | Question_L2 | 法国的首都是哪里？ |
| D | OptionA_EN | Paris |
| E | OptionA_L2 | 巴黎 |
| F | OptionB_EN | Berlin |
| G | OptionB_L2 | 柏林 |
| H | OptionC_EN | Rome |
| I | OptionC_L2 | 罗马 |
| J | OptionD_EN | Madrid |
| K | OptionD_L2 | 马德里 |
| L | CorrectIndex | 1 (1=A, 2=B, 3=C, 4=D) |
| M | TimeLimit | 20 |
| N | Points | 1000 |

Leave Question_L2 / Option_L2 columns blank if a particular question doesn't
need a second language — the app will just show the English side only.

## 2. Results tab (summary — one row per player per game)

Name this tab exactly: `Results`

| Col | Field |
|---|---|
| A | Session Name |
| B | Game PIN |
| C | Player Name |
| D | Total Score |
| E | Timestamp |

## 3. ResultsDetail tab (one row per player per question)

Name this tab exactly: `ResultsDetail`

| Col | Field |
|---|---|
| A | Session Name |
| B | Game PIN |
| C | Player Name |
| D | Question Number |
| E | Question Text (EN) |
| F | Chosen Answer (EN) |
| G | Correct Answer (EN) |
| H | Correct? (Yes/No) |
| I | Time Taken (sec) |
| J | Points Earned |
| K | Timestamp |

Add header rows matching the columns above (optional but recommended) so the
sheet is easy to read — the app always appends new rows below whatever is
already there.

## Sharing reminder

Make sure the service account email (the `client_email` inside your
credentials JSON) still has **Editor** access to this spreadsheet — same as
before, this doesn't change with the new features.
