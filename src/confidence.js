// Confidence scoring.
//
// Replaces the previous hardcoded `BASE_SCORES[queryType]` table. That table was a
// category prior, not a confidence score — it would return the same value for every
// pricing question regardless of whether Claude actually had the facts to answer it.
//
// Real confidence here = start from 1.0 and deduct on observable risk signals,
// each tied to something we can point at in the request, the draft, or Claude's
// own self-assessment of grounding. Every penalty below has a comment explaining
// what real-world failure mode it guards against.

const COMPLAINT_CAP = 0.55;

// Penalty weights. Tuned so the existing 3 spec payloads land in their expected
// action buckets, and so a complaint always escalates. Documented in README.
const W = {
  start:                     0.95,
  claude_not_grounded:       0.20, // Claude itself said it lacked facts → high risk of hallucination
  claude_hedged:             0.10, // "I'll check" / "let me confirm" → reply isn't actually answering
  per_missing_fact:          0.05, // each fact the guest asked for that wasn't in context
  missing_facts_max_penalty: 0.20, // cap stacking penalty so a 10-item list doesn't zero the score
  very_short_message:        0.10, // < 5 words → ambiguous ("Is it available?")
  multi_intent:              0.03, // ≥ 2 question marks → harder to answer cleanly in one reply
  zero_keyword_matches:      0.05, // classifier landed on fallback / weak signal
  one_keyword_match:         0.02, // single weak signal
  // (2+ keyword matches → no penalty, fully reinforced classification)
};

function calculateConfidence({ queryType, matchCount, messageText, selfRating }) {
  let score = W.start;
  const reasons = [];

  // ── Signals from Claude itself (the strongest signals — the model knows
  //    whether it had to make anything up)
  if (selfRating && selfRating.had_all_facts === false) {
    score -= W.claude_not_grounded;
    reasons.push('claude_not_grounded');
  }
  if (selfRating && selfRating.hedged === true) {
    score -= W.claude_hedged;
    reasons.push('claude_hedged');
  }
  const missingCount = (selfRating?.missing_facts ?? []).length;
  if (missingCount > 0) {
    const penalty = Math.min(missingCount * W.per_missing_fact, W.missing_facts_max_penalty);
    score -= penalty;
    reasons.push(`missing_facts:${missingCount}`);
  }

  // ── Signals from the guest message
  const wordCount = String(messageText).trim().split(/\s+/).filter(Boolean).length;
  if (wordCount < 5) {
    score -= W.very_short_message;
    reasons.push('very_short_message');
  }
  const questionMarks = (String(messageText).match(/\?/g) || []).length;
  if (questionMarks >= 2) {
    score -= W.multi_intent;
    reasons.push('multi_intent');
  }

  // ── Signal from the classifier (how strongly the buckets matched)
  if (matchCount === 0) {
    score -= W.zero_keyword_matches;
    reasons.push('zero_keyword_matches');
  } else if (matchCount === 1) {
    score -= W.one_keyword_match;
    reasons.push('one_keyword_match');
  }

  // ── Hard rule: complaints always cap at COMPLAINT_CAP so action routing
  //    sends them to escalate, regardless of how grounded Claude felt.
  if (queryType === 'complaint') {
    if (score > COMPLAINT_CAP) {
      reasons.push('complaint_cap');
    }
    score = Math.min(score, COMPLAINT_CAP);
  }

  // Clamp [0, 1] and round to 2 decimals
  const clamped = Math.min(1.0, Math.max(0.0, score));
  const final = parseFloat(clamped.toFixed(2));

  return { score: final, reasons };
}

function determineAction(confidence, queryType) {
  if (queryType === 'complaint') return 'escalate';
  if (confidence >= 0.85)        return 'auto_send';
  if (confidence >= 0.60)        return 'agent_review';
  return 'escalate';
}

module.exports = { calculateConfidence, determineAction, COMPLAINT_CAP, W };
