const VALID_SOURCES = ['whatsapp', 'booking_com', 'airbnb', 'instagram', 'direct'];

// App-level length caps. Sized for guest messages, not novels.
const LIMITS = {
  guest_name:  255,
  message:     4000,   // ~1k tokens at most — protects Claude cost + latency
  booking_ref: 100,
  property_id: 100,
};

// Strict ISO-8601 with timezone. Rejects "yesterday", "12345", "2026-05-05" (date-only).
// Allows: 2026-05-05T10:30:00Z, 2026-05-05T10:30:00.123Z, 2026-05-05T10:30:00+05:30
const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

function requireString(val, name, errors, { maxLength } = {}) {
  if (val === undefined || val === null) {
    errors.push(`${name} is required`);
    return;
  }
  if (typeof val !== 'string') {
    errors.push(`${name} must be a string`);
    return;
  }
  const trimmed = val.trim();
  if (trimmed.length === 0) {
    errors.push(`${name} is required`);
    return;
  }
  if (maxLength && trimmed.length > maxLength) {
    errors.push(`${name} must be at most ${maxLength} characters (got ${trimmed.length})`);
  }
}

function validateIncomingMessage(body) {
  const errors = [];

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    errors.push('request body must be a JSON object');
    return errors;
  }

  if (!body.source || !VALID_SOURCES.includes(body.source)) {
    errors.push(`source must be one of: ${VALID_SOURCES.join(', ')}`);
  }

  requireString(body.guest_name,  'guest_name',  errors, { maxLength: LIMITS.guest_name });
  requireString(body.message,     'message',     errors, { maxLength: LIMITS.message });
  requireString(body.booking_ref, 'booking_ref', errors, { maxLength: LIMITS.booking_ref });
  requireString(body.property_id, 'property_id', errors, { maxLength: LIMITS.property_id });

  // timestamp: must be ISO-8601 with timezone, and Date.parse must succeed
  // (regex rejects "12345" / "yesterday"; Date.parse rejects "2026-13-99T..." that satisfies the regex shape).
  if (body.timestamp === undefined || body.timestamp === null || body.timestamp === '') {
    errors.push('timestamp is required');
  } else if (typeof body.timestamp !== 'string') {
    errors.push('timestamp must be an ISO-8601 string');
  } else if (!ISO_8601_RE.test(body.timestamp) || Number.isNaN(Date.parse(body.timestamp))) {
    errors.push('timestamp must be a valid ISO-8601 string (e.g. 2026-05-05T10:30:00Z)');
  }

  return errors;
}

module.exports = { validateIncomingMessage, VALID_SOURCES, LIMITS };
