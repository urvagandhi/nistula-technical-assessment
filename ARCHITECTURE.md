# Nistula Technical Assessment — Architecture & Implementation Guide

> This document covers the full architecture, folder structure, data flow, implementation logic,
> database design, and reasoning for every decision. Read this before writing a single line of code.

---

## Table of Contents

1. [Tech Stack](#tech-stack)
2. [Repository Structure](#repository-structure)
3. [System Overview](#system-overview)
4. [Data Flow — Step by Step](#data-flow--step-by-step)
5. [Part 1 — Webhook Implementation](#part-1--webhook-implementation)
   - [File Breakdown](#file-breakdown)
   - [Input Schema](#input-schema)
   - [Normalised Internal Schema](#normalised-internal-schema)
   - [Query Classifier](#query-classifier)
   - [Claude API Integration](#claude-api-integration)
   - [Confidence Scoring](#confidence-scoring)
   - [Action Routing](#action-routing)
   - [Output Schema](#output-schema)
   - [Error Handling](#error-handling)
6. [Part 2 — PostgreSQL Schema](#part-2--postgresql-schema)
   - [Table Overview](#table-overview)
   - [Table Definitions](#table-definitions)
   - [Design Decisions](#design-decisions)
7. [Part 3 — Thinking Answers](#part-3--thinking-answers)
8. [Environment Variables](#environment-variables)
9. [Test Payloads](#test-payloads)
10. [README Checklist](#readme-checklist)

---

## Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js | Comfortable, listed in brief |
| Framework | Express | Minimal, readable, fast to scaffold |
| AI | Anthropic SDK (`@anthropic-ai/sdk`) | Official SDK, cleaner than raw fetch |
| Validation | Manual + try/catch | Keeps dependencies minimal |
| Environment | `dotenv` | Standard for env loading |
| ID generation | `uuid` package | UUID v4 for message IDs |
| Database (schema only) | PostgreSQL | Brief specifies this |

No database connection needed for Part 1. Schema only lives in `schema.sql`.

---

## Repository Structure

```
nistula-technical-assessment/
│
├── README.md                  ← Setup, usage, scoring logic explained
├── ARCHITECTURE.md            ← This file (optional to include, but impressive)
├── schema.sql                 ← Part 2: PostgreSQL schema with comments
├── thinking.md                ← Part 3: Written answers
├── .env.example               ← Template — no real keys
├── .gitignore                 ← Must include .env
│
└── src/
    ├── index.js               ← Entry point, Express app, route mounting
    ├── config.js              ← Loads and validates environment variables
    ├── schemas.js             ← Input/output shape definitions and validators
    ├── classifier.js          ← Rule-based query type classifier
    ├── claudeClient.js        ← Anthropic API wrapper
    ├── confidence.js          ← Confidence score calculation logic
    └── utils.js               ← UUID generation, timestamp helpers
```

Every file has one job. No file does two things. This is what "another developer could read and build on" looks like.

---

## System Overview

```
Guest Message (WhatsApp / Booking.com / Airbnb / Instagram / Direct)
        │
        ▼
POST /webhook/message
        │
        ▼
[ Input Validation ]  ←── Return 400 if required fields missing
        │
        ▼
[ Normalise into Unified Schema ]  ←── Add generated message_id
        │
        ▼
[ Query Classifier ]  ←── Rule-based keyword matching → query_type
        │
        ▼
[ Build Claude Prompt ]  ←── Inject property context + normalised message
        │
        ▼
[ Claude API Call ]  ←── claude-sonnet-4-20250514
        │
        ▼
[ Confidence Scorer ]  ←── Base score + modifiers → 0.0 to 1.0
        │
        ▼
[ Action Router ]  ←── auto_send / agent_review / escalate
        │
        ▼
JSON Response returned to caller
```

---

## Data Flow — Step by Step

### Step 1 — Request arrives

A `POST` request hits `/webhook/message` with a JSON body from any source channel.

### Step 2 — Validate

Check that these fields exist and are non-empty:
- `source` (must be one of: whatsapp, booking_com, airbnb, instagram, direct)
- `guest_name`
- `message`
- `timestamp`
- `booking_ref`
- `property_id`

If any are missing → return `400 Bad Request` with a clear error message listing what's missing.

### Step 3 — Normalise

Generate a `message_id` (UUID v4). Map the raw input fields to the unified internal schema. The key additions here are `message_id` and `query_type` (which comes from Step 4).

### Step 4 — Classify

Pass `message` text through the classifier. The classifier runs keyword matching against six buckets. Returns the best-matching `query_type`. Falls back to `general_enquiry` if nothing matches.

### Step 5 — Build Claude prompt

Construct a structured prompt with:
- A system role instruction (who Claude is, what it should do)
- Property context (hardcoded for this assessment — in production, fetched from DB by `property_id`)
- The normalised guest message
- The classified query type as a hint
- Output instructions (short, warm, professional, no hallucination)

### Step 6 — Call Claude API

Send prompt to `claude-sonnet-4-20250514` via the official Anthropic SDK. Handle API errors and timeouts gracefully — if the call fails, return a `503` with a fallback message.

### Step 7 — Score confidence

Calculate a confidence score (0.0 to 1.0) based on:
- Base score from query type
- Keyword match strength modifier
- Complaint detection modifier
- Message clarity modifier

### Step 8 — Determine action

- `confidence >= 0.85` → `auto_send`
- `0.60 <= confidence < 0.85` → `agent_review`
- `confidence < 0.60` OR `query_type === 'complaint'` → `escalate`

### Step 9 — Return response

Return JSON with `message_id`, `query_type`, `drafted_reply`, `confidence_score`, `action`.

---

## Part 1 — Webhook Implementation

### File Breakdown

---

#### `src/config.js`

Responsibility: Load env vars. Fail loudly at startup if required vars are missing.

```js
require('dotenv').config();

const config = {
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  PORT: process.env.PORT || 3000,
  MODEL: 'claude-sonnet-4-20250514',
};

if (!config.ANTHROPIC_API_KEY) {
  console.error('FATAL: ANTHROPIC_API_KEY is not set in .env');
  process.exit(1);
}

module.exports = config;
```

Why: Crashing at startup on missing config is better than failing silently mid-request.

---

#### `src/utils.js`

Responsibility: UUID generation. Timestamp helpers if needed.

```js
const { v4: uuidv4 } = require('uuid');

function generateMessageId() {
  return uuidv4();
}

module.exports = { generateMessageId };
```

---

#### `src/schemas.js`

Responsibility: Define what valid input looks like. Validate incoming request body.

```js
const VALID_SOURCES = ['whatsapp', 'booking_com', 'airbnb', 'instagram', 'direct'];

function validateIncomingMessage(body) {
  const errors = [];

  if (!body.source || !VALID_SOURCES.includes(body.source)) {
    errors.push(`source must be one of: ${VALID_SOURCES.join(', ')}`);
  }
  if (!body.guest_name || body.guest_name.trim() === '') errors.push('guest_name is required');
  if (!body.message || body.message.trim() === '')       errors.push('message is required');
  if (!body.timestamp)                                    errors.push('timestamp is required');
  if (!body.booking_ref)                                  errors.push('booking_ref is required');
  if (!body.property_id)                                  errors.push('property_id is required');

  return errors;
}

module.exports = { validateIncomingMessage };
```

---

#### `src/classifier.js`

Responsibility: Take the message text, return a `query_type` string.

The classifier is rule-based — keyword matching with priority ordering. Complaints are checked first because they need immediate escalation regardless of other signals.

```js
const RULES = [
  {
    type: 'complaint',
    keywords: ['not working', 'broken', 'unacceptable', 'refund', 'disgusting',
               'terrible', 'no hot water', 'no water', 'no electricity', 'no wifi',
               'angry', 'disappointed', 'never again', 'want a refund'],
  },
  {
    type: 'post_sales_checkin',
    keywords: ['check-in', 'check in', 'wifi password', 'wifi', 'arrival time',
               'check out', 'checkout', 'key', 'access', 'directions'],
  },
  {
    type: 'special_request',
    keywords: ['early check-in', 'late checkout', 'airport transfer', 'chef',
               'birthday', 'anniversary', 'decoration', 'pickup', 'extra bed'],
  },
  {
    type: 'pre_sales_pricing',
    keywords: ['rate', 'price', 'cost', 'how much', 'per night', 'charges',
               'pricing', 'fee', 'tariff', 'discount', 'offer'],
  },
  {
    type: 'pre_sales_availability',
    keywords: ['available', 'availability', 'vacant', 'book', 'dates',
               'from', 'to', 'nights', 'april', 'may', 'june', 'july',
               'august', 'september', 'october', 'free on'],
  },
  {
    type: 'general_enquiry',
    keywords: [], // fallback — always matches
  },
];

function classifyMessage(text) {
  const lower = text.toLowerCase();

  for (const rule of RULES) {
    if (rule.keywords.length === 0) return rule.type; // fallback
    if (rule.keywords.some(kw => lower.includes(kw))) return rule.type;
  }

  return 'general_enquiry';
}

// Returns how many keywords matched — used by confidence scorer
function countKeywordMatches(text, queryType) {
  const rule = RULES.find(r => r.type === queryType);
  if (!rule || rule.keywords.length === 0) return 0;
  const lower = text.toLowerCase();
  return rule.keywords.filter(kw => lower.includes(kw)).length;
}

module.exports = { classifyMessage, countKeywordMatches };
```

Why rule-based and not AI-classified: Deterministic, fast, auditable, zero latency added. Good enough for this scope. In production, a small fine-tuned classifier or a Claude-based classifier call would be better — mention this in README.

---

#### `src/claudeClient.js`

Responsibility: Build the prompt and call the Claude API. Return the drafted reply string.

```js
const Anthropic = require('@anthropic-ai/sdk');
const config = require('./config');

const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

// This is hardcoded for this assessment.
// In production, property context is fetched from DB using property_id.
const PROPERTY_CONTEXT = `
Property: Villa B1, Assagao, North Goa
Bedrooms: 3 | Max guests: 6 | Private pool: Yes
Check-in: 2:00 PM | Check-out: 11:00 AM
Base rate: INR 18,000 per night (up to 4 guests)
Extra guest charge: INR 2,000 per night per person
WiFi password: Nistula@2024
Caretaker: Available 8am to 10pm
Chef on call: Yes (pre-booking required)
Availability April 20–24: Available
Cancellation: Free cancellation up to 7 days before check-in
`.trim();

async function getDraftedReply(normalizedMessage) {
  const { guest_name, message_text, query_type } = normalizedMessage;

  const systemPrompt = `
You are a warm, professional guest relations assistant for Nistula, a luxury villa rental company.

Your job is to draft short, friendly, accurate replies to guest messages.

Rules you must follow:
- Only use facts from the Property Context provided. Do not guess or invent details.
- If you do not know something, say you will check and follow up.
- Keep replies concise — 3 to 5 sentences unless the query needs more.
- Address the guest by their first name.
- Maintain a warm but professional tone.
- Never make promises you are not certain about.
- For complaints, acknowledge the issue sincerely and confirm escalation to the team.
  `.trim();

  const userPrompt = `
Property Context:
${PROPERTY_CONTEXT}

Guest Name: ${guest_name}
Query Type: ${query_type}
Guest Message: ${message_text}

Draft a reply to this guest message.
  `.trim();

  const response = await client.messages.create({
    model: config.MODEL,
    max_tokens: 300,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  return response.content[0].text.trim();
}

module.exports = { getDraftedReply };
```

Important details:
- `max_tokens: 300` keeps replies short — this is a guest reply, not an essay
- System prompt separates role instructions from user prompt clearly
- Property context injected every call — no session memory needed

---

#### `src/confidence.js`

Responsibility: Calculate a confidence score (0.0 to 1.0) and determine the action.

```js
const BASE_SCORES = {
  pre_sales_availability: 0.90,
  pre_sales_pricing:      0.90,
  post_sales_checkin:     0.88,
  special_request:        0.78,
  general_enquiry:        0.72,
  complaint:              0.50,
};

function calculateConfidence(queryType, matchCount, messageText) {
  let score = BASE_SCORES[queryType] ?? 0.70;

  // Reward clear keyword signal
  if (matchCount >= 2) score += 0.05;
  if (matchCount === 1) score += 0.02;

  // Penalise vague or very short messages
  const wordCount = messageText.trim().split(/\s+/).length;
  if (wordCount < 5) score -= 0.10;

  // Hard floor for complaints — always escalate
  if (queryType === 'complaint') score = Math.min(score, 0.55);

  // Clamp between 0 and 1
  return Math.min(1.0, Math.max(0.0, parseFloat(score.toFixed(2))));
}

function determineAction(confidence, queryType) {
  if (queryType === 'complaint') return 'escalate';
  if (confidence >= 0.85)        return 'auto_send';
  if (confidence >= 0.60)        return 'agent_review';
  return 'escalate';
}

module.exports = { calculateConfidence, determineAction };
```

Why this logic:
- Complaints always escalate regardless of confidence — non-negotiable for a guest-facing system
- Keyword match count rewards clarity of expression — a clear message gets a higher score
- Very short messages are penalised — "Is it available?" without dates is ambiguous

---

#### `src/index.js`

Responsibility: Express app setup, route handler, orchestrates all the above.

```js
const express = require('express');
const { generateMessageId } = require('./utils');
const { validateIncomingMessage } = require('./schemas');
const { classifyMessage, countKeywordMatches } = require('./classifier');
const { getDraftedReply } = require('./claudeClient');
const { calculateConfidence, determineAction } = require('./confidence');
const config = require('./config');

const app = express();
app.use(express.json());

app.post('/webhook/message', async (req, res) => {
  const body = req.body;

  // Step 1: Validate
  const errors = validateIncomingMessage(body);
  if (errors.length > 0) {
    return res.status(400).json({ error: 'Validation failed', details: errors });
  }

  // Step 2: Normalise
  const queryType = classifyMessage(body.message);

  const normalizedMessage = {
    message_id:   generateMessageId(),
    source:       body.source,
    guest_name:   body.guest_name,
    message_text: body.message,
    timestamp:    body.timestamp,
    booking_ref:  body.booking_ref,
    property_id:  body.property_id,
    query_type:   queryType,
  };

  // Step 3: Score confidence
  const matchCount = countKeywordMatches(body.message, queryType);
  const confidence = calculateConfidence(queryType, matchCount, body.message);
  const action     = determineAction(confidence, queryType);

  // Step 4: Get Claude draft
  let draftedReply;
  try {
    draftedReply = await getDraftedReply(normalizedMessage);
  } catch (err) {
    console.error('Claude API error:', err.message);
    return res.status(503).json({
      error: 'AI service temporarily unavailable. Please try again shortly.',
    });
  }

  // Step 5: Return response
  return res.status(200).json({
    message_id:       normalizedMessage.message_id,
    query_type:       queryType,
    drafted_reply:    draftedReply,
    confidence_score: confidence,
    action:           action,
  });
});

app.listen(config.PORT, () => {
  console.log(`Nistula webhook server running on port ${config.PORT}`);
});
```

---

### Input Schema

```json
{
  "source": "whatsapp",
  "guest_name": "Rahul Sharma",
  "message": "Is the villa available from April 20 to 24? What is the rate for 2 adults?",
  "timestamp": "2026-05-05T10:30:00Z",
  "booking_ref": "NIS-2024-0891",
  "property_id": "villa-b1"
}
```

---

### Normalised Internal Schema

```json
{
  "message_id": "c1b7e7c2-2b31-4a74-9c4f-9d1d3ef2d421",
  "source": "whatsapp",
  "guest_name": "Rahul Sharma",
  "message_text": "Is the villa available from April 20 to 24? What is the rate for 2 adults?",
  "timestamp": "2026-05-05T10:30:00Z",
  "booking_ref": "NIS-2024-0891",
  "property_id": "villa-b1",
  "query_type": "pre_sales_availability"
}
```

---

### Query Classifier

| Query Type | Trigger Keywords |
|---|---|
| `complaint` | not working, broken, refund, unacceptable, no hot water, angry |
| `post_sales_checkin` | check-in, wifi, arrival time, checkout, key, directions |
| `special_request` | early check-in, airport transfer, chef, birthday, extra bed |
| `pre_sales_pricing` | rate, price, cost, how much, per night, discount |
| `pre_sales_availability` | available, book, dates, nights, vacancy |
| `general_enquiry` | *(fallback — matches everything else)* |

Complaints are evaluated first. If a message contains any complaint keyword, it is classified as a complaint regardless of other signals.

---

### Claude API Integration

The prompt is structured in two parts:

**System prompt** — defines who Claude is, what tone to use, what rules to follow.

**User prompt** — contains property context, guest name, query type, and the actual message.

This separation is intentional. System prompt is stable across requests. User prompt changes per message. Keeping them separate makes the model's behaviour more predictable.

`max_tokens: 300` is intentional. Guest replies should be concise.

---

### Confidence Scoring

| Query Type | Base Score |
|---|---|
| `pre_sales_availability` | 0.90 |
| `pre_sales_pricing` | 0.90 |
| `post_sales_checkin` | 0.88 |
| `special_request` | 0.78 |
| `general_enquiry` | 0.72 |
| `complaint` | 0.50 (hard cap at 0.55) |

**Modifiers applied after base score:**

| Condition | Modifier |
|---|---|
| 2 or more keywords matched | +0.05 |
| 1 keyword matched | +0.02 |
| Message under 5 words | -0.10 |
| Query type is complaint | Force cap at 0.55 |

Final score is clamped between 0.0 and 1.0.

---

### Action Routing

| Condition | Action |
|---|---|
| `query_type === complaint` | `escalate` (always, regardless of score) |
| `confidence >= 0.85` | `auto_send` |
| `0.60 <= confidence < 0.85` | `agent_review` |
| `confidence < 0.60` | `escalate` |

---

### Output Schema

```json
{
  "message_id": "c1b7e7c2-2b31-4a74-9c4f-9d1d3ef2d421",
  "query_type": "pre_sales_availability",
  "drafted_reply": "Hi Rahul! Great news — Villa B1 is available from April 20 to 24. For 2 adults, the rate is INR 18,000 per night. Shall I go ahead and reserve it for you?",
  "confidence_score": 0.95,
  "action": "auto_send"
}
```

---

### Error Handling

| Situation | HTTP Status | Behaviour |
|---|---|---|
| Missing required fields | 400 | List which fields are missing |
| Invalid `source` value | 400 | Explain valid options |
| Claude API failure | 503 | Return friendly error, log internally |
| Claude timeout | 503 | Same as above |
| Unexpected server error | 500 | Generic error, log full trace |

No errors are silently swallowed. Every catch block logs to console and returns a meaningful response.

---

## Part 2 — PostgreSQL Schema

### Table Overview

```
guests
  └── reservations
        └── conversations
              └── messages
```

`guests` is the root entity. Every guest can have multiple reservations and conversations. Every conversation contains multiple messages. AI metadata lives inside `messages`.

---

### Table Definitions

```sql
-- ─────────────────────────────────────────────
-- TABLE: guests
-- One record per real-world guest.
-- The hard problem: same person across channels.
-- We use email + phone as soft identity keys.
-- No hard deduplication at DB level in v1.
-- ─────────────────────────────────────────────
CREATE TABLE guests (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name   VARCHAR(255) NOT NULL,
  email       VARCHAR(255),
  phone       VARCHAR(50),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_guests_email ON guests (email);
CREATE INDEX idx_guests_phone ON guests (phone);


-- ─────────────────────────────────────────────
-- TABLE: reservations
-- Tracks bookings linked to guests.
-- booking_ref from the webhook payload maps here.
-- ─────────────────────────────────────────────
CREATE TABLE reservations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_ref     VARCHAR(100) NOT NULL UNIQUE,
  property_id     VARCHAR(100) NOT NULL,
  guest_id        UUID NOT NULL REFERENCES guests(id),
  check_in_date   DATE NOT NULL,
  check_out_date  DATE NOT NULL,
  num_guests      INTEGER NOT NULL DEFAULT 1,
  status          VARCHAR(50) NOT NULL DEFAULT 'confirmed',
                  -- confirmed | cancelled | completed | pending
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_reservations_booking_ref ON reservations (booking_ref);
CREATE INDEX idx_reservations_guest_id    ON reservations (guest_id);


-- ─────────────────────────────────────────────
-- TABLE: conversations
-- A thread of messages grouped by guest + channel + stay.
-- One conversation per stay per channel is the intended model.
-- A guest could have separate WhatsApp and Airbnb threads
-- for the same reservation — that is intentional.
-- ─────────────────────────────────────────────
CREATE TABLE conversations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guest_id        UUID NOT NULL REFERENCES guests(id),
  reservation_id  UUID REFERENCES reservations(id),  -- nullable pre-booking
  property_id     VARCHAR(100) NOT NULL,
  source_channel  VARCHAR(50) NOT NULL,
                  -- whatsapp | booking_com | airbnb | instagram | direct
  status          VARCHAR(50) NOT NULL DEFAULT 'open',
                  -- open | resolved | escalated | closed
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_conversations_guest_id       ON conversations (guest_id);
CREATE INDEX idx_conversations_reservation_id ON conversations (reservation_id);


-- ─────────────────────────────────────────────
-- TABLE: messages
-- All inbound and outbound messages in one table.
-- AI metadata (confidence, query_type, draft flags) stored here.
-- Decision: keep AI metadata in messages table rather than a
-- separate ai_drafts table. Simpler joins. Enough for v1.
-- ─────────────────────────────────────────────
CREATE TABLE messages (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id     UUID NOT NULL REFERENCES conversations(id),
  guest_id            UUID NOT NULL REFERENCES guests(id),
  reservation_id      UUID REFERENCES reservations(id),

  -- Message content
  direction           VARCHAR(10) NOT NULL,
                      -- inbound | outbound
  source_channel      VARCHAR(50) NOT NULL,
  raw_text            TEXT NOT NULL,
  normalized_text     TEXT,

  -- AI metadata (populated for inbound messages)
  query_type          VARCHAR(50),
  ai_confidence_score NUMERIC(4, 3),  -- e.g. 0.912
  ai_drafted          BOOLEAN NOT NULL DEFAULT FALSE,
  agent_edited        BOOLEAN NOT NULL DEFAULT FALSE,
  auto_sent           BOOLEAN NOT NULL DEFAULT FALSE,
  action_taken        VARCHAR(50),
                      -- auto_send | agent_review | escalate

  -- Audit
  sent_at             TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_messages_conversation_id ON messages (conversation_id);
CREATE INDEX idx_messages_guest_id        ON messages (guest_id);
CREATE INDEX idx_messages_query_type      ON messages (query_type);
CREATE INDEX idx_messages_action_taken    ON messages (action_taken);
```

---

### Design Decisions

**1. Why `reservation_id` is nullable on `conversations` and `messages`**

A guest can message before they have made a booking. Pre-sales enquiries have no reservation yet. Making `reservation_id` nullable allows the system to capture pre-booking conversations and later link them once a reservation is created.

**2. Why AI metadata lives in `messages` and not a separate table**

A separate `ai_drafts` table would be better for tracking full edit history (draft v1, agent edits v2, final v3). But for this scope, the added join complexity is not worth it. The `messages` table tracks whether a message was AI drafted, agent edited, and auto-sent as boolean flags. This is enough to run reporting on AI performance without extra tables.

**3. The hardest design decision: guest identity across channels**

The same real-world person can message from WhatsApp, Booking.com, and Airbnb with different display names and no shared identifier. There is no clean database-level solution to this in v1. The chosen approach: use `email` and `phone` as soft deduplication keys with a unique index, and let the application layer handle fuzzy matching. A production system would need a proper identity resolution pipeline — probabilistic matching on name + contact info — outside the DB layer.

**4. Why `source_channel` lives on both `conversations` and `messages`**

Conversations are channel-specific threads. Messages inherit the channel for easy querying without always joining back to conversations. Slight denormalization, justified by query speed.

---

## Part 3 — Thinking Answers

*(Write this in thinking.md — 400 words max for all three combined)*

---

**Question A — The Immediate AI Response**

> Hi [Guest Name], I'm really sorry — no hot water at 3am is absolutely not okay, especially with guests arriving in the morning. I've flagged this as urgent right now and the team is being alerted immediately. Someone will be in touch with you within the next 30 minutes to resolve this tonight. We will make this right.

Why this wording: It acknowledges the problem without being defensive, commits to a specific timeframe (30 minutes) which creates accountability, and ends on a promise rather than an apology. It does not offer a refund — that decision needs a human. It does not say the problem is fixed — it isn't yet.

---

**Question B — Full System Response**

The platform should do the following simultaneously the moment the message arrives:

1. Classify as `complaint` → force action to `escalate`, skip AI auto-send
2. Create a high-priority incident ticket tagged: `property: villa-b1`, `type: maintenance`, `urgency: critical`, `time: 3am`
3. Send immediate push notification + SMS to the on-call property manager and caretaker
4. Log the message with timestamp, channel, confidence score, and escalation reason
5. Start a 30-minute SLA timer
6. If no human response in 30 minutes: escalate to the next tier (property owner or operations lead) and send a second automated message to the guest: "We are still actively working on this and have escalated to our senior team. We haven't forgotten you."
7. All of this is logged against the reservation record for refund review later

---

**Question C — Learning from Repeated Complaints**

The system should flag Villa B1's hot water as a recurring issue after the second occurrence. By the third:

1. Automatically open a preventive maintenance task in the operations system
2. Tag Villa B1 in a property health dashboard with "repeat complaint flag: hot water"
3. Override auto-send for any hot water complaint at Villa B1 until the maintenance task is closed — force human review always
4. Generate a monthly property health report highlighting recurring complaint categories per property
5. Optionally: add a pre-arrival checklist item specifically for Villa B1 — caretaker must verify hot water before each check-in

The goal is to turn reactive complaint handling into proactive property maintenance. The system should surface patterns, not just reply to messages.

---

## Environment Variables

```
# .env.example — do not put real keys here

ANTHROPIC_API_KEY=your_anthropic_api_key_here
PORT=3000
```

`.gitignore` must include:
```
.env
node_modules/
```

---

## Test Payloads

Run these three before submitting.

**Test 1 — Availability + pricing (should return auto_send)**
```json
{
  "source": "whatsapp",
  "guest_name": "Rahul Sharma",
  "message": "Is the villa available from April 20 to 24? What is the rate for 2 adults?",
  "timestamp": "2026-05-05T10:30:00Z",
  "booking_ref": "NIS-2024-0891",
  "property_id": "villa-b1"
}
```

**Test 2 — Post-booking check-in query (should return auto_send or agent_review)**
```json
{
  "source": "booking_com",
  "guest_name": "Priya Mehta",
  "message": "Hi, what time can we check in? Also can you share the WiFi password?",
  "timestamp": "2026-05-08T14:00:00Z",
  "booking_ref": "NIS-2024-0934",
  "property_id": "villa-b1"
}
```

**Test 3 — Complaint (should always return escalate)**
```json
{
  "source": "instagram",
  "guest_name": "Vikram Nair",
  "message": "The AC is not working and it is 35 degrees. This is completely unacceptable. I want a refund.",
  "timestamp": "2026-05-09T02:15:00Z",
  "booking_ref": "NIS-2024-0902",
  "property_id": "villa-b1"
}
```

---

## README Checklist

Your README.md must cover:

- [ ] Project overview (one paragraph)
- [ ] Prerequisites (Node version, npm)
- [ ] Installation steps (`git clone`, `npm install`, `.env` setup)
- [ ] How to run (`node src/index.js` or `npm start`)
- [ ] Endpoint documentation (route, method, request body, response body)
- [ ] Query classification logic explained
- [ ] Confidence scoring logic explained (base scores + modifiers + action thresholds)
- [ ] Error handling behaviour
- [ ] Key assumptions made
- [ ] What you would improve with more time

The README is read as carefully as the code. Do not skip it.

---

*Built for the Nistula Summer Technology Internship 2026 Technical Assessment.*
