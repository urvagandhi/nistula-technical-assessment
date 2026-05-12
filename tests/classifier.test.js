const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classifyMessage, countKeywordMatches } = require('../src/classifier');

test('refund demand → complaint (priority over everything else)', () => {
  assert.equal(classifyMessage('The AC is not working and I want a refund.'), 'complaint');
});

test('"no hot water" → complaint (priority wins)', () => {
  assert.equal(classifyMessage('There is no hot water in the morning.'), 'complaint');
});

test('check-in + wifi → post_sales_checkin', () => {
  assert.equal(classifyMessage('What time can we check in? Can you share the wifi password?'), 'post_sales_checkin');
});

test('"chef" → special_request', () => {
  assert.equal(classifyMessage('Can we book a chef for dinner on the 22nd?'), 'special_request');
});

test('pricing keyword "rate" → pre_sales_pricing', () => {
  assert.equal(classifyMessage('What is the rate for 2 adults?'), 'pre_sales_pricing');
});

test('availability via "free on" + month + "nights"', () => {
  assert.equal(classifyMessage('Is the villa free on April 22 for 3 nights?'), 'pre_sales_availability');
});

test('unrelated text → general_enquiry fallback', () => {
  assert.equal(classifyMessage('Hi there!'), 'general_enquiry');
});

test('priority: pricing checked before availability — message with both → pricing', () => {
  const msg = 'Is the villa available from April 20 to 24? What is the rate for 2 adults?';
  assert.equal(classifyMessage(msg), 'pre_sales_pricing');
});

// ── Word-boundary regression tests ────────────────────────────────────────
test('word-boundary: "tomorrow" does NOT trigger availability via stray "to" substring', () => {
  // With substring matching this would have hit availability on "to" inside "tomorrow".
  // Word-boundary regex correctly treats "to" only as a standalone word.
  // After removing 'to'/'from' from availability keywords this also won't match.
  assert.equal(classifyMessage('Tomorrow we arrive at the property.'), 'general_enquiry');
});

test('word-boundary: "maybe" does NOT trigger availability via stray "may" substring', () => {
  assert.equal(classifyMessage('Maybe later we will visit.'), 'general_enquiry');
});

test('"I am from Delhi" does NOT trigger availability ("from" removed)', () => {
  // Previously "from" was a keyword and would substring-match here.
  assert.equal(classifyMessage('I am from Delhi, hello!'), 'general_enquiry');
});

test('case-insensitive matching still works', () => {
  assert.equal(classifyMessage('REFUND NOW'), 'complaint');
  assert.equal(classifyMessage('WiFi Password Please'), 'post_sales_checkin');
});

test('hyphenated keyword "check-in" matches as a phrase', () => {
  assert.equal(classifyMessage('When is check-in?'), 'post_sales_checkin');
});

test('countKeywordMatches returns the number of matching keywords for the bucket', () => {
  const msg = 'What time can we check in? Can you share the wifi password?';
  // "check in", "wifi", "wifi password" all match in post_sales_checkin
  const count = countKeywordMatches(msg, 'post_sales_checkin');
  assert.ok(count >= 2, `expected ≥2 matches, got ${count}`);
});

test('countKeywordMatches returns 0 for the fallback bucket', () => {
  assert.equal(countKeywordMatches('hello world', 'general_enquiry'), 0);
});
