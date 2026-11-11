# Mini AI Virtual KAM: technical note

**What it is.** A browser voice agent ("Priya") that a Snapdeal seller can call when sales drop. It listens, pulls the seller's numbers, asks the questions the data cannot answer, explains the cause, and then does the follow-up work on the call instead of only giving advice.

## Models and voice technology

| Layer | Choice | Why |
|---|---|---|
| Voice and reasoning | Gemini Live API, model `gemini-3.8-live`, voice "Sulafat" | One speech-to-speech model handles listening, reasoning and speaking. Replies start in about a second, the seller can interrupt mid-sentence, and it speaks English and Hinglish. |
| Speech-to-text, text-to-speech | None as separate services | The Live model takes audio in and gives audio out. Its built-in transcription is used only to show the conversation on screen. |
| Tools | Gemini function calling, 9 functions run on my server | Keeps numbers and actions in code, outside the model. |
| App | Node.js (Express and WebSocket), plain HTML and JavaScript | Small enough to explain line by line. |

## Workflow

```
Browser mic --16 kHz PCM--> Node server --> Gemini Live session
Browser speaker <--24 kHz PCM-- Node server <-- speech + tool calls
                                   |
                                   +-- runs tools on mock seller data, pushes results to the page
```

1. The seller clicks "Call your KAM". The browser streams microphone audio to the server, which relays it to Gemini. The API key stays on the server.
2. The agent greets the seller and waits for the problem.
3. It calls three analysis tools: account snapshot, stock-out analysis, cancellation breakdown. All arithmetic is done in code, and the prompt forbids any number that is not in a tool result.
4. It asks two or three follow-up questions, one at a time: why the bestsellers ran out, whether the same stock is sold offline, whether anything else changed.
5. It gives the diagnosis and two or three recommendations fitted to the answers. For example, it plans a restock of two products instead of four if the seller says cash is tight.
6. With the seller's yes, it takes the actions (all mock): creates a restock plan with quantities, switches on an inventory safeguard, sets low-stock alerts, books a follow-up call, and sends a written summary. Each one appears on screen as it happens.
7. It closes with a spoken summary of issues, recommendations and next steps.

## What the data says

Average selling price is flat at ₹500, so this is a volume problem, not a pricing one. Out-of-stock products rose from 5 to 18 and cancellations from 8% to 14%. The agent's reading: demand is healthy, bestsellers ran out, and orders were accepted without stock and then cancelled.

## Design decisions

- **Ownership, with consent.** The agent proposes an action, waits for a yes, then acts. This is enforced in code as well as in the prompt: an action called before the seller has answered the agent's question is held and nothing changes.
- **Listen first.** No tool runs until the seller has spoken.
- **Language follows the seller.** English by default, Hinglish when the seller uses it, because many sellers are more comfortable in Hindi.
- **Human handover.** Payments, suspensions and disputes go to a human KAM through an escalation tool.

## Assumptions (mock data I added)

The brief gives five headline metrics. To let the agent go one level deeper I added the following, built to add up exactly to the given totals (checked by `npm run smoke`):

- Seller identity: Ramesh Gupta, Gupta Home Essentials, Home & Kitchen, Jaipur, 64 listings.
- Product split: 4 out-of-stock bestsellers lost 116 of the 130 lost orders (₹58,000 of the ₹65,000 drop). In-stock products went from 186 to 190 orders.
- Cancellation reasons: seller-side "no stock" cancellations rose from 6 to 21 orders, while customer cancellations and failed deliveries fell.
- "Orders" is read as gross orders, with the cancellation rate applied to it.
- The agent's actions (restock plan, safeguard, alerts, follow-up) are treated as free account settings.
- All actions are simulated. Nothing is sent to WhatsApp or any Snapdeal system.

## Limits and next steps

- Tested with scripted English and Hinglish conversations and with a synthetic voice through the browser. Not yet tested with many real speakers or noisy lines.
- Next: real telephony so sellers can dial in, live seller data in place of mock data, and proactive outbound calls when the agent sees a bestseller about to run out, before sales drop.
