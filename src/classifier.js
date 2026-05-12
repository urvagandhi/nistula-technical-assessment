// Rule-based classifier. Word-boundary matching (regex \b) on each keyword so a
// keyword like "to" doesn't match inside "tomorrow", and "may" doesn't match
// inside "maybe". Substring matching (the previous behaviour) was the source of
// quiet false positives in any message containing common stopwords.
//
// Stopword keywords like 'to' and 'from' have been removed from availability —
// even with word boundaries they fire on far too many non-availability messages
// ("I am from Delhi"). Month names, "available", "vacant", "book", "dates",
// "nights" carry the bucket.

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
    keywords: ['available', 'availability', 'vacant', 'book villa', 'book property', 'book stay', 'dates',
      'nights', 'january', 'february', 'march', 'april', 'may',
      'june', 'july', 'august', 'september', 'october',
      'november', 'december', 'free on'],
  },
  {
    type: 'general_enquiry',
    keywords: [], // fallback — always matches
  },
];

// Escape regex meta-chars and wrap each keyword in word-boundaries.
// Compiled once at module load.
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const COMPILED_RULES = RULES.map(rule => ({
  type: rule.type,
  patterns: rule.keywords.map(kw => new RegExp(`\\b${escapeRegex(kw)}\\b`, 'i')),
}));

function classifyMessage(text) {
  const str = String(text).normalize('NFKC');

  for (const rule of COMPILED_RULES) {
    if (rule.patterns.length === 0) return rule.type; // fallback
    if (rule.patterns.some(re => re.test(str))) return rule.type;
  }

  return 'general_enquiry';
}

// Returns how many distinct keywords matched — used by confidence scorer.
function countKeywordMatches(text, queryType) {
  const rule = COMPILED_RULES.find(r => r.type === queryType);
  if (!rule || rule.patterns.length === 0) return 0;
  const str = String(text).normalize('NFKC');
  return rule.patterns.filter(re => re.test(str)).length;
}

module.exports = { classifyMessage, countKeywordMatches, RULES };
