const { callOpenAI, parseJsonResponse } = require('../config/openai');

// ── Regex detectors ───────────────────────────────────────────────────

const SUBJECT_KEYWORDS = {
  physics: [
    'physics', 'mechanics', 'kinematics', 'gravitation', 'thermodynamics',
    'electrostatics', 'magnetism', 'optics', 'waves', 'modern physics',
    'rotational', 'nuclear', 'semiconductor', 'current electricity',
    'oscillation', 'simple harmonic', 'fluid', 'heat transfer',
  ],
  chemistry: [
    'chemistry', 'organic', 'inorganic', 'physical chemistry',
    'chemical kinetics', 'kinetics', 'equilibrium', 'electrochemistry',
    'thermochem', 'atomic structure', 'periodic', 'coordination',
    'aldehyde', 'alkane', 'alkene', 'alkyne', 'sn1', 'sn2',
    'ionic equilibrium', 'mole concept', 'redox', 'solutions',
    'solid state', 'p-block', 'd-block', 'f-block', 'hydrocarbon',
  ],
  maths: [
    'maths', 'math', 'calculus', 'algebra', 'trigonometry', 'geometry',
    'integration', 'differentiation', 'probability', 'vectors', 'matrices',
    'complex numbers', 'coordinate geometry', '3d geometry', 'combinatorics',
    'permutation', 'combination', 'binomial', 'sequences', 'series',
    'limits', 'continuity', 'differential equation', 'conic section',
  ],
  biology: [
    'biology', 'botany', 'zoology', 'genetics', 'ecology', 'evolution',
    'cell biology', 'physiology', 'anatomy', 'reproduction', 'biotech',
    'photosynthesis', 'respiration', 'nervous system', 'endocrine',
  ],
};

const DISTRESS_KEYWORDS = new Set([
  'help', 'please', 'stuck', 'confused', 'weak', 'worst', 'bad', 'struggling',
  'struggle', 'doubt', "can't", 'cant', 'dont', "don't", 'unable', 'difficult',
  'hard', 'tough', 'lost', 'clueless', 'frustrated', 'tired', 'giving', 'up',
  'wrong', 'failed', 'failing', 'poor', 'terrible', 'awful', 'pathetic',
]);

const EVERYTHING_MARKERS = [
  'all thungs', 'all things', 'everything', 'all of it', 'all of them',
  'all parts', 'every part', 'every thing', 'everythng', 'everythin',
  'all topic', 'all topics', 'all chapter', 'all chapters',
];

const isGreetingOrSmalltalk = (text) => {
  const lowered = (text ?? '').trim().toLowerCase();
  if (!lowered) return false;

  const patterns = [
    /^(hi|hii+|hello|hey|heyy+|yo|sup|what'?s up|wassup)[!. ]*$/,
    /^(good\s+(morning|afternoon|evening|night))[!. ]*$/,
    /^(welcome|namaste|hola)[!. ]*$/,
  ];

  return patterns.some((p) => p.test(lowered));
};

const containsDistressSignal = (text) => {
  if (!text) return false;

  const words = text.toLowerCase().match(/\w+/g) ?? [];
  return words.some((w) => DISTRESS_KEYWORDS.has(w));
};

const containsEverythingMarker = (text) => {
  if (!text) return false;

  const lowered = text.toLowerCase();
  return EVERYTHING_MARKERS.some((m) => lowered.includes(m));
};

const detectSubjectRegex = (text) => {
  if (!text) return null;

  const lowered = text.toLowerCase();

  for (const [subject, kws] of Object.entries(SUBJECT_KEYWORDS)) {
    if (kws.some((kw) => lowered.includes(kw))) {
      return subject;
    }
  }

  return null;
};

// ── 1. Guardrail ──────────────────────────────────────────────────────

const GUARDRAIL_SYSTEM = `You filter a JEE/NEET academic assistant's inputs.
(Subjects: Physics, Chemistry, Maths, Biology.)

Output EXACTLY one JSON object: {"allowed": true/false, "reason": "brief"}

Rules:
- allowed=true : query mentions ANY academic topic, subject, or study/exam help,
                 EVEN WITH casual openers ("hey", "hi", personal intro).
- allowed=false: ONLY if purely off-topic (sports gossip, politics, adult content,
                 spam, abuse) with zero academic content.

Examples:
"hey i am facing issue in chemistry" → {"allowed": true, "reason": "academic"}
"hi help me with gravitation" → {"allowed": true, "reason": "academic"}
"who won the match yesterday" → {"allowed": false, "reason": "off-topic"}

Output JSON only. No markdown.`;

const ACADEMIC_REDIRECT_MSG =
  "I'm here to help with JEE/NEET doubts (Physics, Chemistry, Maths, Biology). " +
  "Could you tell me what you're working on?";

const GREETING_WELCOME_MSG =
  "Hey! 👋 I'm here to help with your JEE/NEET doubts. " +
  'Which subject or topic are you working on today — Physics, Chemistry, Maths, or Biology?';

const isPureGreeting = (query) => {
  if (!isGreetingOrSmalltalk(query)) return false;
  if (detectSubjectRegex(query)) return false;
  return true;
};

const guardrailCheck = async (query) => {
  console.log('guardrail check:', query);

  if (isGreetingOrSmalltalk(query)) {
    return [false, GREETING_WELCOME_MSG];
  }

  if (detectSubjectRegex(query)) {
    return [true, ''];
  }

  if (containsDistressSignal(query)) {
    return [true, ''];
  }

  try {
    const raw = await callOpenAI({
      system: GUARDRAIL_SYSTEM,
      user: `Query: ${query}`,
      temperature: 0.0,
      maxTokens: 60,
    });

    const result = parseJsonResponse(raw, {
      allowed: true,
      reason: 'parse error',
    });

    if (result.allowed === false) {
      return [false, ACADEMIC_REDIRECT_MSG];
    }

    return [true, ''];
  } catch (err) {
    console.error('guardrail LLM failed — failing open:', err);
    return [true, ''];
  }
};

// ── 2 & 3. Intent + Explanation ───────────────────────────────────────

const INTENT_SYSTEM = `Classify a JEE/NEET query as EXPLAIN or SEARCH.

EXPLAIN = user explicitly wants a definition/description.
  Triggers: "what is", "explain", "define", "describe", "tell me about",
            "how does X work", "theory of", "properties of".
SEARCH  = everything else. When in doubt, pick SEARCH.

Output JSON only: {"intent": "EXPLAIN"|"SEARCH", "concept": "..." or null}

Examples:
"Explain Newton's first law" → {"intent":"EXPLAIN","concept":"Newton's first law"}
"What is entropy" → {"intent":"EXPLAIN","concept":"entropy"}
"Help me with gravitation" → {"intent":"SEARCH","concept":null}
"I got 20 SN2 questions wrong" → {"intent":"SEARCH","concept":null}`;

const detectIntent = async (query) => {
  const raw = await callOpenAI({
    system: INTENT_SYSTEM,
    user: `Query: ${query}`,
    temperature: 0.0,
    maxTokens: 60,
  });

  const result = parseJsonResponse(raw, {
    intent: 'SEARCH',
    concept: null,
  });

  const intent = result.intent === 'EXPLAIN' ? 'EXPLAIN' : 'SEARCH';
  return [intent, result.concept ?? null];
};

const EXPLAIN_SYSTEM = `You are an expert JEE/NEET tutor.
Structure the answer as:
1. One-line definition
2. Key points / mechanism (3-5 bullets)
3. One worked example or application
4. One JEE/NEET exam tip

Keep under 300 words. Student-friendly plain text.`;

const explainConcept = async (query, _concept) => {
  return callOpenAI({
    system: EXPLAIN_SYSTEM,
    user: query,
    temperature: 0.3,
    maxTokens: 500,
  });
};

// ── 4. Vagueness Detector ─────────────────────────────────────────────

const VAGUENESS_SYSTEM = `Label JEE/NEET queries as VAGUE or SPECIFIC.

VAGUE    = only broad subject/feeling, no concrete concept.
SPECIFIC = names a real concept/topic/formula/reaction/theorem.

Output JSON only: {"vague": true/false, "subject": "..." or null, "reason": "..."}`;

const isVague = async (query) => {
  const raw = await callOpenAI({
    system: VAGUENESS_SYSTEM,
    user: `Query: ${query}`,
    temperature: 0.0,
    maxTokens: 80,
  });

  const result = parseJsonResponse(raw, {
    vague: false,
    subject: null,
  });

  return [Boolean(result.vague), result.subject ?? null];
};

// ── 5. Answer Guardrail ───────────────────────────────────────────────

const ANSWER_GUARDRAIL_SYSTEM = `You filter student answers during a JEE/NEET doubt session.
The student is REPLYING to a follow-up question from the mentor.

allowed=true for:
  - Any academic/study-related reply, however short, informal, misspelled, or emotional
  - Frustrated replies ("all worst please help", "i am stuck", "no idea", "all thungs")
  - Numeric/yes-no/one-word answers ("3 days ago", "yes", "formulas")
  - Vague answers ("idk", "everything", "all of it")

allowed=false ONLY for:
  - Pure abuse, slurs, sexual content
  - Blatant spam (URLs, promo codes, random gibberish)
  - Off-topic chatter (sports scores, movie gossip)

When unsure → allowed=true. A frustrated student is still a student.

Output JSON only: {"allowed": true/false, "reason": "..."}`;

const ABUSIVE_WORDS = new Set([
  'fuck', 'fuk', 'bitch', 'asshole', 'mc', 'bc', 'bhosdi', 'madarchod',
  'behenchod', 'chutiya', 'randi',
]);

const checkAnswerGuardrail = async (question, answer) => {
  if (!answer || !answer.trim()) {
    return [false, 'Empty answer. Please type something.'];
  }

  const lowered = answer.toLowerCase();

  if (Array.from(ABUSIVE_WORDS).some((w) => lowered.includes(w))) {
    return [false, ACADEMIC_REDIRECT_MSG];
  }

  if (containsDistressSignal(answer)) return [true, ''];
  if (detectSubjectRegex(answer)) return [true, ''];
  if (containsEverythingMarker(answer)) return [true, ''];

  const wordCount = answer.split(/\s+/).filter(Boolean).length;
  if (wordCount <= 5) return [true, ''];

  if (isGreetingOrSmalltalk(answer)) {
    return [false, ACADEMIC_REDIRECT_MSG];
  }

  try {
    const raw = await callOpenAI({
      system: ANSWER_GUARDRAIL_SYSTEM,
      user: `Question asked: ${question}\nStudent answer: ${answer}`,
      temperature: 0.0,
      maxTokens: 60,
    });

    const result = parseJsonResponse(raw, { allowed: true });

    if (result.allowed === false) {
      return [false, ACADEMIC_REDIRECT_MSG];
    }

    return [true, ''];
  } catch (err) {
    console.error('answer guardrail LLM failed — failing open:', err);
    return [true, ''];
  }
};

// ── 6. Unified follow-up turn engine ──────────────────────────────────

const SOFT_FOLLOWUP_TURNS = 3;
const HARD_FOLLOWUP_TURNS = 5;
const REQUIRED_SLOTS = ['subject', 'topic', 'struggle_area'];

const FALLBACK_QUESTIONS = {
  subject: 'Happy to help! Which subject are you working on — Physics, Chemistry, Maths, or Biology?',
  topic: 'Which specific chapter is giving you the most trouble right now? A concrete name helps me find the right material.',
  struggle_area: "Are you stuck because of problem solving, concept understanding, formula revision, or the difficulty level of the problems? For example, can you solve easy questions but not harder ones?",
  specific_subconcept: "Within this topic, what trips you up most? If you can name a specific sub-concept, I'll target the plan there.",
  freeze_point: "Last time you sat with this and got stuck — what were you trying to do, and where did your thinking trail off?",
  class_level: 'Quick check — are you in class 11, class 12, or a dropper this year?',
  exam_timeline: 'How far out is your main exam — a few weeks, a few months, or 6+ months?',
};

const UNIFIED_FOLLOWUP_SYSTEM = `You are a real human mentor doing a brief intake
with a JEE/NEET student. Talk like a tutor who actually cares — empathetic,
unhurried, in their language. Your job each turn is to MIRROR what they just
said, then ask ONE targeted follow-up question that earns deeper understanding.

IMPORTANT: ALWAYS generate a next_question on turns 1-3, even if basic slots 
(subject/topic/struggle_area) are filled. You must always dig deeper by asking:
- Are you stuck because of CONCEPT UNDERSTANDING, FORMULA REVISION, PROBLEM SOLVING, 
  or the DIFFICULTY LEVEL of the questions?
- What specific concepts confuse you most?
- Can you solve easy questions but struggle with harder ones?
- Have you tried practicing? What went wrong?
- What's your learning style — do you prefer theory-first or practice-first?

Return ONE JSON object with:
{
  "updated_slots": { subject, topic, struggle_area, specific_subconcept, class_level, 
                      exam_timeline, practice_signal, student_voice, pain_points },
  "decision": "ask_more" | "ready" | "blocked",
  "next_question": "your follow-up question or null",
  "next_focus": "specific_subconcept" | "class_level" | "exam_timeline" | "practice_signal" | null,
  "closing_note": "final message when ready" | null,
  "reasoning": "brief explanation of decision"
}

Slotting (IMPORTANT):
- Put each piece of information in the slot it semantically belongs to — NOT the
  slot you happened to ask about. If the student's answer doesn't match the
  question, fill whatever slot it actually fits and leave the asked slot null.
- specific_subconcept is ONLY a named topic/sub-chapter (e.g. "Entropy",
  "Friction", "Carnot Cycle"). A difficulty/level answer like "medium level
  problems", "I can't solve hard ones", or "easy questions are fine" is NOT a
  subconcept — leave specific_subconcept null and capture it in practice_signal.

Rules:
- On turn 1-2, ALWAYS set decision="ask_more" unless truly blocked
- Only set decision="ready" on turn 3+ or when student explicitly says they're ready
- Always provide a next_question unless decision is "ready" or "blocked"
- Closing note is ONLY shown when decision="ready"

Output JSON only.`;

const VALID_SUBJECTS = new Set(['physics', 'chemistry', 'maths', 'biology']);
const VALID_STRUGGLE_AREA = new Set(['theory', 'formulas', 'problem_solving', 'all']);
const VALID_CLASS_LEVELS = new Set(['11', '12', 'dropper']);

const emptySlots = () => ({
  subject: null,
  topic: null,
  struggle_area: null,
  pain_points: [],
  practice_signal: null,
  specific_subconcept: null,
  class_level: null,
  exam_timeline: null,
  student_voice: null,
});

const sanitiseCollected = (data) => {
  if (!data || typeof data !== 'object') return emptySlots();

  const d = data;

  const asTrim = (v) => {
    if (typeof v !== 'string') return null;
    const t = v.trim();
    return t.length > 0 ? t : null;
  };

  let subject = asTrim(d.subject)?.toLowerCase() ?? null;
  if (subject && !VALID_SUBJECTS.has(subject)) subject = null;

  let struggle = asTrim(d.struggle_area)?.toLowerCase() ?? null;
  if (struggle && !VALID_STRUGGLE_AREA.has(struggle)) struggle = null;

  const topic = asTrim(d.topic);

  // The student may answer the "specific subconcept" question with something
  // that isn't a topic at all — e.g. "medium level problems" describes problem
  // DIFFICULTY, not a named subconcept. Route such answers to practice_signal
  // and leave specific_subconcept null (so topic coverage stays whole-chapter).
  const looksLikeDifficultyPhrase = (s) => {
    if (!s) return false;
    const t = s.toLowerCase();
    const hasDifficulty = /\b(easy|medium|moderate|hard|tough|difficult|tricky)\b/.test(t);
    const aboutProblems = /\b(problem|problems|question|questions|level|levels|sums?|solv)/.test(t);
    return hasDifficulty && aboutProblems;
  };

  let subconcept = asTrim(d.specific_subconcept) ?? asTrim(d.subconcept);
  let practiceSignal = asTrim(d.practice_signal);

  if (subconcept && looksLikeDifficultyPhrase(subconcept)) {
    if (!practiceSignal) practiceSignal = subconcept;
    subconcept = null;
  }

  const rawClass = String(d.class_level ?? '').trim().toLowerCase();
  let classLevel = null;

  if (rawClass) {
    if (VALID_CLASS_LEVELS.has(rawClass)) classLevel = rawClass;
    else if (['11th', 'xi', 'eleventh'].includes(rawClass)) classLevel = '11';
    else if (['12th', 'xii', 'twelfth'].includes(rawClass)) classLevel = '12';
    else if (rawClass.includes('drop')) classLevel = 'dropper';
  }

  const ppRaw = Array.isArray(d.pain_points) ? d.pain_points : [];
  const painPoints = ppRaw
    .filter((p) => typeof p === 'string')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  return {
    subject,
    topic,
    struggle_area: struggle,
    pain_points: painPoints,
    practice_signal: practiceSignal,
    specific_subconcept: subconcept,
    class_level: classLevel,
    exam_timeline: asTrim(d.exam_timeline),
    student_voice: asTrim(d.student_voice),
  };
};

const runFollowupTurn = async (
  originalQuery,
  history,
  priorSignals = null,
  priorChapters = null,
) => {
  const hist = history ?? [];
  const askedFocuses = hist.map((t) => t.focus).filter(Boolean);

  const qaLines = [];

  hist.forEach((t, i) => {
    const focusTag = t.focus ? ` [focus: ${t.focus}]` : '';
    qaLines.push(`Turn ${i + 1}${focusTag}:`);
    qaLines.push(`  Mentor asked: ${t.q ?? ''}`);
    qaLines.push(`  Student replied: ${t.a ?? ''}`);
  });

  const turnsUsed = hist.length;

  let budgetMode;
  if (turnsUsed < SOFT_FOLLOWUP_TURNS) {
    budgetMode = 'comfortable';
  } else if (turnsUsed < HARD_FOLLOWUP_TURNS) {
    budgetMode = 'required-only';
  } else {
    budgetMode = 'must-finish';
  }

  const ctxParts = [
    `Original query: "${originalQuery}"`,
    '',
    'Follow-up history:',
    qaLines.length > 0 ? qaLines.join('\n') : '  (turn 1 — no follow-up yet)',
    '',
    `prior_signals: ${JSON.stringify(priorSignals ?? {})}`,
  ];

  if (askedFocuses.length > 0) {
    ctxParts.push(`asked_focuses: ${JSON.stringify(askedFocuses)}`);
  }

  if (priorChapters && priorChapters.length > 0) {
    ctxParts.push(`prior_chapters: ${JSON.stringify(priorChapters)}`);
  }

  ctxParts.push(
    `turns_used: ${turnsUsed} / soft_cap: ${SOFT_FOLLOWUP_TURNS} / hard_cap: ${HARD_FOLLOWUP_TURNS} / budget_mode: ${budgetMode}`,
  );

  let parsed = {};

  try {
    const raw = await callOpenAI({
      system: UNIFIED_FOLLOWUP_SYSTEM,
      user: ctxParts.join('\n'),
      temperature: 0.2,
      maxTokens: 600,
      responseFormat: { type: 'json_object' },
    });

    parsed = parseJsonResponse(raw, {});
    console.log('Follow-up LLM raw response:', JSON.stringify(parsed, null, 2));
  } catch (err) {
    console.error('unified follow-up LLM failed:', err);
  }

  const slots = sanitiseCollected(parsed.updated_slots ?? {});

  if (priorSignals) {
    for (const [k, v] of Object.entries(priorSignals)) {
      if (v && !slots[k]) {
        slots[k] = v;
      }
    }
  }

  let decision = String(parsed.decision ?? '').toLowerCase().trim();
  if (!['ready', 'ask_more', 'blocked'].includes(decision)) {
    decision = 'ask_more';
  }

  let nextQuestion = String(parsed.next_question ?? '').trim() || null;
  let nextFocus = String(parsed.next_focus ?? '').trim() || null;
  let closingNote = String(parsed.closing_note ?? '').trim() || null;
  let reasoning = String(parsed.reasoning ?? '').trim();

  const softHit = turnsUsed >= SOFT_FOLLOWUP_TURNS;
  const hardHit = turnsUsed >= HARD_FOLLOWUP_TURNS;
  const askedFocusSet = new Set(askedFocuses);

  const missingRequired = () => REQUIRED_SLOTS.filter((k) => !slots[k]);

  if (decision === 'ask_more' && hardHit) {
    decision = 'ready';
    nextQuestion = null;
    nextFocus = null;
  } else if (decision === 'ask_more' && softHit) {
    const missing = missingRequired();

    if (missing.length === 0) {
      decision = 'ready';
      nextQuestion = null;
      nextFocus = null;
      reasoning += ' | soft cap hit & required filled — finishing';
    } else if (!nextFocus || !REQUIRED_SLOTS.includes(nextFocus)) {
      const redirect = missing.find((s) => !askedFocusSet.has(s)) ?? missing[0];
      nextFocus = redirect;
      nextQuestion = FALLBACK_QUESTIONS[nextFocus] ?? 'Can you tell me a bit more?';
      reasoning += ` | soft cap hit; redirected to required slot '${redirect}'`;
    }
  }

  if (decision === 'ask_more' && nextFocus && askedFocusSet.has(nextFocus)) {
    const unaskedRequired = REQUIRED_SLOTS.filter(
      (k) => !slots[k] && !askedFocusSet.has(k),
    );

    if (unaskedRequired.length > 0 && !hardHit) {
      nextFocus = unaskedRequired[0];
      nextQuestion = FALLBACK_QUESTIONS[nextFocus] ?? 'Can you tell me a bit more?';
      reasoning += ` | redirected repeated focus to ${nextFocus}`;
    } else {
      decision = 'ready';
      nextFocus = null;
      nextQuestion = null;
      reasoning += ' | repeated focus detected, finishing instead';
    }
  }

  if (decision === 'ready') {
    const missing = missingRequired();

    if (missing.length > 0 && !hardHit) {
      decision = 'ask_more';
      nextFocus = nextFocus ?? missing[0];
      if (!nextQuestion) {
        nextQuestion = FALLBACK_QUESTIONS[nextFocus] ?? 'Can you tell me a bit more?';
      }
    }
  }

  if (decision !== 'ready') {
    closingNote = null;
  } else if (!closingNote) {
    closingNote =
      "Got it — your question has been sent to your mentor. Don't worry, " +
      "they'll review and send a plan back to you soon.";
  }

  console.log('Follow-up turn final result:', {
    turnsUsed,
    budgetMode,
    decision,
    nextQuestion,
    nextFocus,
    slots,
    reasoning,
  });

  return {
    slots,
    decision,
    next_question: nextQuestion,
    next_focus: nextFocus,
    closing_note: closingNote,
    reasoning,
  };
};

const getNextQuestionOrStop = async (
  originalQuery,
  history,
  priorSignals = null,
  priorChapters = null,
) => {
  const result = await runFollowupTurn(originalQuery, history, priorSignals, priorChapters);

  const enough = result.decision === 'ready';

  return {
    enough,
    nextQuestion: result.next_question,
    focus: enough ? 'done' : result.next_focus,
    collected: result.slots,
    closingNote: result.closing_note,
  };
};

// ── Pre-query signal extraction ───────────────────────────────────────

const PREQUERY_EXTRACT_SYSTEM = `You extract structured signals from a JEE/NEET
student's initial doubt query.

Output STRICT JSON with these fields:
{
  "subject": "physics" | "chemistry" | "maths" | "biology" | null,
  "topic": "chapter name in academic form" | null,
  "specific_subconcept": "sub-concept / sub-chapter the student named" | null,
  "struggle_area": "theory" | "formulas" | "problem_solving" | "all" | null,
  "class_level": "11" | "12" | "dropper" | null,
  "exam_timeline": "free-text" | null,
  "practice_signal": "free-text" | null,
  "student_voice": "student's own words" | null,
  "pain_points": ["specific struggle points"]
}

Use null for anything not stated. Do not guess.
Output JSON only.`;

const extractSignalsFromQuery = async (query) => {
  const q = (query ?? '').trim();
  if (!q) return emptySlots();

  try {
    const raw = await callOpenAI({
      system: PREQUERY_EXTRACT_SYSTEM,
      user: `Student initial query: "${q}"`,
      temperature: 0.0,
      maxTokens: 300,
      responseFormat: { type: 'json_object' },
    });

    return sanitiseCollected(parseJsonResponse(raw, {}));
  } catch (err) {
    console.error('pre-query extraction failed:', err);
    return emptySlots();
  }
};

// ── 7. Context-aware search expansion ─────────────────────────────────

const COMBINED_SEARCH_SYSTEM = `You build 3 FAISS search queries for a JEE/NEET index.

Inputs: the student's original query AND follow-up Q&A.

Produce EXACTLY 3 complementary variants:
- Variant 1: core concept + subject + chapter
- Variant 2: problem type + application
- Variant 3: related methods + techniques

Output JSON only: {"queries": ["v1", "v2", "v3"]}`;

const buildSearchQueries = async (original, history) => {
  const qaText = (history ?? [])
    .map((t) => `Q: ${t.q ?? ''}\nA: ${t.a ?? ''}`)
    .join('\n');

  const context = `Original query: "${original}"\n\nFollow-up Q&A:\n${qaText || '(none)'}`;

  try {
    const raw = await callOpenAI({
      system: COMBINED_SEARCH_SYSTEM,
      user: context,
      temperature: 0.3,
      maxTokens: 220,
    });

    const result = parseJsonResponse(raw, {
      queries: [original, original, original],
    });

    const queries = result.queries ?? [];

    if (queries.length !== 3) {
      return [original, original, original];
    }

    return queries.map((q) => q || original);
  } catch {
    return [original, original, original];
  }
};

// ── 8. Subject Detection ──────────────────────────────────────────────

const SUBJECT_SYSTEM = `Classify a JEE/NEET query into one subject.
Output JSON only: {"subject": "physics"|"chemistry"|"maths"|"biology"|null}
Return null if truly unclear.`;

const llmDetectSubjectFolder = async (topicText) => {
  if (!topicText || !topicText.trim()) return null;

  try {
    const raw = await callOpenAI({
      system: SUBJECT_SYSTEM,
      user: `Query: ${topicText}`,
      temperature: 0.0,
      maxTokens: 30,
    });

    const result = parseJsonResponse(raw, { subject: null });
    const subj = result.subject;

    if (subj && VALID_SUBJECTS.has(subj)) {
      return subj;
    }

    return null;
  } catch (err) {
    console.error('llmDetectSubjectFolder failed:', err);
    return null;
  }
};

const detectSubject = async (query) => {
  const subj = detectSubjectRegex(query);
  if (subj) return subj;

  return llmDetectSubjectFolder(query);
};

// ── 8b. Mentor add-concept classifier ─────────────────────────────────

const ALLOWED_DOST_TYPES = [
  'concept',
  'formula',
  'practiceAssignment',
  'practiceTest',
  'revision',
];

const CONCEPT_ADD_SYSTEM = `You parse a mentor's instruction to add a topic to a student's learning journey.

Output JSON ONLY:
{
  "subject": "physics" | "chemistry" | "maths" | "biology" | null,
  "dost_type": "concept" | "formula" | "practiceAssignment" | "practiceTest" | "revision" | null,
  "topic_query": "short topic phrase" | null
}`;

const llmClassifyConceptAdd = async (instruction) => {
  const out = {
    subject: null,
    dost_type: null,
    topic_query: null,
  };

  if (!instruction || !instruction.trim()) {
    return out;
  }

  try {
    const raw = await callOpenAI({
      system: CONCEPT_ADD_SYSTEM,
      user: `Instruction: ${instruction.trim()}`,
      temperature: 0.0,
      maxTokens: 120,
      responseFormat: { type: 'json_object' },
    });

    const result = parseJsonResponse(raw, {});

    if (result.subject && VALID_SUBJECTS.has(result.subject)) {
      out.subject = result.subject;
    }

    if (result.dost_type && ALLOWED_DOST_TYPES.includes(result.dost_type)) {
      out.dost_type = result.dost_type;
    }

    if (typeof result.topic_query === 'string' && result.topic_query.trim()) {
      out.topic_query = result.topic_query.trim();
    }
  } catch (err) {
    console.error('llmClassifyConceptAdd failed:', err);
  }

  return out;
};

// ── 10. Send-time scripts ─────────────────────────────────────────────

const SEND_SCRIPTS_SYSTEM = `You are a warm JEE/NEET mentor writing final motivational guidance.

Output STRICT JSON only:
{
  "main_script": "1-2 sentences tying the steps into a single plan",
  "dost_steps": [
    {"dost_type": "concept", "script": "Here is your Step 1: ..."}
  ]
}`;

const sumIntValues = (m) => {
  if (!m || typeof m !== 'object') return 0;

  let total = 0;

  for (const v of Object.values(m)) {
    total += Number(v ?? 0) || 0;
  }

  return total;
};

const summarizeDostForPrompt = (dost, idx) => {
  const p = dost.payload ?? {};
  const dostType = dost.dost_type ?? p.bulkRequestType ?? 'unknown';
  const title = String(p.title ?? dost.title ?? '').trim();
  const level = String(p.level ?? p.difficulty ?? '').trim();

  let qCountStr = '';

  if (dostType === 'practiceAssignment') {
    const qc = p.assignmentQuesCount ?? {};
    const total = sumIntValues(qc);

    const split = Object.entries(qc)
      .filter(([, v]) => Number(v ?? 0) > 0)
      .map(([k, v]) => `${v} ${k}`)
      .join(', ');

    if (total) {
      qCountStr = `${total} questions${split ? ` (${split})` : ''}`;
    }
  } else if (dostType === 'practiceTest') {
    const pp = p.paperPattern;

    if (pp && typeof pp === 'object') {
      const total = sumIntValues(pp);
      if (total) qCountStr = `${total} questions`;
    } else if (typeof pp === 'string' && pp) {
      qCountStr = `pattern: ${pp}`;
    }

    if (p.noOfMinutes) {
      qCountStr = `${qCountStr}${qCountStr ? ', ' : ''}${p.noOfMinutes} min`;
    }
  }

  const portion = p.practicePortion ?? p.formulaCart ?? p.conceptCart ?? [];
  const topicLines = [];

  for (const item of portion.slice(0, 5)) {
    const c = item.content ?? item;

    if (c && typeof c === 'object') {
      const chunk = [
        String(c.subject ?? '').trim(),
        String(c.chapter ?? '').trim(),
        String(c.concept ?? '').trim(),
        String(c.subConcept ?? c.subconcept ?? '').trim(),
      ]
        .filter(Boolean)
        .join(' > ');

      if (chunk) {
        topicLines.push(chunk);
      }
    }
  }

  if (portion.length > 5) {
    topicLines.push(`… and ${portion.length - 5} more`);
  }

  const parts = [
    `DOST ${idx + 1} — ${dostType}`,
    title ? `  Title: ${title}` : '',
    level ? `  Difficulty: ${level}` : '',
    qCountStr ? `  Volume: ${qCountStr}` : '',
  ].filter(Boolean);

  if (topicLines.length > 0) {
    parts.push('  Topics:');
    for (const tl of topicLines) {
      parts.push(`    - ${tl}`);
    }
  }

  return parts.join('\n');
};

const generateSendTimeScripts = async (
  profile,
  journeyType,
  materializedDosts,
) => {
  if (!materializedDosts || materializedDosts.length === 0) {
    return { main_script: '', dost_steps: [] };
  }

  const p = profile ?? {};

  const profileLines = [
    `  Subject: ${p.subject ?? 'unknown'}`,
    `  Topic: ${p.topic ?? 'unspecified'}`,
    `  Struggle area: ${p.struggle_area ?? 'unspecified'}`,
    `  Confidence: ${p.overall_confidence ?? 'unspecified'}`,
  ];

  if (p.days_to_exam) {
    profileLines.push(`  Days to exam: ${p.days_to_exam}`);
  }

  const userMsg = [
    'Student profile:',
    ...profileLines,
    '',
    `Journey type: ${journeyType}`,
    '',
    'Final journey:',
    '',
    ...materializedDosts.map((d, i) => `${summarizeDostForPrompt(d, i)}\n`),
  ].join('\n');

  let parsed = {};

  try {
    const raw = await callOpenAI({
      system: SEND_SCRIPTS_SYSTEM,
      user: userMsg,
      temperature: 0.4,
      maxTokens: 900,
      responseFormat: { type: 'json_object' },
    });

    parsed = parseJsonResponse(raw, {});
  } catch (err) {
    console.error('generateSendTimeScripts failed:', err);
    return { main_script: '', dost_steps: [] };
  }

  const mainScript = String(parsed.main_script ?? '').trim();
  const rawSteps = Array.isArray(parsed.dost_steps) ? parsed.dost_steps : [];

  const dostSteps = materializedDosts.map((dost, i) => {
    const step = rawSteps[i] ?? {};

    return {
      dost_type: String(dost.dost_type ?? step.dost_type ?? ''),
      script: String(step.script ?? '').trim(),
    };
  });

  return {
    main_script: mainScript,
    dost_steps: dostSteps,
  };
};

module.exports = {
  isPureGreeting,
  guardrailCheck,
  detectIntent,
  explainConcept,
  isVague,
  checkAnswerGuardrail,
  runFollowupTurn,
  getNextQuestionOrStop,
  extractSignalsFromQuery,
  buildSearchQueries,
  llmDetectSubjectFolder,
  detectSubject,
  ALLOWED_DOST_TYPES,
  llmClassifyConceptAdd,
  generateSendTimeScripts,
};