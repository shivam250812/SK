# Connecting the agent's tools in Sarvam

The agent has four tools. Each one is an address on this project's server. Sarvam calls them over the internet, so the server must be deployed first. Replace `YOUR-APP` below with your deployed address, for example `snapdeal-virtual-kam.onrender.com`.

Before adding these, remove the three payment tools left over from the EMI template.

## The four tools

In the agent, open **Tools**, add an **API tool** for each row, and press **Test** on each before saving.

### 1. `get_seller_data`

| Field | Value |
|---|---|
| Description | Gets this seller's store numbers for last month and this month: sales, orders, cancellation rate, average selling price and out-of-stock products, with the differences already worked out. Call it once, right after the seller describes their problem. |
| When should this tool run? | During conversation |
| Method and URL | `GET https://YOUR-APP/api/tools/seller-data` |
| Params | `session` = insert **User Identifier** with `@` |
| Response template | Use these figures exactly as given. Do not calculate any new numbers. |
| If it fails | "I can't pull up your account right now, but tell me what you are seeing and I'll help." |

### 2. `log_seller_team_note`

| Field | Value |
|---|---|
| Description | Saves a short note about this seller for Snapdeal's seller team, for example the cause of the problem or a request for a stock sync tool. Call it when you tell the seller you will pass something to the seller team. |
| When should this tool run? | During conversation |
| Method and URL | `POST https://YOUR-APP/api/tools/note` |
| Body | `{"note": "<the note, written by the agent>", "session": "<User Identifier>"}` |
| Response template | The note is logged. Tell the seller it has been passed on. |

### 3. `schedule_followup`

| Field | Value |
|---|---|
| Description | Books a follow-up call with the seller. Call it once the seller has agreed to the plan, before you close. |
| When should this tool run? | During conversation |
| Method and URL | `POST https://YOUR-APP/api/tools/followup` |
| Body | `{"in_days": 7, "topic": "<what you will check>", "session": "<User Identifier>"}` |
| Response template | The follow-up is booked for {{say_it_as}}. Tell the seller that day. |

### 4. `send_call_summary`

| Field | Value |
|---|---|
| When should this tool run? | On end (runs by itself when the call ends; the agent does not call it) |
| Method and URL | `POST https://YOUR-APP/api/tools/call-summary` |
| Body | `{"call_summary": "<call_summary>", "key_issues": "<key_issues>", "recommendations": "<recommendations>", "next_steps": "<next_steps>", "call_outcome": "<call_outcome>", "seller_name": "<seller_name>", "store_name": "<store_name>", "session": "<User Identifier>"}` |

In the Body fields, each `<...>` is a value to insert with `@` in Sarvam's editor: the agent variable of the same name, or **User Identifier** for `session`. In tools 2 and 3, `note` and `topic` are filled in by the agent during the call.

## Instructions to add to the agent

Replace the section of the instructions that lists the store numbers (the "Facts" section) with this, so the numbers come from the tool:

```
Store data and tools
- Right after the seller describes their problem, say a few words such as "one second, let me pull up your account", then call tool:get_seller_data. Call it once per call.
- Every number you say must come from that tool's reply. Use its figures as given, including the differences. Never calculate, estimate or invent a number.
- If the tool fails, say you cannot see the account right now and continue with what the seller tells you. Do not quote any numbers.
- When you tell the seller you will pass something to the seller team, call tool:log_seller_team_note with a one-sentence note. Only say it has been noted after the tool replies.
- When the seller has agreed to the plan, call tool:schedule_followup with in_days 7 and a short topic. Tell the seller the day from the tool's reply. Never promise a follow-up without calling this tool.
- If the tool's reply has had_previous_call true, mention it in one sentence before sharing the numbers: say when you last spoke and ask whether the seller managed to do the agreed steps (previous_call_agreed_steps). Use the answer in your advice. If had_previous_call is false, do not mention any earlier call.
- Before the call ends, make sure these variables are filled in English, one short line each: key_issues, recommendations, next_steps, call_summary, call_outcome.
```

Then commit the version.

## Optional: lock the tools

Set `SARVAM_TOOL_TOKEN` to any long random value in the server's environment. In each tool's **Auth**, choose bearer token and store the same value. The server then rejects tool calls without it.

## Check it works

Make a call from the deployed page. During the call the "What the agent is doing" panel should show the data lookup, the note and the follow-up. A few seconds after the call ends, the "Call summary" card should appear.
