const { callOpenAI, parseJsonResponse } = require('../../../config/openai');

const {
  ALLOWED_DOSTS,
  getParamSpecs,
  getAllowedDostTypes,
} = require('./paramConfig');

const JOURNEY_INTENT_SPECS = {
  revision: {
    headline: 'REVISION JOURNEY — refresh material the student has already studied',
    favor: ['revision', 'formula', 'practiceAssignment'],
    avoid: ['concept (heavy video explanations from scratch)'],
    tone: 'concise refresher; assume prior exposure; lean on quick formula/test recall.',
    difficulty_default: 'easy',
  },

  concept: {
    headline: 'CONCEPT-CLARITY JOURNEY — build understanding from first principles',
    favor: ['concept', 'formula', 'revision'],
    avoid: ['timed practiceTest as the primary tool'],
    tone:
      'explanatory, sequenced; teach the why before any practice; prerequisite ordering matters.',
    difficulty_default: 'easy',
  },

  practice: {
    headline: "PRACTICE / WORKOUT JOURNEY — apply and stress-test what's already understood",
    favor: ['practiceTest', 'practiceAssignment', 'clickingPower', 'pickingPower'],
    avoid: ['new concept videos'],
    tone:
      'drilling, application-focused; pick mid-mastery items; minimal theory.',
    difficulty_default: 'moderate',
  },
};

const buildProfileContext = (profile) => {
  if (!profile) return '';

  const confidence = String(profile.overall_confidence ?? 'medium');
  const isWeak = Boolean(profile.is_concept_weak);
  const painPoints = profile.pain_points ?? [];
  const needsVideo = Boolean(profile.needs_video);
  const needsFormula = Boolean(profile.needs_formula);
  const needsPractice = profile.needs_practice !== false;

  const insights = [];

  insights.push(`- Student confidence level: ${confidence.toUpperCase()}`);

  if (isWeak) {
    insights.push('- Student has weak understanding of concepts.');
  }

  if (painPoints.length > 0) {
    insights.push(`- Student struggles with: ${painPoints.slice(0, 3).join(', ')}`);
  }

  if (needsVideo) {
    insights.push('- Student needs video explanations, so concept DOST can be useful.');
  }

  if (needsFormula) {
    insights.push('- Student needs formula support, so formula DOST can be useful.');
  }

  if (needsPractice) {
    insights.push('- Student needs practice, so assignment/test DOST should be prioritized.');
  }

  return insights.join('\n');
};

const buildJourneyIntentBlock = (journeyIntent, ladderSpec) => {
  if (!journeyIntent) return '';

  const spec = JOURNEY_INTENT_SPECS[journeyIntent];

  if (!spec) return '';

  let ladderBlock = '';

  if (ladderSpec && ladderSpec.length > 0) {
    const rungs = ladderSpec.map((rung) => {
      const typeSplit = rung.type_split ?? rung['type_split'] ?? {};

      const typeSplitText = Object.entries(typeSplit)
        .filter(([, value]) => Number(value ?? 0) > 0)
        .map(([key, value]) => `${key}=${value}`)
        .join(', ');

      return (
        `  - practiceAssignment difficulty="${rung.difficulty}" ` +
        `count=${rung.count} type_split={${typeSplitText}}`
      );
    });

    ladderBlock =
      '\nDIFFICULTY LADDER:\n' +
      rungs.join('\n') +
      '\nGenerate exactly these practiceAssignment DOSTs, one per rung.\n' +
      'Use the same chapter_groups portion across all rungs.\n';
  }

  return `
JOURNEY INTENT:
${spec.headline}
- Favor DOST types: ${spec.favor.join(', ')}
- Avoid: ${spec.avoid.join(', ')}
- Tone: ${spec.tone}
- Difficulty default: ${spec.difficulty_default}
${ladderBlock}
`;
};

const generateRagPrompt = (
  query,
  chunks,
  profile,
  journeyIntent,
  ladderSpec,
) => {
  const chunkContext = (chunks ?? [])
    .map((chunk) => `- ${chunk.text ?? ''}`)
    .join('\n');

  const dostTypesText = Object.entries(ALLOWED_DOSTS)
    .map(([parent, subdosts]) => {
      return `- ${parent} → ${JSON.stringify(subdosts)}`;
    })
    .join('\n');

  const paramRules = getAllowedDostTypes()
    .map((dostType) => {
      const specs = getParamSpecs(dostType);

      return (
        `${dostType} → expected_fields: ${JSON.stringify(specs.expected_fields)} ` +
        `| defaults: ${JSON.stringify(specs.defaults)}`
      );
    })
    .join('\n');

  const profileContext = buildProfileContext(profile);

  const journeyBlock = buildJourneyIntentBlock(
    journeyIntent ?? null,
    ladderSpec,
  );

  return `
You are an academic backend agent for JEE/NEET and Class 11/12 boards.

Your job:
Generate strict JSON for downstream DOST payload generation.

STUDENT PROFILE INSIGHTS:
${profileContext || 'No profile data available.'}

${journeyBlock}

PROFILE-BASED RULES:
1. Low confidence → prefer easy difficulty.
2. Medium confidence → prefer moderate difficulty.
3. High confidence → prefer hard difficulty.
4. If weak concepts → include concept DOST where useful.
5. If needs_formula=true → include formula DOST where useful.
6. If needs_practice=true → prioritize assignment/test DOST.
7. Use retrieved chunks as the source of truth.
8. Every DOST request must be useful for the student's stated weakness, not generic.
9. For dost_type="practiceAssignment", ALWAYS include a type_split object with
   integer question counts:
   {
     "scq": n,
     "mcq": n,
     "integerQuestion": n,
     "passageQuestion": n,
     "matchQuestion": n
   }
   Total should be around 20–35 questions.
   Tailor it to the STUDENT QUERY and the student's pain points.
   - Numerical/problem-solving pain → more integerQuestion.
   - Conceptual confusion → more scq/mcq.
   - Easy difficulty → more scq/mcq.
   - Hard difficulty → more integerQuestion/passageQuestion.
   All values must be integers.

VERY IMPORTANT:
- Never invent chapter, concept, or subconcept names.
- Always use exact names from chunks.
- Do not rephrase names.
- Do not add extra fields.
- Every request must include dost_type, subject, and chapter_groups.
- If multiple subjects are mixed ambiguously, use subject: "Mixed".
- Formula DOST must be scoped to exactly one chapter.
- For multiple formula chapters, emit multiple formula entries.
- For vague queries, extract concepts/subconcepts from chunks when available.
- For practiceAssignment, type_split is mandatory.
- For practiceAssignment, never omit any key inside type_split.

ALLOWED DOST TYPES:
${dostTypesText}

FIELD RULES:
${paramRules}

CHUNKS STRUCTURE:
Each chunk text follows:
Subject > Chapter > Concept > Subconcept

Examples:

Full chapter:
{
  "chapter_groups": [
    { "subject": "Physics", "chapter": "Simple Harmonic Motion" }
  ]
}

Concept level:
{
  "chapter_groups": [
    {
      "subject": "Physics",
      "chapter": "Newton's Laws of Motion",
      "concepts": ["Friction"]
    }
  ]
}

Subconcept level:
{
  "chapter_groups": [
    {
      "subject": "Physics",
      "chapter": "Newton's Laws of Motion",
      "concepts": ["Friction"],
      "subconcepts": {
        "Friction": ["Pseudo Force"]
      }
    }
  ]
}

Practice assignment example:
{
  "requestList": [
    {
      "dost_type": "practiceAssignment",
      "subject": "Physics",
      "difficulty": "moderate",
      "type_split": {
        "scq": 12,
        "mcq": 8,
        "integerQuestion": 8,
        "passageQuestion": 2,
        "matchQuestion": 0
      },
      "chapter_groups": [
        {
          "subject": "Physics",
          "chapter": "Current Electricity",
          "concepts": ["Ohm's Law"]
        }
      ]
    }
  ],
  "reasoning": "Student needs moderate practice with extra numerical focus."
}

Return strict JSON only:
{
  "requestList": [...],
  "reasoning": "short backend reasoning"
}

Do not return markdown.
Do not return text outside JSON.

STUDENT QUERY:
${query}

RETRIEVED CHUNKS:
${chunkContext}
`;
};

const stripJsonFence = (content) => {
  let text = String(content ?? '').trim();

  if (text.includes('```json')) {
    text = text.split('```json')[1].split('```')[0].trim();
  } else if (text.includes('```')) {
    text = text.split('```')[1].split('```')[0].trim();
  }

  return text;
};

const normalizePracticeAssignmentTypeSplit = (request) => {
  if (!request || request.dost_type !== 'practiceAssignment') {
    return request;
  }

  const defaultSplit = {
    scq: 15,
    mcq: 10,
    integerQuestion: 5,
    passageQuestion: 0,
    matchQuestion: 0,
  };

  const typeSplit = request.type_split ?? request['type_split'] ?? {};

  request.type_split = {
    scq: Number.isInteger(typeSplit.scq) ? typeSplit.scq : defaultSplit.scq,
    mcq: Number.isInteger(typeSplit.mcq) ? typeSplit.mcq : defaultSplit.mcq,
    integerQuestion: Number.isInteger(typeSplit.integerQuestion)
      ? typeSplit.integerQuestion
      : defaultSplit.integerQuestion,
    passageQuestion: Number.isInteger(typeSplit.passageQuestion)
      ? typeSplit.passageQuestion
      : defaultSplit.passageQuestion,
    matchQuestion: Number.isInteger(typeSplit.matchQuestion)
      ? typeSplit.matchQuestion
      : defaultSplit.matchQuestion,
  };

  return request;
};

const normalizeRequestList = (requestList) => {
  if (!Array.isArray(requestList)) return [];

  return requestList.map((request) => {
    if (!request || typeof request !== 'object') return request;

    return normalizePracticeAssignmentTypeSplit(request);
  });
};

const getFinalPayloadFromGpt = async (
  query,
  chunks,
  profile,
  journeyIntent = null,
  ladderSpec = null,
) => {
  const prompt = generateRagPrompt(
    query,
    chunks,
    profile ?? null,
    journeyIntent ?? null,
    ladderSpec ?? null,
  );

  try {
    const raw = await callOpenAI({
      system:
        'You are a strict JSON generator. Return only valid JSON. No markdown.',
      user: prompt,
      temperature: 0,
      maxTokens: 1200,
    });

    const clean = stripJsonFence(raw);

    const parsed = parseJsonResponse(clean, {
      requestList: [],
      reasoning: '',
      error: 'JSON parse failed',
    });

    const requestList = normalizeRequestList(
      parsed.requestList ?? parsed['requestList'] ?? [],
    );

    return {
      requestList,
      reasoning: String(parsed.reasoning ?? parsed['reasoning'] ?? ''),
      ...(parsed.error ? { error: parsed.error } : {}),
    };
  } catch (err) {
    console.error('[chanakya rag] LLM call failed:', err.message);

    return {
      requestList: [],
      reasoning: '',
      error: err.message,
    };
  }
};

module.exports = {
  getFinalPayloadFromGpt,
  generateRagPrompt,
  normalizePracticeAssignmentTypeSplit,
  normalizeRequestList,
};