-- ════════════════════════════════════════════════════════════════════
-- Nistula — Part 2: PostgreSQL Schema (production-grade)
--
-- Hierarchy:
--   properties
--     └── reservations ──► guests
--           └── conversations ──► guests
--                 └── messages ──► (guests, agents)
--                       └── ai_drafts  (full edit history)
--
-- Run on PostgreSQL 13+ (uses gen_random_uuid() from pgcrypto and JSONB).
-- Idempotent — every CREATE uses IF NOT EXISTS so re-running is safe.
-- ════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pgcrypto;


-- ─────────────────────────────────────────────────────────────────────
-- Generic updated_at trigger function — bumps updated_at on every UPDATE.
-- Avoids relying on the app to remember.
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- ════════════════════════════════════════════════════════════════════
-- TABLE: properties
-- The villas Nistula manages. property_id from the webhook payload
-- maps here. Holds the structured context blob the AI uses to draft
-- replies — replaces the previous in-code property registry.
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS properties (
  id          VARCHAR(100) PRIMARY KEY,
  name        VARCHAR(255) NOT NULL,
  context     TEXT NOT NULL,                       -- facts blob fed to Claude
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ                          -- soft-delete; preserves history
);

DROP TRIGGER IF EXISTS trg_properties_updated_at ON properties;
CREATE TRIGGER trg_properties_updated_at
  BEFORE UPDATE ON properties
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE properties IS 'Villas managed by Nistula. property_id in webhook payloads must match a row here.';
COMMENT ON COLUMN properties.context IS 'Facts blob (rate, WiFi, caretaker hours, etc.) injected into the AI prompt.';
COMMENT ON COLUMN properties.deleted_at IS 'Soft delete — keeps reservations/conversations history intact when a property is retired.';


-- ════════════════════════════════════════════════════════════════════
-- TABLE: agents
-- Internal staff who review / edit AI drafts. Required to make
-- "agent_edited" meaningful — we need to know WHO edited.
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS agents (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name   VARCHAR(255) NOT NULL,
  email       VARCHAR(255) NOT NULL,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ
);

-- Partial UNIQUE on email — allows re-adding an email after soft-delete.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_agents_email_active
  ON agents (LOWER(email))
  WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_agents_updated_at ON agents;
CREATE TRIGGER trg_agents_updated_at
  BEFORE UPDATE ON agents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE agents IS 'Internal Nistula staff who can review and edit AI drafts.';


-- ════════════════════════════════════════════════════════════════════
-- TABLE: guests
-- One row per real-world guest. Identity resolution is the hard
-- problem — see "Hardest design decision" at the bottom.
--
-- Partial UNIQUE on email + phone enforces de-duplication when contact
-- info is present, but allows a guest to be soft-deleted (GDPR) and
-- another row created later with the same email.
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS guests (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name   VARCHAR(255) NOT NULL,
  email       VARCHAR(255),
  phone       VARCHAR(50),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ                          -- soft delete for GDPR
);

-- Plain index for lookups (kept from v1)
CREATE INDEX IF NOT EXISTS idx_guests_email ON guests (email);
CREATE INDEX IF NOT EXISTS idx_guests_phone ON guests (phone);

-- Partial UNIQUE — enforces "one record per guest" when we DO have
-- the contact info, while staying silent when we don't.
-- LOWER() normalises email case.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_guests_email_active
  ON guests (LOWER(email))
  WHERE email IS NOT NULL AND deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_guests_phone_active
  ON guests (phone)
  WHERE phone IS NOT NULL AND deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_guests_updated_at ON guests;
CREATE TRIGGER trg_guests_updated_at
  BEFORE UPDATE ON guests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE guests IS 'One real-world guest per row. Soft-deletable for GDPR right-to-erasure.';
COMMENT ON COLUMN guests.deleted_at IS 'Soft delete. Partial UNIQUE on email/phone is gated on this so re-registration after erasure is allowed.';


-- ════════════════════════════════════════════════════════════════════
-- TABLE: reservations
-- Bookings linked to guests + properties.
-- booking_ref is the PMS-side identifier and must be globally unique.
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS reservations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_ref     VARCHAR(100) NOT NULL UNIQUE,
  property_id     VARCHAR(100) NOT NULL
                  REFERENCES properties(id) ON DELETE RESTRICT,
  guest_id        UUID NOT NULL
                  REFERENCES guests(id) ON DELETE RESTRICT,
  check_in_date   DATE NOT NULL,
  check_out_date  DATE NOT NULL,
  num_guests      INTEGER NOT NULL DEFAULT 1 CHECK (num_guests > 0),
  status          VARCHAR(50) NOT NULL DEFAULT 'confirmed'
                  CHECK (status IN ('pending', 'confirmed', 'cancelled', 'completed')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (check_out_date >= check_in_date)
);

CREATE INDEX IF NOT EXISTS idx_reservations_booking_ref ON reservations (booking_ref);
CREATE INDEX IF NOT EXISTS idx_reservations_guest_id    ON reservations (guest_id);
CREATE INDEX IF NOT EXISTS idx_reservations_property_id ON reservations (property_id);
CREATE INDEX IF NOT EXISTS idx_reservations_status      ON reservations (status);

DROP TRIGGER IF EXISTS trg_reservations_updated_at ON reservations;
CREATE TRIGGER trg_reservations_updated_at
  BEFORE UPDATE ON reservations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON COLUMN reservations.booking_ref IS 'PMS-side booking identifier. Comes in on every webhook payload.';


-- ════════════════════════════════════════════════════════════════════
-- TABLE: conversations
-- A message thread grouped by guest + channel (+ stay).
-- One conversation per stay per channel is the intended model — a
-- guest can have separate WhatsApp and Airbnb threads for the same
-- reservation (intentional, channels are distinct surfaces).
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS conversations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guest_id        UUID NOT NULL
                  REFERENCES guests(id) ON DELETE RESTRICT,
  reservation_id  UUID
                  REFERENCES reservations(id) ON DELETE SET NULL,  -- nullable: pre-sales
  property_id     VARCHAR(100) NOT NULL
                  REFERENCES properties(id) ON DELETE RESTRICT,
  source_channel  VARCHAR(50) NOT NULL
                  CHECK (source_channel IN ('whatsapp', 'booking_com', 'airbnb', 'instagram', 'direct')),
  status          VARCHAR(50) NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open', 'resolved', 'escalated', 'closed')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversations_guest_id       ON conversations (guest_id);
CREATE INDEX IF NOT EXISTS idx_conversations_reservation_id ON conversations (reservation_id);
CREATE INDEX IF NOT EXISTS idx_conversations_property_id    ON conversations (property_id);
CREATE INDEX IF NOT EXISTS idx_conversations_status         ON conversations (status);

DROP TRIGGER IF EXISTS trg_conversations_updated_at ON conversations;
CREATE TRIGGER trg_conversations_updated_at
  BEFORE UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON COLUMN conversations.reservation_id IS 'Nullable — pre-sales enquiries arrive before any booking exists. Set later when the guest converts.';


-- ════════════════════════════════════════════════════════════════════
-- TABLE: messages
-- All inbound and outbound messages in one table.
-- AI metadata (classification + action) lives on the INBOUND row.
-- Edit history for AI-drafted OUTBOUND messages lives in ai_drafts.
--
-- Idempotency: (source_channel, external_message_id) is UNIQUE so
-- duplicate webhook deliveries from the same channel cannot create
-- duplicate rows.
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS messages (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id     UUID NOT NULL
                      REFERENCES conversations(id) ON DELETE CASCADE,
  guest_id            UUID NOT NULL
                      REFERENCES guests(id) ON DELETE RESTRICT,
  reservation_id      UUID
                      REFERENCES reservations(id) ON DELETE SET NULL,
  property_id         VARCHAR(100) NOT NULL
                      REFERENCES properties(id) ON DELETE RESTRICT,

  -- Channel + direction
  direction           VARCHAR(10) NOT NULL
                      CHECK (direction IN ('inbound', 'outbound')),
  source_channel      VARCHAR(50) NOT NULL
                      CHECK (source_channel IN ('whatsapp', 'booking_com', 'airbnb', 'instagram', 'direct')),

  -- Idempotency / replay
  external_message_id VARCHAR(255),          -- ID assigned by the source channel
  raw_payload         JSONB,                  -- original webhook body, for replay/debug
  received_at         TIMESTAMPTZ NOT NULL,   -- guest-send time from the payload (NOT row-insert time)

  -- Content
  raw_text            TEXT NOT NULL,
  normalized_text     TEXT,

  -- AI classification (populated for INBOUND messages)
  query_type          VARCHAR(50)
                      CHECK (query_type IS NULL OR query_type IN (
                        'pre_sales_availability',
                        'pre_sales_pricing',
                        'post_sales_checkin',
                        'special_request',
                        'general_enquiry',
                        'complaint'
                      )),
  ai_confidence_score NUMERIC(4, 3)
                      CHECK (ai_confidence_score IS NULL OR ai_confidence_score BETWEEN 0 AND 1),
  action_taken        VARCHAR(50)
                      CHECK (action_taken IS NULL OR action_taken IN (
                        'auto_send', 'agent_review', 'escalate'
                      )),

  -- AI drafting (populated for OUTBOUND messages — the final sent reply)
  ai_drafted          BOOLEAN NOT NULL DEFAULT FALSE,
  ai_model            VARCHAR(100),           -- e.g. 'claude-sonnet-4-20250514'
  agent_edited        BOOLEAN NOT NULL DEFAULT FALSE,
  auto_sent           BOOLEAN NOT NULL DEFAULT FALSE,

  -- Audit
  sent_at             TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- ── Consistency CHECKs ───────────────────────────────────────────
  -- Direction-specific invariants
  CONSTRAINT chk_inbound_no_send_flags CHECK (
    direction = 'outbound'
    OR (ai_drafted = FALSE AND agent_edited = FALSE AND auto_sent = FALSE AND sent_at IS NULL)
  ),
  -- If we say we auto-sent it, we must have a send timestamp
  CONSTRAINT chk_auto_sent_has_sent_at CHECK (
    auto_sent = FALSE OR sent_at IS NOT NULL
  ),
  -- If AI drafted, we must record which model produced it
  CONSTRAINT chk_ai_drafted_has_model CHECK (
    ai_drafted = FALSE OR ai_model IS NOT NULL
  )
);

-- Unique idempotency key (only when external_message_id is provided)
CREATE UNIQUE INDEX IF NOT EXISTS uniq_messages_external_id
  ON messages (source_channel, external_message_id)
  WHERE external_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages (conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_guest_id        ON messages (guest_id);
CREATE INDEX IF NOT EXISTS idx_messages_property_id     ON messages (property_id);
CREATE INDEX IF NOT EXISTS idx_messages_received_at     ON messages (received_at);
CREATE INDEX IF NOT EXISTS idx_messages_query_type      ON messages (query_type);
CREATE INDEX IF NOT EXISTS idx_messages_action_taken    ON messages (action_taken);
-- Composite index for the repeat-complaint detector from thinking.md
CREATE INDEX IF NOT EXISTS idx_messages_property_query  ON messages (property_id, query_type, received_at DESC);

COMMENT ON COLUMN messages.received_at IS 'Guest send-time from the webhook payload. Distinct from created_at (row insert time), which can lag.';
COMMENT ON COLUMN messages.raw_payload IS 'Original webhook body, stored for replay/debug. JSONB so we can query by channel-specific fields.';
COMMENT ON COLUMN messages.external_message_id IS 'ID assigned by the source channel (Twilio SID, Booking.com message ID, etc.). Combined with source_channel it is the idempotency key.';


-- ════════════════════════════════════════════════════════════════════
-- TABLE: ai_drafts
-- Full edit history for AI-drafted outbound messages.
-- Each row is one version: v1 = AI initial, v2..N = agent edits.
-- The CURRENT version is also denormalized onto messages.raw_text
-- for fast read. ai_drafts is the audit trail and training source.
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS ai_drafts (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id           UUID NOT NULL
                       REFERENCES messages(id) ON DELETE CASCADE,
  version              INTEGER NOT NULL CHECK (version >= 1),
  draft_text           TEXT NOT NULL,
  ai_model             VARCHAR(100),               -- NULL for agent edits
  ai_confidence_score  NUMERIC(4, 3)
                       CHECK (ai_confidence_score IS NULL OR ai_confidence_score BETWEEN 0 AND 1),
  query_type           VARCHAR(50),
  signals              JSONB,                       -- penalty_reasons, self_rating, etc.
  edited_by_agent_id   UUID REFERENCES agents(id),  -- NULL = system (AI initial)
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (message_id, version),

  -- Either AI produced it (model set) or an agent did (agent_id set)
  CONSTRAINT chk_draft_authorship CHECK (
    (ai_model IS NOT NULL AND edited_by_agent_id IS NULL)
    OR (ai_model IS NULL AND edited_by_agent_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_ai_drafts_message_id ON ai_drafts (message_id);

COMMENT ON TABLE ai_drafts IS 'Full edit history for AI-drafted outbound replies. v1 = AI initial, v2..N = subsequent agent edits.';
COMMENT ON COLUMN ai_drafts.signals IS 'Confidence signals at the time of draft — self_rating, penalty_reasons, keyword_match_count. JSONB for forward-compatibility.';


-- ════════════════════════════════════════════════════════════════════
-- Seed: villa-b1 so the running webhook has property context.
-- ════════════════════════════════════════════════════════════════════
INSERT INTO properties (id, name, context)
VALUES (
  'villa-b1',
  'Villa B1, Assagao, North Goa',
  'Property: Villa B1, Assagao, North Goa
Bedrooms: 3 | Max guests: 6 | Private pool: Yes
Check-in: 2:00 PM | Check-out: 11:00 AM
Base rate: INR 18,000 per night (up to 4 guests)
Extra guest charge: INR 2,000 per night per person
WiFi password: Nistula@2024
Caretaker: Available 8am to 10pm
Chef on call: Yes (pre-booking required)
Availability April 20–24: Available
Cancellation: Free cancellation up to 7 days before check-in'
)
ON CONFLICT (id) DO NOTHING;


-- ════════════════════════════════════════════════════════════════════
-- DESIGN NOTES
-- ════════════════════════════════════════════════════════════════════
--
-- 1. CHECK constraints over CREATE TYPE ENUM
--    Postgres ENUM types are rigid — adding a value requires ALTER TYPE
--    and can lock dependents. CHECK constraints with an IN list achieve
--    the same validation, are visible in `\d+`, and are trivial to
--    extend with a single ALTER TABLE. Trade-off: CHECK lists don't
--    deduplicate across tables (source_channel is repeated on
--    conversations and messages), but the explicitness is worth it.
--
-- 2. Soft delete + partial UNIQUE on guest contact info
--    `deleted_at IS NULL` gates the UNIQUE index. This lets us honour
--    GDPR right-to-erasure (set deleted_at, scrub PII columns) while
--    allowing the same person to register again later with the same
--    email. Without the partial filter, soft-delete + re-registration
--    is impossible.
--
-- 3. AI metadata split: classification on `messages`, drafts in `ai_drafts`
--    Classification (query_type, ai_confidence_score, action_taken)
--    belongs to the INBOUND message — it's a property of that message
--    and never changes. Drafts evolve (AI v1 → agent edit v2 → v3),
--    so they need their own versioned table. The CURRENT draft is
--    denormalized onto `messages.raw_text` for fast reads; `ai_drafts`
--    is the audit trail and the training data source for future model
--    improvements.
--
-- 4. ON DELETE policies
--    - properties / guests: RESTRICT — never silently drop history.
--      Use soft-delete instead.
--    - reservations → conversations.reservation_id: SET NULL — preserve
--      conversation history if a reservation is hard-deleted.
--    - conversations → messages: CASCADE — a deleted conversation has
--      no orphan messages.
--    - messages → ai_drafts: CASCADE — draft history is meaningless
--      without its parent message.
--
-- 5. Idempotency via (source_channel, external_message_id)
--    Webhook deliveries retry. Without a UNIQUE key on the channel-side
--    message ID, every retry creates a duplicate row and triggers a
--    duplicate Claude call. Partial UNIQUE (WHERE external_message_id
--    IS NOT NULL) handles the case where a channel doesn't supply one.
--
-- 6. Receive time vs row-insert time
--    `received_at` (from payload) ≠ `created_at` (row insert). Webhook
--    delivery can lag by minutes. Reporting and SLA timers must use
--    `received_at`. `created_at` is purely audit.
--
-- 7. updated_at triggers, not app-side discipline
--    A BEFORE-UPDATE trigger on every timestamped table guarantees
--    `updated_at` is correct even if the app forgets. Less surface area
--    for bugs than relying on every UPDATE statement to set it.
--
-- 8. Raw payload retention as JSONB
--    Storing the original webhook body costs a few KB per row and pays
--    for itself the first time a bug requires replaying production
--    traffic. JSONB lets us index/query channel-specific fields later
--    without a schema migration.
--
-- ════════════════════════════════════════════════════════════════════
-- HARDEST DESIGN DECISION
-- ════════════════════════════════════════════════════════════════════
--
-- Guest identity resolution across channels — and how it interacts
-- with GDPR right-to-erasure.
--
-- The same real person can message from WhatsApp (phone), Booking.com
-- (email + display name), Airbnb (email + nickname), and Instagram
-- (handle only) with no shared identifier. The brief says "one record
-- per guest" — a hard claim that no purely-declarative schema can
-- guarantee, because identity is fundamentally probabilistic when the
-- channels won't tell you who the person is.
--
-- The compromise: enforce uniqueness *where we can*, leave the rest
-- to the application layer.
--   • Partial UNIQUE on `LOWER(email) WHERE deleted_at IS NULL`
--     guarantees no two active rows share an email — case-insensitive,
--     case-normalised at insert.
--   • Partial UNIQUE on phone, same pattern.
--   • Where contact info is absent (Instagram handle only), the app
--     layer does fuzzy matching by name + recent reservation activity
--     and either reuses an existing row or creates a new one.
--   • An eventual identity-resolution pipeline can merge rows in the
--     background by writing to a `guest_merges` audit table and
--     repointing FKs — but it lives outside the DB layer, because
--     fuzzy matching is not the database's job.
--
-- The GDPR twist made this harder. A simple UNIQUE on email would
-- prevent a guest from being erased and then re-registering. Gating
-- the UNIQUE index on `deleted_at IS NULL` solves it cleanly: erased
-- rows don't participate in the uniqueness check, so the same email
-- can appear once as deleted_at IS NOT NULL and once as active.
--
-- Net: this schema enforces "one record per guest" exactly as strongly
-- as the available data permits, and is honest about the rest.
-- ════════════════════════════════════════════════════════════════════
