# Mini AI Voice KAM for Snapdeal sellers

A browser voice agent ("Priya") that a Snapdeal seller can talk to when sales drop. She pulls up the seller's numbers, asks follow-up questions, recommends two or three actions, logs a note and a follow-up call, and closes with a summary. She follows the seller's language: English, Hindi, or another Indian language.

The agent is built on [Sarvam](https://www.sarvam.ai) conversational agents. This repository holds the browser page, the server that keeps the API key private, and the tools the agent calls.

See [NOTE.md](NOTE.md) for the models, workflow, design decisions, testing and assumptions.

## Run it

Needs Node.js 20 or later and a Sarvam agent API key. Create the key in the Sarvam dashboard under Settings, API Key (`indus.sarvam.ai/samvaad/settings/api-key`). This is not the `sk_` key used for Sarvam's model APIs.

```bash
npm install
cp .env.example .env      # then put your key in SARVAM_AGENT_API_KEY
npm start
```

Open http://localhost:3000 in Chrome, click **Call your KAM**, allow the microphone, and talk. Headphones give the best result.

Things to try:

- "My sales have dropped significantly this month. I don't understand why. Can you help me?"
- Switch to Hindi partway through. She follows.
- Tell her why stock ran out, for example "my supplier is late and the same stock sells in my shop".
- Interrupt her mid-sentence.
- Mention something the data does not cover, such as a category.

## How it works

```
Browser --(1) start call--> Node server --adds API key--> Sarvam
Browser <==(2) live audio both ways + transcript==> Sarvam agent
                                                       |
Node server <--(3) tool calls: data, note, follow-up, summary
Browser <--(4) what the agent did, shown on the page-- Node server
```

1. The page asks the server to start a call. The server gets a one-time connection address from Sarvam using the API key, so the key never reaches the browser.
2. The browser connects to the agent and streams audio both ways. The transcript appears as the call runs.
3. The agent calls tools on this server for the seller's numbers and for its actions.
4. The page shows each tool call as it happens and a written summary when the call ends.
5. The summary and the actions taken are saved to a database. The page lists past calls, and on the next call the agent is told what was agreed last time, so it can ask whether those steps were done.

## Files

```
public/
  index.html       the page: call button, transcript, sample data, activity and summary panels
  app.js           starts and stops the call, shows the transcript and what the agent did
  vendor/          Sarvam's browser SDK, bundled with `npm run build:sdk`
  styles.css
server.js          starts calls with the key kept private, runs the agent's tools, saves call logs
store.js           call history: Postgres when DATABASE_URL is set, a local file otherwise
data.js            the sample seller data from the assignment
SARVAM_SETUP.md    how to connect the tools in Sarvam, and the instructions the agent needs
NOTE.md            the one-page technical note
```

## The agent's tools

Sarvam calls these over the internet, so they work only once the server is deployed. [SARVAM_SETUP.md](SARVAM_SETUP.md) has the exact fields for each.

| Tool | Address | What it does |
|---|---|---|
| `get_seller_data` | `GET /api/tools/seller-data` | Returns the five metrics for last month and this month, with the differences already worked out, so the model does no arithmetic. Also returns what was agreed on the seller's previous call, if there was one. |
| `log_seller_team_note` | `POST /api/tools/note` | Saves a note for the seller team. |
| `schedule_followup` | `POST /api/tools/followup` | Books a follow-up and returns the day and date to say. |
| `send_call_summary` | `POST /api/tools/call-summary` | Sent by Sarvam when the call ends. Shows the written summary on the page and saves the call to the history. |

The note, follow-up and summary are saved to files on this server. Nothing is sent to a Snapdeal system.

## Settings

Set in `.env`:

| Variable | Purpose |
|---|---|
| `SARVAM_AGENT_API_KEY` | Required. The agent key from the Sarvam dashboard. |
| `SARVAM_ORG_ID`, `SARVAM_WORKSPACE_ID`, `SARVAM_APP_ID` | Optional. Point the page at a different agent. The defaults in `server.js` are the "Snapdeal Virtual KAM" agent. |
| `DATABASE_URL` | Optional. Postgres connection string for call history (for example a free Neon database). Without it, history is kept in `logs/calls.json` and is lost when a hosted server restarts. |
| `SARVAM_TOOL_TOKEN` | Optional. If set, tool calls must send `Authorization: Bearer <value>`. |
| `PORT` | Optional. Default 3000. |

The agent must have a committed version in Sarvam. A draft cannot be called.

## Deploy

`render.yaml` is included for Render: create a Blueprint from this repository and set `SARVAM_AGENT_API_KEY` and `DATABASE_URL`. Then follow [SARVAM_SETUP.md](SARVAM_SETUP.md), using the deployed address in each tool. The microphone works on `localhost` and on any HTTPS address.
