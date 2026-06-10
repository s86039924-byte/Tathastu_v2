const { getChunk, getSubjectIndexes } = require('./vectorSearch');
const { llmDetectSubjectFolder } = require('./openaiPipeline');

// ── Runtime profile memory ────────────────────────────────────────────
// This resets when Node server restarts.

const runtimeStudentProfiles = new Map();
// key: studentId
// value: Array<profile>

// ── Constants ─────────────────────────────────────────────────────────

const MAX_FAISS_TOPICS = 8;
const MAX_EXPANDED_TOPICS = 50;
const DEFAULT_SESSION_MINUTES = 45;

// ── Mapping helpers ───────────────────────────────────────────────────

const deriveStruggleView = (struggleArea) => {
  const sa = (struggleArea ?? '').toLowerCase().trim();

  const isWeak = sa === 'theory' || sa === 'all';
  const needsVideo = sa === 'theory' || sa === 'all';
  const needsFormula = sa === 'formulas' || sa === 'all';
  const needsPractice = true;

  const preferredHelp =
    {
      theory: 'video',
      formulas: 'formula',
      problem_solving: 'practice',
      all: 'mixed',
    }[sa] ?? 'mixed';

  const tools = ['Study Material', 'Practice'];

  if (needsVideo) tools.push('Video');
  if (needsFormula) tools.push('Formula');
  if (isWeak) tools.push('Revision');

  return {
    is_concept_weak: isWeak,
    needs_video: needsVideo,
    needs_formula: needsFormula,
    needs_practice: needsPractice,
    preferred_help: preferredHelp,
    recommended_tools: tools,
  };
};

const inferConfidenceFromStruggle = (
  struggleArea,
  practiceSignal,
  painPoints,
) => {
  const sa = (struggleArea ?? '').toLowerCase().trim();
  const psLow = (practiceSignal ?? '').toLowerCase();

  let hardSignals = 0;

  if (['wrong', 'failed', 'incorrect'].some((w) => psLow.includes(w))) {
    hardSignals += 1;
  }

  if (sa === 'all') {
    hardSignals += 1;
  }

  if ((painPoints ?? []).length >= 3) {
    hardSignals += 1;
  }

  return hardSignals >= 2 ? 'low' : 'medium';
};

const inferPracticeNumbers = (practiceSignal) => {
  if (!practiceSignal) return [null, null];

  const nums = (practiceSignal.match(/\d+/g) ?? []).map((n) =>
    parseInt(n, 10),
  );

  const lowered = practiceSignal.toLowerCase();

  const hasWrongMarker = ['wrong', 'incorrect', 'failed'].some((w) =>
    lowered.includes(w),
  );

  if (nums.length >= 2) {
    const solved = nums[0];
    const wrong = Math.min(nums[1], solved);
    return [solved, wrong];
  }

  if (nums.length === 1) {
    const n = nums[0];
    return hasWrongMarker ? [n, n] : [n, null];
  }

  return [null, null];
};

// ── Exam timeline parser ──────────────────────────────────────────────

const parseDaysToExam = (examTimeline) => {
  if (!examTimeline) return null;

  const t = examTimeline.trim().toLowerCase();

  if (t.includes('today')) return 0;
  if (t.includes('tomorrow')) return 1;
  if (t.includes('next week')) return 7;
  if (t.includes('next month')) return 30;

  const numRe = /(\d+(?:\.\d+)?)/;

  let m = t.match(new RegExp(numRe.source + '\\s*day'));
  if (m) return Math.round(parseFloat(m[1]));

  m = t.match(new RegExp(numRe.source + '\\s*week'));
  if (m) return Math.round(parseFloat(m[1]) * 7);

  m = t.match(new RegExp(numRe.source + '\\s*month'));
  if (m) return Math.round(parseFloat(m[1]) * 30);

  return null;
};

const examUrgency = (daysToExam) => {
  if (daysToExam === null) return 'unknown';
  if (daysToExam <= 7) return 'high';
  if (daysToExam <= 30) return 'medium';
  return 'low';
};

// ── Personalization confidence ────────────────────────────────────────

const computePersonalizationConfidence = (args) => {
  const signalsPresent = [];
  const signalsMissing = [];

  let score = 0.0;

  if (args.struggleArea) {
    signalsPresent.push('struggle_area');
    score += 0.4;
  } else {
    signalsMissing.push('struggle_area');
  }

  if (args.painPoints && args.painPoints.length > 0) {
    signalsPresent.push('pain_points');
    score += 0.2;
  } else {
    signalsMissing.push('pain_points');
  }

  if (args.practiceSignal) {
    signalsPresent.push('practice_signal');
    score += 0.15;
  }

  const enrichmentCount = [
    args.specificSubconcept,
    args.classLevel,
    args.examTimeline,
    args.studentVoice,
  ].filter(Boolean).length;

  if (enrichmentCount >= 2) {
    signalsPresent.push('enrichment');
    score += 0.15;
  } else if (enrichmentCount === 1) {
    signalsPresent.push('enrichment_partial');
    score += 0.07;
  }

  if (args.repeatSession) {
    signalsPresent.push('repeat_session');
    score += 0.1;
  }

  score = Math.round(Math.min(1.0, score) * 100) / 100;

  let level;
  let warning = null;

  if (score >= 0.7) {
    level = 'high';
  } else if (score >= 0.4) {
    level = 'medium';
  } else {
    level = 'low';

    warning = args.struggleArea
      ? 'Profile is built on minimal follow-up data. Volume/difficulty are best-guess; mentor should adjust before sending.'
      : 'Profile has no struggle_area — every recommendation is a neutral default, not evidence-driven. Verify with the student before sending.';
  }

  return {
    level,
    score,
    signals_present: signalsPresent,
    signals_missing: signalsMissing,
    warning,
  };
};

// ── Runtime profile helpers ───────────────────────────────────────────

const saveRuntimeProfile = (studentId, profile) => {
  if (!studentId) return profile;

  if (!runtimeStudentProfiles.has(studentId)) {
    runtimeStudentProfiles.set(studentId, []);
  }

  const profiles = runtimeStudentProfiles.get(studentId);

  profiles.unshift(profile);

  runtimeStudentProfiles.set(studentId, profiles);

  return profile;
};

const getRuntimeProfilesForStudent = (studentId) => {
  if (!studentId) return [];
  return runtimeStudentProfiles.get(studentId) ?? [];
};

// ── FAISS → topics ────────────────────────────────────────────────────

const fullChapterTopics = async (subjectKey, chapter) => {
  if (!subjectKey || !chapter) return [];

  let indexes;

  try {
    indexes = (await getSubjectIndexes()) ?? {};
  } catch {
    return [];
  }

  const subjData = indexes[subjectKey.toLowerCase()];
  if (!subjData) return [];

  const topics = [];
  const seen = new Set();

  for (let row = 0; row < subjData.chunks.length; row++) {
    const chunk = subjData.chunks[row];

    if (chunk.chapter !== chapter && chunk['chapter'] !== chapter) continue;

    const key = `${chunk.chapter ?? chunk['chapter'] ?? ''}|${chunk.concept ?? chunk['concept'] ?? ''}|${chunk.subconcept ?? chunk['subconcept'] ?? ''}`;

    if (seen.has(key)) continue;

    seen.add(key);

    topics.push({
      subject: String(chunk.subject ?? chunk['subject'] ?? ''),
      chapter: String(chunk.chapter ?? chunk['chapter'] ?? ''),
      concept: String(chunk.concept ?? chunk['concept'] ?? ''),
      subconcept: String(chunk.subconcept ?? chunk['subconcept'] ?? ''),
      doc_id: `${subjectKey}||${row}`,
      relevance_score: 1.0,
    });

    if (topics.length >= MAX_EXPANDED_TOPICS) break;
  }

  return topics;
};

const extractTopicsFromFaiss = async (
  rankedResults,
  _struggleArea,
  specificSubconcept,
  topic,
) => {
  if (!rankedResults || rankedResults.length === 0) return [];

  const chapterCounts = new Map();
  const chapterKeyMap = new Map();
  const realNames = new Set(); // lowercased concept + subconcept names seen

  for (const [docId] of rankedResults) {
    const chunk = await getChunk(docId);
    if (!chunk) continue;

    const subjKey = docId.split('||')[0] ?? '';
    const chapter = String(chunk.chapter ?? chunk['chapter'] ?? '');

    if (chapter) {
      const key = `${subjKey}||${chapter}`;

      chapterCounts.set(key, (chapterCounts.get(key) ?? 0) + 1);

      if (!chapterKeyMap.has(key)) {
        chapterKeyMap.set(key, [subjKey, chapter]);
      }
    }

    const conceptName = String(chunk.concept ?? chunk['concept'] ?? '').trim().toLowerCase();
    const subName = String(chunk.subconcept ?? chunk['subconcept'] ?? '').trim().toLowerCase();
    if (conceptName) realNames.add(conceptName);
    if (subName) realNames.add(subName);
  }

  const topicClean = (topic ?? '').trim().toLowerCase();

  const sortedChapters = Array.from(chapterCounts.entries()).sort(
    (a, b) => b[1] - a[1],
  );

  const dominantChapter = sortedChapters[0]
    ? chapterKeyMap.get(sortedChapters[0][0])?.[1] ?? ''
    : '';

  const domClean = dominantChapter.trim().toLowerCase();

  const topicIsSubChapter =
    !!topicClean &&
    !!domClean &&
    !topicClean.includes(domClean) &&
    !domClean.includes(topicClean);

  // Default to WHOLE-CHAPTER coverage. Only narrow to specific topics when the
  // student actually named a real one — i.e. specific_subconcept matches an
  // actual concept/subconcept in the retrieved content. Difficulty phrases like
  // "medium level problems" (and "all"/"everything") match nothing → stay broad.
  const subRaw = (specificSubconcept ?? '').trim().toLowerCase();

  const subMatchesRealTopic =
    subRaw.length >= 4 &&
    !/^all\b/.test(subRaw) &&
    !/^every/.test(subRaw) &&
    Array.from(realNames).some(
      (name) =>
        name && (name === subRaw || name.includes(subRaw) || subRaw.includes(name)),
    );

  const subIsSpecific = subMatchesRealTopic;

  const broadPathEligible = !subIsSpecific && !topicIsSubChapter;

  if (broadPathEligible && sortedChapters.length > 0) {
    const first = sortedChapters[0];
    const keep = [first];

    const second = sortedChapters[1];

    if (second && second[1] >= Math.max(1, Math.floor(first[1] / 2))) {
      keep.push(second);
    }

    const expanded = [];

    for (const [key] of keep) {
      const pair = chapterKeyMap.get(key);

      if (!pair) continue;

      const [subjKey, chapter] = pair;

      expanded.push(...(await fullChapterTopics(subjKey, chapter)));
    }

    if (expanded.length > 0) {
      return expanded.slice(0, MAX_EXPANDED_TOPICS);
    }
  }

  const topics = [];
  const seen = new Set();

  for (const [docId, score] of rankedResults) {
    if (topics.length >= MAX_FAISS_TOPICS) break;

    const chunk = await getChunk(docId);
    if (!chunk) continue;

    const key = `${chunk.chapter ?? chunk['chapter'] ?? ''}|${chunk.concept ?? chunk['concept'] ?? ''}|${chunk.subconcept ?? chunk['subconcept'] ?? ''}`;

    if (seen.has(key)) continue;

    seen.add(key);

    topics.push({
      subject: String(chunk.subject ?? chunk['subject'] ?? ''),
      chapter: String(chunk.chapter ?? chunk['chapter'] ?? ''),
      concept: String(chunk.concept ?? chunk['concept'] ?? ''),
      subconcept: String(chunk.subconcept ?? chunk['subconcept'] ?? ''),
      doc_id: docId,
      relevance_score: Math.round(score * 10000) / 10000,
    });
  }

  return topics;
};

// ── Repeat detection using runtime profiles only ──────────────────────

const getPriorChaptersForSubject = async (studentId, subject) => {
  if (!subject) return [];

  const subj = subject.trim().toLowerCase();
  const previousProfiles = getRuntimeProfilesForStudent(studentId);

  const chapters = new Set();

  for (const prev of previousProfiles) {
    const topics = prev.topics ?? [];

    for (const t of topics) {
      if (String(t.subject ?? '').trim().toLowerCase() === subj) {
        const chapter = String(t.chapter ?? '').trim();

        if (chapter) {
          chapters.add(chapter);
        }
      }
    }
  }

  return Array.from(chapters).sort();
};

const detectRepeatSession = async (studentId, currentTopics) => {
  const previousProfiles = getRuntimeProfilesForStudent(studentId);

  if (previousProfiles.length === 0) {
    return {
      repeat_session: false,
      previous_session_ids: [],
      repeat_topics: [],
    };
  }

  const chapterKeys = (topics) => {
    const out = new Set();

    for (const t of topics ?? []) {
      const subject = String(t.subject ?? '').trim().toLowerCase();
      const chapter = String(t.chapter ?? '').trim().toLowerCase();

      if (subject && chapter) {
        out.add(`${subject}|${chapter}`);
      }
    }

    return out;
  };

  const currentKeys = chapterKeys(currentTopics);

  if (currentKeys.size === 0) {
    return {
      repeat_session: false,
      previous_session_ids: [],
      repeat_topics: [],
    };
  }

  const repeatSessionIds = [];
  const repeatChapters = new Set();

  for (const prev of previousProfiles) {
    const prevKeys = chapterKeys(prev.topics);

    for (const key of prevKeys) {
      if (currentKeys.has(key)) {
        const sid = String(prev.session_id ?? '');

        if (sid && !repeatSessionIds.includes(sid)) {
          repeatSessionIds.push(sid);
        }

        const parts = key.split('|');
        repeatChapters.add(`${parts[0]} > ${parts[1]}`);
      }
    }
  }

  return {
    repeat_session: repeatSessionIds.length > 0,
    previous_session_ids: repeatSessionIds,
    repeat_topics: Array.from(repeatChapters).sort(),
  };
};

// ── Main builder ──────────────────────────────────────────────────────

const nowLegacy = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');

  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
};

const buildStudentProfile = async (args) => {
  const cfd = args.collectedFollowupData ?? {};

  let subject = cfd.subject ?? null;
  const topic = cfd.topic ?? null;
  const struggleArea = cfd.struggle_area ?? null;
  const painPoints = (cfd.pain_points ?? []).slice();
  const practiceSignal = cfd.practice_signal ?? null;
  const specificSubconcept = cfd.specific_subconcept ?? null;
  const classLevel = cfd.class_level ?? null;
  const examTimeline = cfd.exam_timeline ?? null;
  const studentVoice = cfd.student_voice ?? null;

  if (!subject && topic) {
    try {
      const llmFolder = await llmDetectSubjectFolder(topic);
      const { resolveTopicToPortion } = require('../shared/topicResolver');

      const matches = await resolveTopicToPortion(topic, {
        topK: 1,
        minScore: 2.0,
        subjectFolder: llmFolder,
      });

      if (matches[0]?.subject) {
        subject = matches[0].subject;
      } else if (llmFolder) {
        subject = llmFolder;
      }
    } catch (err) {
      console.error('[profile_builder] topic resolver failed:', err.message);
    }
  }

  const view = deriveStruggleView(struggleArea);

  const confidence = inferConfidenceFromStruggle(
    struggleArea,
    practiceSignal,
    painPoints,
  );

  const [solved, wrong] = inferPracticeNumbers(practiceSignal);

  const daysToExamInt = parseDaysToExam(examTimeline);
  const urgency = examUrgency(daysToExamInt);

  const sessionMinutesTgt =
    cfd.session_minutes_target ?? DEFAULT_SESSION_MINUTES;

  let topics = await extractTopicsFromFaiss(
    args.rankedResults ?? [],
    struggleArea,
    specificSubconcept,
    topic,
  );

  const canonicalTopic = topics[0]?.chapter ?? topic;

  const repeatInfo = await detectRepeatSession(args.studentId, topics);

  const personalizationConfidence = computePersonalizationConfidence({
    struggleArea,
    painPoints,
    practiceSignal,
    specificSubconcept,
    classLevel,
    examTimeline,
    studentVoice,
    repeatSession: repeatInfo.repeat_session,
  });

  const profile = {
    student_id: args.studentId,
    session_id: args.sessionId ?? '',
    created_at: nowLegacy(),
    original_query: args.originalQuery,

    detected_subject: subject,
    detected_topic: canonicalTopic,
    struggle_area: struggleArea,
    specific_subconcept: specificSubconcept,
    class_level: classLevel,
    exam_timeline: examTimeline,
    student_voice: studentVoice,

    overall_confidence: confidence,
    ...view,
    pain_points: painPoints,

    days_to_exam: daysToExamInt,
    urgency,
    session_minutes_target: sessionMinutesTgt,

    questions_solved: solved,
    questions_wrong: wrong,

    conversation_history: args.conversationHistory ?? [],
    collected_followup_data: cfd,

    topics,

    repeat_session: repeatInfo.repeat_session,
    previous_session_ids: repeatInfo.previous_session_ids,
    repeat_topics: repeatInfo.repeat_topics,

    personalization_confidence: personalizationConfidence,
  };

  saveRuntimeProfile(args.studentId, profile);

  return profile;
};

module.exports = {
  deriveStruggleView,
  getPriorChaptersForSubject,
  buildStudentProfile,
  extractTopicsFromFaiss,

  // optional runtime helpers
  runtimeStudentProfiles,
  saveRuntimeProfile,
  getRuntimeProfilesForStudent,
};