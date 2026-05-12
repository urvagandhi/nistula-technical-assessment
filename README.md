# Nistula — AI Guest Messaging Webhook

A webhook that ingests guest messages from multiple booking channels (WhatsApp, Booking.com, Airbnb, Instagram, Direct), classifies them, asks Claude to draft a reply **and self-rate how grounded the reply is**, then converts those signals into a real confidence score and a routing action (`auto_send`, `agent_review`, `escalate`).

Built for the Nistula Summer Technology Internship 2026 Technical Assessment.

---

## Contents

```text
src/
├── index.js          ← Express app, route handler
├── config.js         ← env loading, fail-fast on missing key
├── schemas.js        ← input validation
├── classifier.js     ← rule-based query type classifier
├── claudeClient.js   ← Anthropic SDK + tool_use → { draft, self_rating }
├── confidence.js     ← signal-based confidence score
├── properties.js     ← property registry, looked up by property_id
└── utils.js          ← UUID v4
tests/
├── classifier.test.js
└── confidence.test.js
schema.sql            ← Part 2: Postgres schema (production-grade; not yet wired to app — see "Roadmap")
thinking.md           ← Part 3: written answers
```

### Part 2 — Schema highlights

7 tables: `properties`, `agents`, `guests`, `reservations`, `conversations`, `messages`, `ai_drafts`.

- **CHECK constraints** on every enum-like column (`direction`, `source_channel`, `status`, `action_taken`, `query_type`) so the DB itself rejects `'WhatsApp'` next to `'whatsapp'`.
- **`ai_confidence_score BETWEEN 0 AND 1`** enforced (the type alone allowed up to 9.999).
- **Partial UNIQUE** on `LOWER(guests.email)` and `guests.phone`, gated on `deleted_at IS NULL` — enforces "one record per guest" when contact info is present, while allowing GDPR right-to-erasure + re-registration.
- **`messages.received_at`** stores the guest send-time from the payload (distinct from `created_at` row-insert time, which can lag).
- **Idempotency**: `UNIQUE (source_channel, external_message_id)` — duplicate webhook deliveries can't create duplicate rows.
- **`messages.raw_payload JSONB`** for replay/debug.
- **`ai_drafts`** table — full versioned edit history (v1 = AI initial, v2..N = agent edits), satisfying "tracking AI drafted / agent edited" with actual history rather than booleans alone.
- **`agents`** table with FK from `ai_drafts.edited_by_agent_id` — accountability on edits.
- **Consistency CHECKs**: `auto_sent → sent_at NOT NULL`; `ai_drafted → ai_model NOT NULL`; inbound rows can't carry send flags.
- **`updated_at` triggers** on every timestamped table — guaranteed bump, no app-side discipline required.
- **Explicit `ON DELETE`** on every FK (RESTRICT on guests/properties, CASCADE on conversation→messages and message→ai_drafts, SET NULL on reservation links).
- **Seed**: `villa-b1` inserted into `properties` so the existing webhook continues to work once the DB is wired in.

Schema applied + stress-tested against a local Postgres 13+ during this build — every CHECK and partial-UNIQUE confirmed to reject the bad cases and accept the legitimate ones (including same-email-across-soft-delete and same-`external_message_id`-across-channels).

---

## Prerequisites

| | |
|---|---|
| Node.js | **18 or newer** (tested on Node 24) |
| npm | 9 or newer |
| Anthropic API key | from [console.anthropic.com](https://console.anthropic.com) |

---

## Installation

```bash
git clone <repo-url> nistula-technical-assessment
cd nistula-technical-assessment

npm install

cp .env.example .env
# Paste your real ANTHROPIC_API_KEY into .env
```

---

## Running

```bash
npm start
# → "Nistula webhook server running on port 3000"

# Health check
curl http://localhost:3000/health
# {"status":"ok"}

# Unit tests (pure functions, no API key needed)
npm test
```

The server fails fast at startup if `ANTHROPIC_API_KEY` is missing — better than failing silently mid-request.

---

## Endpoint

### `POST /webhook/message`

#### Request

| Field | Type | Notes |
|---|---|---|
| `source` | string | One of: `whatsapp`, `booking_com`, `airbnb`, `instagram`, `direct` |
| `guest_name` | string | Non-empty |
| `message` | string | Guest's raw message |
| `timestamp` | string | ISO-8601 |
| `booking_ref` | string | PMS booking reference |
| `property_id` | string | Must exist in the property registry (e.g. `villa-b1`) |

```bash
curl -s -X POST http://localhost:3000/webhook/message \
  -H 'Content-Type: application/json' \
  -d '{
    "source": "whatsapp",
    "guest_name": "Rahul Sharma",
    "message": "Is the villa available from April 20 to 24? What is the rate for 2 adults?",
    "timestamp": "2026-05-05T10:30:00Z",
    "booking_ref": "NIS-2024-0891",
    "property_id": "villa-b1"
  }'
```

#### Response

```json
{
  "message_id": "c1b7e7c2-…",
  "query_type": "pre_sales_pricing",
  "drafted_reply": "Hi Rahul, …",
  "confidence_score": 0.92,
  "action": "auto_send",
  "confidence_signals": {
    "keyword_match_count": 1,
    "self_rating": { "had_all_facts": true, "hedged": false, "missing_facts": [] },
    "penalty_reasons": ["one_keyword_match"]
  }
}
```

`confidence_signals` is exposed so the receiving system (or a reviewer) can see exactly *why* a score landed where it did — every deduction is named.

---

## Query Classification

Rule-based. Priority-ordered list of keyword buckets, **complaints checked first** so they escalate regardless of other signals.

| Priority | Type | Example keywords |
|---|---|---|
| 1 | `complaint` | `not working`, `refund`, `unacceptable`, `no hot water`, `angry` |
| 2 | `post_sales_checkin` | `check-in`, `wifi`, `checkout`, `key`, `directions` |
| 3 | `special_request` | `early check-in`, `airport transfer`, `chef`, `birthday`, `extra bed` |
| 4 | `pre_sales_pricing` | `rate`, `price`, `cost`, `per night`, `discount` |
| 5 | `pre_sales_availability` | `available`, `book`, `dates`, `nights`, month names |
| 6 | `general_enquiry` | *(fallback)* |

Why rule-based: deterministic, fast, auditable, zero added latency. A production system would back this with a small fine-tuned classifier or a fast Claude classifier call — see *Roadmap*.

---

## Confidence Scoring (real, not hardcoded)

**The previous version was a category prior, not a confidence score** — `BASE_SCORES['pre_sales_pricing'] = 0.90` returned the same number whether the draft actually had the facts or made them up. That's gone.

Now confidence starts at **0.95** and is deducted by observable risk signals, each of which is exposed in the response under `penalty_reasons`.

### The signals

| Source | Signal | Penalty | Why |
| --- | --- | --- | --- |
| Claude self-rating (via tool_use) | `had_all_facts === false` | −0.20 | The model itself reports missing context — high hallucination risk |
| Claude self-rating | `hedged === true` | −0.10 | "I'll check with the team" — the reply isn't actually answering |
| Claude self-rating | per item in `missing_facts[]` | −0.05 each, capped at −0.20 | Each missing fact is a real gap |
| Message | word count < 5 | −0.10 | *"Is it available?"* without dates is ambiguous |
| Message | ≥ 2 question marks | −0.03 | Multi-intent — harder to answer cleanly |
| Classifier | 0 keyword matches | −0.05 | Fell through to fallback / weak signal |
| Classifier | exactly 1 keyword match | −0.02 | Single weak signal |
| Classifier | 2+ keyword matches | 0 | Fully reinforced classification |

### Hard rules

- `query_type === 'complaint'` → score capped at **0.55**, action forced to `escalate`. Non-negotiable for a guest-facing system.
- Final score clamped to `[0.0, 1.0]`, rounded to 2 decimals.

### How Claude returns its self-rating

`claudeClient.js` makes **one** Claude call that uses `tool_use` to force structured output. Claude must call the `submit_reply` tool with:

```json
{
  "reply_text": "Hi Rahul, …",
  "had_all_facts": true,
  "hedged": false,
  "missing_facts": []
}
```

No second grading call, no extra latency — the model rates itself in the same turn.

### Action routing

| Condition | Action |
|---|---|
| `query_type === complaint` | `escalate` |
| `confidence >= 0.85` | `auto_send` |
| `0.60 <= confidence < 0.85` | `agent_review` |
| `confidence < 0.60` | `escalate` |

---

## Property Context (looked up by `property_id`)

Property facts (rate, WiFi password, caretaker hours, etc.) live in [`src/properties.js`](src/properties.js) as a structured registry keyed by `property_id`. `claudeClient.js` fetches the context via `properties.getById(property_id)` on every request — the `property_id` field from the webhook is finally doing work.

```js
properties.getById('villa-b1')  // → { id, name, context }
properties.getById('unknown')   // → null → handler returns 400
```

A `400` is returned for unknown `property_id`s with the list of known IDs — no point calling Claude with no context.

The shape mirrors a `properties` row in `schema.sql`. When the DB is wired in next (see *Roadmap*), `getById` becomes a `SELECT`, no other file changes.

---

## Error Handling

| Situation | HTTP | Body |
|---|---|---|
| Missing/invalid required fields | `400` | `{ error: "Validation failed", details: [...] }` |
| Unknown `property_id` | `400` | `{ error: "Unknown property_id: …", details: ["known property_ids: …"] }` |
| Malformed JSON | `400` | `{ error: "Invalid JSON body" }` |
| Claude API failure or timeout | `503` | `{ error: "AI service temporarily unavailable…" }` |
| Unexpected server error | `500` | `{ error: "Internal server error" }` (full trace logged) |

No errors are silently swallowed.

---

## Tests

```bash
npm test     # → 23 tests, all pass
```

- `tests/classifier.test.js` — priority order, fallback, case-insensitivity, match counting.
- `tests/confidence.test.js` — each penalty in isolation, clamp/round behaviour, complaint cap, action thresholds at the boundary.

Pure functions, no API key or DB needed.

---

## Key Assumptions

1. **No database connection wired up yet** (deferred — see *Roadmap*). `schema.sql` is delivered as the design artefact. Property context lives in [`src/properties.js`](src/properties.js) and persistence of conversations/messages is not yet implemented.
2. **Property context is the source of truth.** Claude is instructed to use only context it was given and to flag anything missing via `missing_facts[]`.
3. **`timestamp` is trusted, not parsed.** Presence-validated only; the calling PMS is the source of truth.
4. **No authentication on the webhook.** A real integration would require per-channel HMAC signatures or a shared secret.
5. **One reply, one shot.** No retry loop on transient Claude failures — caller gets `503` and is expected to retry. Avoids hidden cost spirals.
6. **Self-rating is trusted.** If Claude reports `had_all_facts: true` but actually made something up, the score will be optimistically high. This is a known limitation of self-assessment; the human-in-the-loop review band (`0.60–0.85`) is the safety net.

---

## Roadmap (deferred from this pass)

- **Wire `schema.sql` to a real Postgres pool** (`src/db.js`) with auto-applied schema on boot, repositories for `guests`/`reservations`/`conversations`/`messages`, and a `properties` table that replaces `src/properties.js`. The properties module is structured to make this a drop-in swap.
- **Persist every message + draft + action** before responding, so the audit trail exists even if the caller drops the response.
- **Authenticate the webhook** with per-channel HMAC signatures.
- **Idempotency keys** — hash `(source, booking_ref, timestamp)` so duplicate webhook deliveries don't trigger duplicate Claude calls.
- **Retry-with-backoff** around the Anthropic SDK call for transient 5xx errors.
- **Stream the draft** to the agent UI (when `agent_review`) so they can edit while Claude is still producing tokens.
- **Replace rule-based classifier** with a small fine-tuned classifier or a fast `claude-haiku` classification call that returns a per-bucket probability vector — feeds directly into confidence as a "classifier certainty" signal.
- **Integration test** against a real Postgres in CI.
- **Structured logging** (pino) with request IDs, instead of `console.error`.
- **Repeat-complaint detector** for the property maintenance loop described in [`thinking.md`](thinking.md) Question C — needs the message history in the DB to work.

---

*Built for the Nistula Summer Technology Internship 2026 Technical Assessment.*
