# Mini AI Voice KAM: technical note

**Demo:** https://snapdeal-virtual-kam-d0to.onrender.com · **Code:** https://github.com/shivam250812/SK

**What it is.** A browser voice agent, "Priya", that a Snapdeal seller can talk to when sales drop. She listens, pulls up the seller's numbers, asks what the data cannot answer, recommends three actions, logs a note and a follow-up call, and closes with a summary. She follows the seller's language and can be interrupted.

## Models and voice technology

| Layer | Choice | Why |
|---|---|---|
| Voice platform | Sarvam conversational agents (Samvaad) | One managed pipeline for listening, reasoning and speaking, built for Indian languages and mixed Hindi-English speech. |
| Speech-to-text, language model, text-to-speech | Sarvam's own models inside that pipeline. Voice: "Simran" (Hinglish support agent). | Understands Hindi with English business words and switches language mid-call. |
| Agent settings | Starts in English, auto-switches across 11 Indian languages, callers can interrupt, lowest ("compliant") temperature | Keeps the agent consistent and tied to the data. |
| App | Node.js (Express), plain HTML and JavaScript, Sarvam browser SDK, Postgres (Neon), hosted on Render | Small enough to explain line by line. |

## The agent's tools

The model holds no store numbers. Everything it knows or does goes through four API tools on my server.

| Tool | When it runs | What it does |
|---|---|---|
| `get_seller_data` | Once, right after the seller describes the problem | Returns the five metrics for both months with the differences already worked out (₹65,000 drop, 130 orders lost, 13 more products out of stock), so the model does no arithmetic. Also returns what was agreed on the seller's previous call. |
| `log_seller_team_note` | When the seller agrees to the plan | Saves a one-sentence note for the seller team. |
| `schedule_followup` | When the seller agrees to the plan | Books a call seven days out and returns the exact day to say. |
| `send_call_summary` | Automatically when the call ends | Sends the key issues, recommendations, next steps and outcome. The server shows them on the page and saves the call. |

## Workflow

```
Browser --(1) start call--> Node server --adds API key--> Sarvam
Browser <==(2) live audio both ways + transcript==> Sarvam agent
                                                       |
Node server <--(3) tool calls: data, note, follow-up, summary
Browser <--(4) what the agent did, shown on the page-- Node server
```

1. The seller clicks "Call your KAM". The server gets a one-time connection address from Sarvam, so the API key never reaches the browser.
2. The browser streams audio both ways and shows the transcript.
3. The agent calls the tools above. Each call appears on the page as it happens, and the written summary appears when the call ends.
4. The call is saved to Postgres. The page lists past calls, and on the next call the agent asks whether the agreed steps were done.

## Conversation design

Greet and listen; fetch the data; say the size of the drop; ask two or three questions, one at a time, to find what the data cannot show (why stock ran out, whether the same stock is sold elsewhere); explain the cause; give three actions, most urgent first; log the note and follow-up; summarise and say goodbye.

**Reading of the data.** Price is flat at ₹500, so pricing is not the cause. Orders fell from 400 to 270. Out-of-stock products rose from 5 to 18 and cancellations from 8% to 14%: products ran out, orders kept arriving for them, and those orders were cancelled.

**Design decisions.**
- Numbers come from code, never from the prompt. The agent may not calculate or invent a figure.
- Stop the damage first: the first action is always to correct the online stock count today.
- Promises are backed: the agent says "noted" or names a follow-up day only after that tool has run.
- It is honest about limits: asked about a category, it says it has store-level numbers only.

## How I tested and improved it

I rated each test call against the five criteria and fed the findings back in. My own rating rose from 64 to 89.

| What testing found | Fix |
|---|---|
| The agent quoted figures that were not from the tool | Removed every number from the instructions. To prove it, I swapped all the sample data for different values and the agent quoted the new ones. |
| It said a follow-up date different from the one booked | It repeats the date exactly as the tool returns it. |
| It assumed the seller had a shop | It asks first and uses only what the seller has said. |
| Advice was generic | Each action carries a time or an amount ("today", "half the stock for online"). |
| Half-finished test calls were recalled as the previous call | Only calls that ended with a logged note or follow-up are remembered. |

## Assumptions and limits

- The sample data is one seller with no category or product split. All calls are stored under one demo seller, so anyone using the demo link sees the same history.
- The note, follow-up and history are saved on my own server and database. Nothing is sent to a Snapdeal system.
- Tested by one speaker in English and Hindi, on a quiet line.
- A full call runs close to three minutes, and the agent sometimes starts speaking when the seller pauses mid-sentence.
- The demo is on a free host that sleeps when idle, so the first load can take about a minute.

**Next:** live seller data behind the same data tool, tools that update stock counts and set low-stock alerts, and a phone number so sellers can dial in.
