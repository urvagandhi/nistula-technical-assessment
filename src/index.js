const express = require('express');
const crypto = require('node:crypto');
const { generateMessageId } = require('./utils');
const { validateIncomingMessage } = require('./schemas');
const { classifyMessage, countKeywordMatches } = require('./classifier');
const { getDraftedReply, UnknownPropertyError } = require('./claudeClient');
const { calculateConfidence, determineAction } = require('./confidence');
const properties = require('./properties');
const config = require('./config');

// ── Structured logging ─────────────────────────────────────────────────
// One JSON object per line — grep/jq-friendly. info → stdout, error → stderr.
// A real deployment would swap this for pino; the shape stays the same.
function log(event) {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), level: 'info',  ...event }) + '\n');
}
function logErr(event) {
  process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), level: 'error', ...event }) + '\n');
}

const app = express();

// ── Request-ID + access logging ───────────────────────────────────────
// Mounted BEFORE express.json() so that body-parser errors (malformed
// JSON) still have req.requestId and the X-Request-Id response header.
// Honour an inbound X-Request-Id (chained services keep the same trace
// ID) or mint a fresh UUID. Echo it back on every response.
app.use((req, res, next) => {
  const requestId = req.header('x-request-id') || crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);

  const startedAt = Date.now();
  log({ event: 'request.start', requestId, method: req.method, path: req.path });

  res.on('finish', () => {
    log({
      event: 'request.finish',
      requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
    });
  });

  next();
});

app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.post('/webhook/message', async (req, res) => {
  const body = req.body;

  // 1. Validate
  const errors = validateIncomingMessage(body);
  if (errors.length > 0) {
    return res.status(400).json({ error: 'Validation failed', details: errors });
  }

  // 2. Reject unknown property_id up-front (no point calling Claude with no context)
  if (!properties.getById(body.property_id)) {
    return res.status(400).json({
      error: `Unknown property_id: ${body.property_id}`,
      details: [`known property_ids: ${properties.knownIds().join(', ')}`],
    });
  }

  // 3. Classify + normalise
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

  // 4. Single Claude call returns draft + self-rating
  let claudeResult;
  try {
    claudeResult = await getDraftedReply(normalizedMessage);
  } catch (err) {
    if (err instanceof UnknownPropertyError) {
      return res.status(400).json({ error: err.message });
    }
    logErr({
      event: 'claude.error',
      requestId: req.requestId,
      message_id: normalizedMessage.message_id,
      error: err.message,
      name: err.name,
    });
    return res.status(503).json({
      error: 'AI service temporarily unavailable. Please try again shortly.',
    });
  }
  const { draft, self_rating } = claudeResult;

  // 5. Compute confidence from real signals
  const matchCount = countKeywordMatches(body.message, queryType);
  const { score: confidence, reasons } = calculateConfidence({
    queryType,
    matchCount,
    messageText: body.message,
    selfRating: self_rating,
  });
  const action = determineAction(confidence, queryType);

  // 6. Respond — strict spec contract: exactly these 5 fields.
  return res.status(200).json({
    message_id:       normalizedMessage.message_id,
    query_type:       queryType,
    drafted_reply:    draft,
    confidence_score: confidence,
    action,
    // confidence_signals: {            // kept for future /debug endpoint, not in public contract
    //   keyword_match_count: matchCount,
    //   self_rating,
    //   penalty_reasons: reasons,
    // },
  });
});

// JSON 404 handler — last route in the chain, before error handlers.
// Express's default 404 returns HTML; this keeps the API surface JSON-only.
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', method: req.method, path: req.path });
});

// JSON body parse error (malformed JSON)
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    logErr({ event: 'request.bad_json', requestId: req.requestId, error: err.message });
    return res.status(400).json({ error: 'Invalid JSON body' });
  }
  return next(err);
});

// Catch-all error handler — never silently swallow.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  logErr({
    event: 'request.error',
    requestId: req.requestId,
    error: err.message,
    stack: err.stack,
  });
  res.status(500).json({ error: 'Internal server error' });
});

if (require.main === module) {
  app.listen(config.PORT, () => {
    log({ event: 'server.start', port: Number(config.PORT) });
  });
}

module.exports = app;
