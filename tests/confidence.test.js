const { test } = require('node:test');
const assert = require('node:assert/strict');
const { calculateConfidence, determineAction, COMPLAINT_CAP } = require('../src/confidence');

const happy = {
  queryType: 'pre_sales_pricing',
  matchCount: 2,
  messageText: 'What is the rate for 2 adults for 4 nights?',
  selfRating: { had_all_facts: true, hedged: false, missing_facts: [] },
};

test('happy path → starts at 0.95, no penalties → auto_send', () => {
  const { score, reasons } = calculateConfidence(happy);
  assert.equal(score, 0.95);
  assert.deepEqual(reasons, []);
  assert.equal(determineAction(score, happy.queryType), 'auto_send');
});

test('claude_not_grounded penalty pushes into agent_review territory', () => {
  const { score, reasons } = calculateConfidence({
    ...happy,
    selfRating: { had_all_facts: false, hedged: false, missing_facts: [] },
  });
  assert.equal(score, 0.75); // 0.95 - 0.20
  assert.ok(reasons.includes('claude_not_grounded'));
  assert.equal(determineAction(score, happy.queryType), 'agent_review');
});

test('hedged-only penalty is -0.10', () => {
  const { score, reasons } = calculateConfidence({
    ...happy,
    selfRating: { had_all_facts: true, hedged: true, missing_facts: [] },
  });
  assert.equal(score, 0.85); // 0.95 - 0.10 → boundary auto_send
  assert.ok(reasons.includes('claude_hedged'));
});

test('per-missing-fact penalty stacks but is capped', () => {
  const tenMissing = Array.from({ length: 10 }, (_, i) => `fact_${i}`);
  const { score, reasons } = calculateConfidence({
    ...happy,
    selfRating: { had_all_facts: false, hedged: true, missing_facts: tenMissing },
  });
  // 0.95 - 0.20 (not grounded) - 0.10 (hedged) - 0.20 (capped) = 0.45 → escalate
  assert.equal(score, 0.45);
  assert.ok(reasons.includes('missing_facts:10'));
  assert.equal(determineAction(score, happy.queryType), 'escalate');
});

test('very-short-message penalty applies under 5 words', () => {
  const { score, reasons } = calculateConfidence({
    ...happy,
    messageText: 'Is it free?',
  });
  // 0.95 - 0.10 = 0.85 (the "?" count is 1, not multi_intent)
  assert.equal(score, 0.85);
  assert.ok(reasons.includes('very_short_message'));
});

test('multi-intent (2+ question marks) penalty applies', () => {
  const { score, reasons } = calculateConfidence({
    ...happy,
    messageText: 'Is it free? What is the rate? Can I bring 3 guests?',
  });
  // 0.95 - 0.03 = 0.92
  assert.equal(score, 0.92);
  assert.ok(reasons.includes('multi_intent'));
});

test('zero-keyword penalty applies when classifier landed on fallback', () => {
  const { score, reasons } = calculateConfidence({
    queryType: 'general_enquiry',
    matchCount: 0,
    messageText: 'Hello, hope you are well there.',
    selfRating: { had_all_facts: true, hedged: false, missing_facts: [] },
  });
  assert.equal(score, 0.90); // 0.95 - 0.05
  assert.ok(reasons.includes('zero_keyword_matches'));
});

test('one-keyword penalty is smaller than zero-keyword', () => {
  const oneMatch = calculateConfidence({ ...happy, matchCount: 1 });
  const twoMatch = calculateConfidence({ ...happy, matchCount: 2 });
  assert.ok(oneMatch.score < twoMatch.score, 'fewer matches should be less confident');
});

test('complaint always capped at COMPLAINT_CAP regardless of self-rating', () => {
  const { score, reasons } = calculateConfidence({
    queryType: 'complaint',
    matchCount: 3,
    messageText: 'The AC is not working and it is unacceptable. I want a refund.',
    selfRating: { had_all_facts: true, hedged: false, missing_facts: [] },
  });
  assert.equal(score, COMPLAINT_CAP);
  assert.ok(reasons.includes('complaint_cap'));
  assert.equal(determineAction(score, 'complaint'), 'escalate');
});

test('determineAction: complaint always escalates even with high confidence', () => {
  assert.equal(determineAction(0.99, 'complaint'), 'escalate');
});

test('determineAction thresholds', () => {
  assert.equal(determineAction(0.85, 'pre_sales_pricing'), 'auto_send');
  assert.equal(determineAction(0.84, 'pre_sales_pricing'), 'agent_review');
  assert.equal(determineAction(0.60, 'pre_sales_pricing'), 'agent_review');
  assert.equal(determineAction(0.59, 'pre_sales_pricing'), 'escalate');
});

test('score is clamped to [0, 1] and rounded to 2 decimals', () => {
  const { score } = calculateConfidence({
    queryType: 'general_enquiry',
    matchCount: 0,
    messageText: 'hi',
    selfRating: { had_all_facts: false, hedged: true, missing_facts: ['a','b','c','d','e','f','g','h'] },
  });
  assert.ok(score >= 0 && score <= 1);
  // Decimal places sanity
  assert.equal(String(score), String(parseFloat(score.toFixed(2))));
});
