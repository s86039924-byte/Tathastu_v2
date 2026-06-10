const { generateDostPayloads } = require('../controllers/chanakya/integration');

const JOURNEY_TYPES = ['revision', 'concept', 'practice'];

// Which journey best fits the student's struggle (for ranking).
const STRUGGLE_TO_FIT = {
  theory:          { revision: 0.2,  concept: 0.65, practice: 0.15 },
  formulas:        { revision: 0.4,  concept: 0.3,  practice: 0.3  },
  problem_solving: { revision: 0.2,  concept: 0.2,  practice: 0.6  },
  all:             { revision: 0.35, concept: 0.35, practice: 0.3  },
  '':              { revision: 0.33, concept: 0.33, practice: 0.34 },
};

const alignmentScore = (profile, type) => {
  const sa = String(profile?.struggle_area ?? '').toLowerCase().trim();
  const table = STRUGGLE_TO_FIT[sa] ?? STRUGGLE_TO_FIT[''];
  return Math.round((table[type] ?? 0.33) * 100) / 100;
};

// ── Adaptive rules driven by the profile ──────────────────────────────

// Weaker student → start lower and skip hard; stronger → stretch into hard.
const difficultyLadder = (confidence) => {
  if (confidence === 'low') return ['easy', 'moderate'];
  if (confidence === 'high') return ['moderate', 'hard'];
  return ['easy', 'moderate', 'hard']; // medium / unknown
};

// Weaker student → more questions; struggle area tilts the mix.
const assignmentCounts = (confidence, struggle) => {
  const base = {
    low:    { scq: 20, mcq: 10, integerQuestion: 10, passageQuestion: 0, matchQuestion: 0 },
    medium: { scq: 15, mcq: 10, integerQuestion: 10, passageQuestion: 0, matchQuestion: 0 },
    high:   { scq: 10, mcq: 5,  integerQuestion: 10, passageQuestion: 0, matchQuestion: 0 },
  }[confidence] ?? { scq: 15, mcq: 10, integerQuestion: 10, passageQuestion: 0, matchQuestion: 0 };

  const counts = { ...base };

  if (struggle === 'problem_solving') {
    counts.integerQuestion += 5; // numerical-heavy
  } else if (struggle === 'theory') {
    counts.scq += 5;
    counts.mcq += 5;
  }

  return counts;
};

// profile.topics → chapter_groups [{ subject, chapter, concepts, subconcepts }]
const buildChapterGroupsFromTopics = (topics) => {
  const map = new Map();

  for (const topic of topics ?? []) {
    const subject = String(topic.subject ?? '').trim();
    const chapter = String(topic.chapter ?? '').trim();

    if (!subject || !chapter) continue;

    const key = `${subject}|${chapter}`;

    if (!map.has(key)) {
      map.set(key, { subject, chapter, concepts: [], subconcepts: {} });
    }

    const group = map.get(key);
    const concept = String(topic.concept ?? '').trim();
    const subconcept = String(topic.subconcept ?? '').trim();

    if (concept && !group.concepts.includes(concept)) {
      group.concepts.push(concept);
    }

    if (concept && subconcept) {
      if (!group.subconcepts[concept]) group.subconcepts[concept] = [];
      if (!group.subconcepts[concept].includes(subconcept)) {
        group.subconcepts[concept].push(subconcept);
      }
    }
  }

  return [...map.values()];
};

// Build the adaptive DOST request list for one journey type.
const buildRequestsForJourney = (type, subject, chapterGroups, ladder, counts) => {
  const assignment = (difficulty) => ({
    dost_type: 'practiceAssignment',
    subject,
    difficulty,
    type_split: counts,
    chapter_groups: chapterGroups,
  });

  const test = (difficulty) => ({
    dost_type: 'practiceTest',
    subject,
    difficulty,
    chapter_groups: chapterGroups,
  });

  const formula = () => ({
    dost_type: 'formula',
    subject,
    chapter_groups: chapterGroups,
  });

  const concept = () => ({
    dost_type: 'concept',
    subject,
    chapter_groups: chapterGroups,
  });

  const revision = () => ({
    dost_type: 'revision',
    subject,
    chapter_groups: chapterGroups,
  });

  if (type === 'concept') {
    // clarity-first: understand → formulas → a gentle assignment
    return [concept(), formula(), assignment(ladder[0])];
  }

  if (type === 'revision') {
    // refresh: formulas → revision plan → a mid-level test
    const mid = ladder[Math.floor(ladder.length / 2)] ?? 'moderate';
    return [formula(), revision(), test(mid)];
  }

  // practice: an assignment at EVERY ladder rung + a test at the hardest rung
  const requests = ladder.map((difficulty) => assignment(difficulty));
  requests.push(test(ladder[ladder.length - 1]));
  return requests;
};

const toDosts = (payloads) =>
  (payloads ?? []).map((payload, index) => ({
    index,
    dost_type: payload.bulkRequestType ?? '',
    title: payload.title ?? `DOST ${index + 1}`,
    payload,
    original_payload: structuredClone(payload),
    script: '',
    status: 'draft',
    success: null, dost_id: null, link: null, error: null,
  }));

/**
 * Build 3 journey drafts from ONE profile, adaptively.
 * Same topics for all 3 (profile = source of truth); the component mix and
 * difficulty ladder per journey are derived from the student's confidence and
 * struggle area. No LLM call — fully deterministic.
 */
const generateThreeJourneys = async ({ profile, acadzaUserId = null }) => {
  const topics = profile?.topics ?? [];
  const chapterGroups = buildChapterGroupsFromTopics(topics);

  const confidence = String(profile?.overall_confidence ?? 'medium').toLowerCase().trim();
  const struggle = String(profile?.struggle_area ?? '').toLowerCase().trim();
  const subject = topics[0]?.subject ?? profile?.detected_subject ?? '';

  const ladder = difficultyLadder(confidence);
  const counts = assignmentCounts(confidence, struggle);

  const built = await Promise.all(
    JOURNEY_TYPES.map(async (type) => {
      try {
        const requestList = buildRequestsForJourney(type, subject, chapterGroups, ladder, counts);

        const payloads = await generateDostPayloads({
          requestList,
          profile,
          profileTopics: topics,
          acadzaUserId,
        });

        return {
          type,
          status: 'draft',
          alignment_score: alignmentScore(profile, type),
          dosts: toDosts(payloads),
        };
      } catch (err) {
        console.error(`[journeys] ${type} failed:`, err.message);
        return { type, status: 'draft', alignment_score: alignmentScore(profile, type), dosts: [], error: err.message };
      }
    }),
  );

  // rank: best-fit journey gets recommended_rank = 1
  const ranked = [...built].sort((a, b) => b.alignment_score - a.alignment_score);
  ranked.forEach((j, i) => { j.recommended_rank = i + 1; });

  return built;
};

module.exports = { generateThreeJourneys, JOURNEY_TYPES };
