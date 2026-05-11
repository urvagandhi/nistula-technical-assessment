const Anthropic = require('@anthropic-ai/sdk');
const config = require('./config');
const properties = require('./properties');

// Timeout: webhooks should not hang. 20s is well past Claude p99 for a 300-token
// reply, while still safe for caller-side timeouts (usually 30s).
// maxRetries: SDK retries 429/5xx/network errors once with backoff. One retry
// hides transient blips without amplifying real outages.
const client = new Anthropic({
  apiKey: config.ANTHROPIC_API_KEY,
  timeout: 20_000,
  maxRetries: 1,
});

const SYSTEM_PROMPT = `
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

You MUST submit your reply by calling the \`submit_reply\` tool. Along with the reply
text, you must report — truthfully — how grounded your reply is in the Property Context.
Your self-rating drives a downstream confidence score that decides whether the reply
auto-sends to the guest or routes to a human for review.
`.trim();

const SUBMIT_REPLY_TOOL = {
  name: 'submit_reply',
  description: 'Submit the drafted reply to the guest along with a self-assessment of how grounded the reply is in the Property Context.',
  input_schema: {
    type: 'object',
    properties: {
      reply_text: {
        type: 'string',
        description: 'The drafted reply to send to the guest. Address by first name. Warm, professional, concise.',
      },
      had_all_facts: {
        type: 'boolean',
        description: 'True if every claim in your reply is grounded in the Property Context provided. False if you had to hedge or speculate about any required fact.',
      },
      hedged: {
        type: 'boolean',
        description: 'True if your reply contains deferral language like "I will check with the team", "let me confirm", "I am not sure". False if you answered directly with concrete facts.',
      },
      missing_facts: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of specific facts the guest asked about that were NOT in the Property Context (e.g. "exact pool dimensions", "pet policy"). Empty array if you had everything you needed.',
      },
    },
    required: ['reply_text', 'had_all_facts', 'hedged', 'missing_facts'],
  },
};

class UnknownPropertyError extends Error {
  constructor(propertyId) {
    super(`Unknown property_id: ${propertyId}`);
    this.name = 'UnknownPropertyError';
    this.propertyId = propertyId;
  }
}

class ClaudeContractError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ClaudeContractError';
  }
}

// Defensive parse of the tool_use block. Anthropic's tool schema enforces
// required fields on its side, but we trust-but-verify so a malformed model
// response surfaces as a clear error rather than "undefined" reaching the guest.
function parseToolUse(toolUse) {
  const input = toolUse?.input ?? {};

  const { reply_text, had_all_facts, hedged, missing_facts } = input;

  if (typeof reply_text !== 'string' || reply_text.trim().length === 0) {
    throw new ClaudeContractError('submit_reply.reply_text missing or empty');
  }
  if (typeof had_all_facts !== 'boolean') {
    throw new ClaudeContractError('submit_reply.had_all_facts must be boolean');
  }
  if (typeof hedged !== 'boolean') {
    throw new ClaudeContractError('submit_reply.hedged must be boolean');
  }
  if (!Array.isArray(missing_facts) || !missing_facts.every(f => typeof f === 'string')) {
    throw new ClaudeContractError('submit_reply.missing_facts must be an array of strings');
  }

  return {
    draft: reply_text.trim(),
    self_rating: { had_all_facts, hedged, missing_facts },
  };
}

async function getDraftedReply(normalizedMessage) {
  const { guest_name, message_text, query_type, property_id } = normalizedMessage;

  const property = properties.getById(property_id);
  if (!property) throw new UnknownPropertyError(property_id);

  const userPrompt = `
Property Context (${property.name}):
${property.context}

Guest Name: ${guest_name}
Query Type: ${query_type}
Guest Message: ${message_text}

Draft a reply to this guest message and submit it via the submit_reply tool.
  `.trim();

  const response = await client.messages.create({
    model: config.MODEL,
    max_tokens: 600,
    system: SYSTEM_PROMPT,
    tools: [SUBMIT_REPLY_TOOL],
    tool_choice: { type: 'tool', name: SUBMIT_REPLY_TOOL.name },
    messages: [{ role: 'user', content: userPrompt }],
  });

  // Expect stop_reason = 'tool_use'. Anything else (max_tokens, refusal, end_turn)
  // means the model didn't complete the tool call cleanly.
  if (response.stop_reason !== 'tool_use') {
    throw new ClaudeContractError(
      `Claude did not complete the tool call (stop_reason=${response.stop_reason})`
    );
  }

  const toolUse = response.content.find(
    b => b.type === 'tool_use' && b.name === SUBMIT_REPLY_TOOL.name
  );
  if (!toolUse) {
    throw new ClaudeContractError('Claude response missing submit_reply tool call');
  }

  return parseToolUse(toolUse);
}

module.exports = { getDraftedReply, UnknownPropertyError, ClaudeContractError };
