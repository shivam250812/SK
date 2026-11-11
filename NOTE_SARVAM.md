# Mini AI Voice KAM: technical note

**What it is.** A browser voice agent ("Priya") that a Snapdeal seller can talk to when sales drop. She listens, pulls up the seller's numbers, asks what the data cannot answer, recommends two or three actions, logs a note and a follow-up, and closes with a summary. She follows the seller's language: English, Hindi, or another Indian language such as Marathi.

## Models and voice technology

| Layer | Choice | Why |
|---|---|---|
| Voice platform | Sarvam conversational agents (Samvaad) | One managed pipeline for listening, reasoning and speaking, built for Indian languages and code-mixed speech. |
| Speech-to-text, language model, text-to-speech | Sarvam's own models, as configured in the agent: **[fill in from the agent's Settings]** | Handles Hindi with English business words, and switches language mid-call. |
| Tools | Four API tools that call my server | Keeps the numbers and the actions in code, outside the model. |
| App | Node.js (Express), plain HTML and JavaScript, Sarvam browser SDK | Small enough to explain line by line. |

## Workflow

```
Browser --(1) start call--> Node server --adds API key--> Sarvam
Browser <==(2) live audio both ways + transcript==> Sarvam agent
                                                       |
Node server <--(3) tool calls: data, note, follow-up, summary
Browser <--(4) what the agent did, shown on the page-- Node server
```

1. The seller clicks "Call your KAM". The server gets a one-time connection address from Sarvam, so the API key never reaches the browser.
2. The browser streams audio both ways with the agent and shows the transcript.
3. The agent calls `get_seller_data` for the numbers, `log_seller_team_note` and `schedule_followup` for actions, and Sarvam sends `send_call_summary` when the call ends.
4. Each tool call appears on the page as it happens, the written summary appears at the end, and the whole call is saved to a log.

## Conversation design

Greet and listen; fetch the data; ask at most two questions, one of them open, to find what the data cannot show (why stock ran out); share the drop, then the cause; recommend actions fitted to the answers, most urgent first; recap once and say goodbye. Style rules keep it sounding like a call: short turns, one question at a time, no repeated questions, replies in the seller's language.

## What the data says

Average selling price is flat at ₹500, so pricing is not the cause. Orders fell from 400 to 270 (130 fewer, ₹65,000). Out-of-stock products rose from 5 to 18 and cancellations from 8% to 14%. The agent's reading: products ran out, orders kept arriving for items that were gone, and those orders were cancelled.

## Design decisions

- **Numbers come from code.** The tool returns the five metrics and their differences already worked out. The agent is told never to calculate or add claims the data does not show.
- **Stop the damage first.** The first recommendation is to correct the online stock count, which stops cancellations the same day.
- **Promises are backed.** The agent may only say "noted for the seller team" or name a follow-up day after the matching tool has run.
- **No overpromising.** Restocking can win back a good part of the lost orders, not all.

## How I tested and improved it

I rated each test call against the assignment's five criteria and measured recordings for response time, talk share and turn length. Each round of findings went back into the instructions.

| Version | Main change | Score (my own rating, /100) |
|---|---|---|
| First call | Baseline | 64 |
| + root-cause questions, all five metrics | Found shared stock and supplier delay | 73 |
| + immediate fix, numbers, single summary | Advice fitted to the seller | 77 |
| + open questions, data in two turns | Less interrogation, shorter call | 80 |

Measured on recordings: response time about 1.7 seconds; the agent's share of talk time fell from 66% to 61%.

## Assumptions

- The sample data is one seller, last month against this month, with no category or product split. The agent says so if asked.
- The note and follow-up are saved to a file on my server. Nothing is sent to a Snapdeal system.
- The seller's name and store are not in the sample data, so the agent does not use them.

## Limits and next steps

- Tested by one speaker in Hindi, Marathi and English. Not yet tested on noisy lines or with many speakers.
- Next: live seller data behind the same data tool, tools that update stock counts and set low-stock alerts, and a phone number so sellers can dial in.
