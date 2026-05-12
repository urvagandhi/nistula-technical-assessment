const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateIncomingMessage, LIMITS } = require('../src/schemas');

const valid = () => ({
  source: 'whatsapp',
  guest_name: 'Rahul Sharma',
  message: 'Is the villa available from April 20 to 24?',
  timestamp: '2026-05-05T10:30:00Z',
  booking_ref: 'NIS-2024-0891',
  property_id: 'villa-b1',
});

test('happy path passes with no errors', () => {
  assert.deepEqual(validateIncomingMessage(valid()), []);
});

test('missing body returns a clear error', () => {
  assert.ok(validateIncomingMessage(null).includes('request body must be a JSON object'));
  assert.ok(validateIncomingMessage(undefined).includes('request body must be a JSON object'));
  assert.ok(validateIncomingMessage([1, 2, 3]).includes('request body must be a JSON object'));
});

test('invalid source rejected', () => {
  const errs = validateIncomingMessage({ ...valid(), source: 'sms' });
  assert.ok(errs.some(e => e.startsWith('source must be one of')));
});

test('non-string guest_name rejected', () => {
  const errs = validateIncomingMessage({ ...valid(), guest_name: 12345 });
  assert.ok(errs.includes('guest_name must be a string'));
});

test('whitespace-only booking_ref rejected (not just empty/null)', () => {
  const errs = validateIncomingMessage({ ...valid(), booking_ref: '    ' });
  assert.ok(errs.includes('booking_ref is required'));
});

test('whitespace-only property_id rejected', () => {
  const errs = validateIncomingMessage({ ...valid(), property_id: '   ' });
  assert.ok(errs.includes('property_id is required'));
});

test('message length cap enforced', () => {
  const tooLong = 'a'.repeat(LIMITS.message + 1);
  const errs = validateIncomingMessage({ ...valid(), message: tooLong });
  assert.ok(errs.some(e => e.startsWith('message must be at most')));
});

test('timestamp: presence required', () => {
  const errs = validateIncomingMessage({ ...valid(), timestamp: '' });
  assert.ok(errs.includes('timestamp is required'));
});

test('timestamp: rejects "yesterday"', () => {
  const errs = validateIncomingMessage({ ...valid(), timestamp: 'yesterday' });
  assert.ok(errs.some(e => e.includes('valid ISO-8601')));
});

test('timestamp: rejects date-only (no time portion)', () => {
  const errs = validateIncomingMessage({ ...valid(), timestamp: '2026-05-05' });
  assert.ok(errs.some(e => e.includes('valid ISO-8601')));
});

test('timestamp: rejects shape-valid but impossible date (2026-13-99...)', () => {
  // Regex passes the shape; Date.parse must catch this.
  const errs = validateIncomingMessage({ ...valid(), timestamp: '2026-13-99T10:30:00Z' });
  assert.ok(errs.some(e => e.includes('valid ISO-8601')));
});

test('timestamp: accepts ISO with milliseconds and timezone offset', () => {
  const errs = validateIncomingMessage({ ...valid(), timestamp: '2026-05-05T10:30:00.123+05:30' });
  assert.deepEqual(errs, []);
});

test('timestamp: rejects non-string (number)', () => {
  const errs = validateIncomingMessage({ ...valid(), timestamp: 1715000000 });
  assert.ok(errs.some(e => e.includes('ISO-8601')));
});

test('all required fields missing → all errors listed', () => {
  const errs = validateIncomingMessage({});
  // 6 distinct error messages (source, guest_name, message, booking_ref, property_id, timestamp)
  assert.ok(errs.length >= 6, `expected ≥6 errors, got ${errs.length}: ${JSON.stringify(errs)}`);
});
