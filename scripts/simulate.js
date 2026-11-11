// Prompt test harness: plays a scripted seller against the real Live model
// (seller lines are sent as text, the agent answers in audio and we print its
// transcript and tool calls). Used to tune the prompt without talking each time.
//
//   node scripts/simulate.js            English seller
//   node scripts/simulate.js hinglish   Hinglish seller

import 'dotenv/config';
import { GoogleGenAI, Modality } from '@google/genai';
import { runTool, createCallState, functionDeclarations } from '../kam/tools.js';
import { buildSystemInstruction, greetingCue } from '../kam/prompt.js';

const scripts = {
  english: [
    "My sales have dropped significantly this month. I don't understand why. Can you help me?",
    'My supplier was late by three weeks because of the festival rush, and honestly I did not notice the stock was finishing.',
    'Yes, I also sell from my shop in Jaipur, the same stock.',
    'Hmm, I am not sure. Will this cost me anything?',
    'Yes, set all of it up.',
    'No, that is all. Please wrap up.',
  ],
  hinglish: [
    'Priya ji, is mahine meri sales bahut gir gayi hai. Samajh nahi aa raha kyun. Aap help kar sakte ho?',
    'Supplier ne maal late bheja, aur paisa bhi thoda tight hai abhi.',
    'Haan, dukaan se bhi wahi maal bechta hoon.',
    'Theek hai, toh ab kya karna chahiye?',
    'Haan kar do, lekin abhi sirf do product ka hi maal mangwa sakta hoon.',
    'Haan, kar do.',
    'Haan theek hai. Ab summary bata do.',
    'Nahi, bas itna hi. Dhanyavaad.',
  ],
};

const lines = scripts[process.argv[2]] || scripts.english;
const model = process.env.GEMINI_LIVE_MODEL || 'gemini-3.8-live';
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY });
const state = createCallState();

let said = '';
let onTurnDone = () => {};
let onActivity = () => {};
let session;

session = await ai.live.connect({
  model,
  config: {
    responseModalities: [Modality.AUDIO],
    systemInstruction: buildSystemInstruction('auto'),
    tools: [{ functionDeclarations }],
    outputAudioTranscription: {},
  },
  callbacks: {
    onopen: () => {},
    onmessage: (msg) => {
      const c = msg.serverContent;
      if (c?.modelTurn || msg.toolCall) onActivity();
      if (c?.outputTranscription?.text) {
        said += c.outputTranscription.text;
        state.noteAgentSaid(c.outputTranscription.text);
      }
      if (msg.toolCall?.functionCalls?.length) {
        const functionResponses = msg.toolCall.functionCalls.map((call) => {
          const out = runTool(state, call.name, call.args);
          console.log(`   [tool${out.kind === 'held' ? ' HELD' : ''}] ${call.name} ${JSON.stringify(call.args || {})}`);
          return { id: call.id, name: call.name, response: { result: out.result } };
        });
        session.sendToolResponse({ functionResponses });
      }
      if (c?.turnComplete) onTurnDone();
    },
    onerror: (e) => console.error('error:', e?.message),
    onclose: (e) => {
      if (e?.reason) console.log('closed:', e.reason);
      onTurnDone();
    },
  },
});

// A turn can span several model turns (speech, tool call, more speech), so we
// wait until the model has been quiet for a moment after a turnComplete.
async function turn(text, label) {
  if (label) console.log(`\nSELLER: ${text}`);
  said = '';
  await new Promise((resolve) => {
    let quiet;
    const hardStop = setTimeout(resolve, 60000);
    onActivity = () => clearTimeout(quiet);
    onTurnDone = () => {
      clearTimeout(quiet);
      quiet = setTimeout(() => {
        clearTimeout(hardStop);
        resolve();
      }, 2500);
    };
    if (label) state.noteSellerSpoke(text);
    session.sendRealtimeInput({ text });
  });
  console.log(`KAM:    ${said.trim()}`);
}

await turn(greetingCue, false);
for (const line of lines) await turn(line, true);

console.log('\n--- actions taken ---');
for (const a of state.actions) console.log(`${a.id} ${a.title}`);
console.log('\n--- summary ---');
console.log(JSON.stringify(state.summary, null, 2));
session.close();
process.exit(0);
