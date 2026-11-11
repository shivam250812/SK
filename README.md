# Mini AI Virtual KAM for Snapdeal sellers

A browser voice agent that a seller can call when sales drop. It diagnoses the problem from the seller's data, asks follow-up questions, recommends actions, and carries them out on the call.

See [NOTE.md](NOTE.md) for the models, workflow, design decisions and assumptions.

## Run it

Needs Node.js 20 or later and a Gemini API key from https://aistudio.google.com/apikey.

```bash
npm install
cp .env.example .env      # then put your key in GEMINI_API_KEY
npm run smoke             # optional: checks the data, the tools and the live model
npm start
```

Open http://localhost:3000 in Chrome, click **Call your KAM**, allow the microphone, and talk. Headphones give the best result.

Things to try:

- "My sales have dropped significantly this month. I don't understand why. Can you help me?"
- Answer its questions in your own words, for example "my supplier was late and I also sell the same stock from my shop".
- Interrupt it mid-sentence.
- Switch to Hindi partway through, or pick Hinglish in the language menu before calling.
- Say cash is tight and see the restock plan shrink.
- Ask about a payment problem and it hands over to a human KAM.

## Sarvam agent page

The same server also serves a second page, http://localhost:3000/sarvam.html, which calls the "Snapdeal Virtual KAM" agent built in Sarvam's dashboard.

- Add `SARVAM_AGENT_API_KEY` to `.env` and restart. This is the key from the Samvaad dashboard (Settings, API Key), not the `sk_` key for Sarvam's model APIs. The key stays on the server: `server.js` uses it to fetch a one-time connection address for the browser.
- The agent must have a committed version in Sarvam. A draft cannot be called.
- The agent's IDs are set in `server.js` and can be overridden with `SARVAM_ORG_ID`, `SARVAM_WORKSPACE_ID` and `SARVAM_APP_ID`.
- `public/vendor/sarvam-sdk.js` is Sarvam's browser SDK, bundled with `npm run build:sarvam`.
- Once the Sarvam key is set, `/` opens this page. The Gemini version stays at `/index.html`.
- The agent's tools are endpoints on this server under `/api/tools/`. [SARVAM_SETUP.md](SARVAM_SETUP.md) lists them and how to connect them in Sarvam. What they do appears on the page during the call and is saved in `logs/`.

## How it is built

```
public/            the page: mic capture, audio playback, transcript, activity panel
  app.js
  pcm-worklet.js   converts mic audio to 16-bit PCM on the audio thread
server.js          relays audio between the browser and Gemini Live, runs the tools
kam/
  prompt.js        the agent's instructions (persona, call flow, rules)
  tools.js         9 tools: 3 analysis, 6 actions, plus the two guards
  data.js          mock seller data, given figures and labelled assumptions
scripts/
  smoke.js         checks data consistency, tools, guards and the live connection
  simulate.js      plays a scripted seller against the real model to test the prompt
```

Two guards live in `kam/tools.js`, in code and not only in the prompt:

- **Listen first:** no tool runs before the seller has spoken.
- **Consent:** an action is held if the agent has asked a question and the seller has not yet answered.

## Settings

Set in `.env`:

| Variable | Purpose |
|---|---|
| `GEMINI_API_KEY` | Required. |
| `GEMINI_LIVE_MODEL` | Optional. Pins one Live model. By default the server tries `gemini-3.8-live`, then `gemini-3.1-flash-live-preview`, then `gemini-2.5-flash-live-preview`. |
| `GEMINI_VOICE` | Optional. Default voice, `Sulafat`. The page also has a voice menu. |
| `PORT` | Optional. Default 3000. |

## Deploy

The server needs WebSockets, so use a host that keeps a Node process running. `render.yaml` is included for Render: create a web service from this repository and set `GEMINI_API_KEY` in its environment. The microphone works on `localhost` and on any HTTPS address.

## Testing the prompt without speaking

```bash
node scripts/simulate.js            # English seller
node scripts/simulate.js hinglish   # Hinglish seller
```

This prints the agent's side of the call, every tool call, any held action, and the final summary.

Every real call is also saved as a text transcript in `logs/`.
