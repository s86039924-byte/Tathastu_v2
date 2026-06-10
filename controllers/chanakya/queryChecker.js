const { getOpenAI } = require('../../config/openai');

const MODEL = 'gpt-4o-mini';

const buildSystemInstructions = (inputType) => `
You are ACADZA's SuperDOST query classifier.

• Input Type: ${inputType}
  - If "image", the text may include diagram descriptions, raw labels, and LaTeX equations. Extract all details precisely.
  - VERY IMPORTANT: If Input Type is "image" AND the user's context contains no explicit request for assignment/test/formula/revision/practice etc., then you MUST set "mode":"general" and skip any DOST logic.
  - If mode is "dost" or "mixed", enrich the \`translated\` field for vague queries by specifying the exact DOST type and ALL relevant chapters from the syllabus.

• Harmful-Content Check: if any violence, abuse, or sexual content is detected, stop and return ONLY:
  { "mode": "error", "error": "Harmful content detected" }

• Translation: if translate_if_dost_or_mixed=True AND you classify mode as "dost" or "mixed", include:
  "translated": <English version of the original text, enriched with DOST type and ALL chapters>

• Math: use \\(...\\) or \\[...\\] for inline or block LaTeX.

Available block types in your structured_answer:
  - heading, subheading, paragraph, bold, bullet, number, latex, table, callout, definition, quote, code
  - For latex always emit { "latex": "<LaTeX string>" }

Only return valid JSON matching:
{
  "mode": "general"|"dost"|"mixed"|"error",
  "error"?: "Harmful content detected",
  "structured_answer"?: [ ...blocks... ],
  "translated"?: "English text"
}
`;

const buildQueryInstructions = (text) => `
You must:

1. Carefully analyze the STUDENT QUERY.

2. Detect if the query directly or indirectly indicates a need for DOST resources:
   - Assignment, Test, Formula Sheet, Revision Plan, Speed Practice, Concept Basket.
   - Phrases like "help me study", "I want to revise", "give me practice", "give assignment", "teach me" trigger DOST needs.

3. Detect if the query needs only general explanation or DOST resources.

4. Cases:
   - Only DOSTs → { "mode": "dost" }
   - Only general explanation → { "mode": "general", "structured_answer": [ ... ] }
   - Both explanation + DOSTs → { "mode": "mixed", "structured_answer": [ ... ] }

5. If query mentions what/why/how/define/explain/summarize AND assignment/test/formula/revision → Mixed.

6. Assume JEE/NEET or Class 11/12 Board Exams, NCERT.

ONLY return valid JSON. No text outside JSON.

=== STUDENT QUERY ===
${text}
`;

const normalizeBackslashes = (s) => {
  return s.replace(/(\\+)([^"\\/bfnrtu])/g, (_m, slashes, ch) => {
    const keep = Math.floor(slashes.length / 2) * 2;
    return '\\'.repeat(keep) + ch;
  });
};

const stripJsonFence = (content) => {
  let out = String(content ?? '').trim();

  if (out.includes('```json')) {
    out = out.split('```json')[1].split('```')[0].trim();
  } else if (out.includes('```')) {
    out = out.split('```')[1].split('```')[0].trim();
  }

  return out;
};

const fallbackGeneralResponse = () => ({
  mode: 'general',
  structured_answer: [
    {
      type: 'paragraph',
      content:
        "Sorry, we couldn't process your query due to an internal error. Please try again.",
    },
  ],
});

const queryChecker = async (text, opts = {}) => {
  const inputType = opts.inputType ?? 'text';

  const messages = [
    {
      role: 'system',
      content: buildSystemInstructions(inputType),
    },
    {
      role: 'user',
      content: buildQueryInstructions(text),
    },
  ];

  let content = '';

  try {
    const resp = await getOpenAI().chat.completions.create({
      model: MODEL,
      messages,
      temperature: 0,
    });

    content = stripJsonFence(resp.choices[0]?.message?.content ?? '');
  } catch (err) {
    console.error('[query_checker] LLM call failed:', err.message);
    return fallbackGeneralResponse();
  }

  try {
    return JSON.parse(content);
  } catch {
    try {
      return JSON.parse(normalizeBackslashes(content));
    } catch (err) {
      console.error('[query_checker] JSON parse failed:', err.message);
      return fallbackGeneralResponse();
    }
  }
};

module.exports = {
  queryChecker,
};