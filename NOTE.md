# Mini AI Voice KAM: technical note

**Demo:** https://snapdeal-virtual-kam-d0to.onrender.com · **Code:** https://github.com/shivam250812/SK

**What it is.** A browser voice agent, "Priya", that a Snapdeal seller talks to when sales drop. She pulls up the seller's numbers, asks what the data cannot answer, recommends three actions, logs a note and a follow-up call, and closes with a summary. She can be interrupted, and she follows the seller's language mid-call across 11 languages: Hindi, English, Bengali, Gujarati, Kannada, Malayalam, Marathi, Odia, Punjabi, Tamil and Telugu.

## Models and voice technology

| Layer | Choice |
|---|---|
| Voice platform | Sarvam conversational agents: one pipeline for speech-to-text, the language model and text-to-speech, built for mixed Hindi-English speech. Voice: "Simran". |
| App | Node.js server, plain HTML and JavaScript page, Sarvam browser SDK, Postgres (Neon), hosted on Render. |

## Tools the agent calls

The model holds no store numbers. Everything it knows or does goes through four API tools on my server.

| Tool | What it does |
|---|---|
| `get_seller_data` | Returns the five metrics with the differences already worked out (₹65,000 drop, 130 orders lost), so the model does no arithmetic. Also returns what was agreed on the previous call. |
| `log_seller_team_note` | Saves a one-sentence note for the seller team once the seller agrees to the plan. |
| `schedule_followup` | Books a call seven days out and returns the exact day to say. |
| `send_call_summary` | Runs when the call ends: key issues, recommendations and next steps are shown on the page and saved. |

## Workflow

1. The seller clicks "Call your KAM". My server gets a one-time connection address from Sarvam, so the API key never reaches the browser.
2. The browser streams audio both ways. The agent greets, fetches the data, states the drop, asks two or three questions one at a time, explains the cause, and gives three actions.
3. Each tool call appears on the page as it happens. The summary appears when the call ends.
4. The call is saved to Postgres. On the next call the agent asks whether the agreed steps were done.

## What makes it different

- **It remembers.** Every call is saved. On the next call Priya asks whether the steps agreed last time were done, as a real account manager would.
- **You can see it work.** The page shows each action live (data lookup, note, follow-up), then a written summary and the list of past calls.
- **It acts, not only talks.** The note and the follow-up are really recorded, and she says "noted" or names the day only after that tool has run.
- **Numbers come from code, not the prompt.** She may not calculate or invent a figure, and says she has store-level numbers only when asked about a category.
- **Advice a seller can use today.** Price is flat at ₹500, so pricing is ruled out; out-of-stock products rose from 5 to 18 and cancellations from 8% to 14%. The first action is always to correct the online stock count today, and each action carries a time or an amount.

## How I tested it

I rated each test call against the five criteria and fed the findings back in; my own rating rose from 64 to 89. Examples:

- The agent once quoted figures that were not from the tool. I removed every number from the instructions, then swapped all the sample data for different values to prove it quotes whatever the tool returns.
- It said a follow-up date different from the one booked. It now repeats the tool's date exactly.
- It assumed the seller had a shop. It now asks first and uses only what the seller has said.

## Assumptions and limits

One demo seller with no category split; nothing is sent to a Snapdeal system. Tested by one speaker in English and Hindi. A full call runs close to three minutes, and the agent sometimes speaks when the seller pauses mid-sentence. The free host sleeps when idle, so the first load can take a minute. **Next:** live seller data behind the same tool, and tools that update stock counts.
