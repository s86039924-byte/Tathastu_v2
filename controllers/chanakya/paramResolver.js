const DIFFICULTY_BANDS = ['easy', 'moderate', 'hard'];
const { getParamSpecs } = require('./rag/paramConfig');
const masteryToBand = (mastery) => {
  if (mastery === null) return 'Red';
  if (mastery < 0.4) return 'Red';
  if (mastery < 0.7) return 'Yellow';
  return 'Green';
};

const isValidDifficulty = (value) => {
  if (typeof value !== 'string') return false;
  return DIFFICULTY_BANDS.includes(value.trim().toLowerCase());
};

const resolveDifficulty = (profile) => {
  const confidence = String(profile?.overall_confidence ?? 'medium')
    .trim()
    .toLowerCase();

  const base =
    confidence === 'low'
      ? 'easy'
      : confidence === 'high'
        ? 'hard'
        : 'moderate';

  const topics = profile?.topics ?? [];

  const masteries = topics
    .map((topic) => Number(topic.mastery ?? topic['mastery']))
    .filter((mastery) => Number.isFinite(mastery));

  if (masteries.length === 0) return base;

  const avg = masteries.reduce((sum, value) => sum + value, 0) / masteries.length;
  const idx = DIFFICULTY_BANDS.indexOf(base);

  if (avg < 0.3 && idx > 0) {
    return DIFFICULTY_BANDS[idx - 1];
  }

  if (avg > 0.75 && idx < DIFFICULTY_BANDS.length - 1) {
    return DIFFICULTY_BANDS[idx + 1];
  }

  return base;
};

const resolveIsNcert = (profile) => {
  const classLevel = String(profile?.class_level ?? '')
    .trim()
    .toLowerCase();

  if (classLevel === '11' || classLevel === '12' || classLevel === 'dropper') {
    return false;
  }

  if (classLevel && /^\d+$/.test(classLevel) && parseInt(classLevel, 10) <= 10) {
    return true;
  }

  return false;
};

const resolveDurationMinutes = (profile, fallback = 60) => {
  const value = profile?.session_minutes_target;

  let minutes = fallback;

  try {
    minutes =
      value === null || value === undefined
        ? fallback
        : parseInt(String(value), 10);

    if (!Number.isFinite(minutes)) {
      minutes = fallback;
    }
  } catch {
    minutes = fallback;
  }

  return Math.max(15, Math.min(180, minutes));
};

const resolveAllotedDay = (profile, fallback = 3) => {
  const value = profile?.days_to_exam;

  if (value === null || value === undefined) {
    return fallback;
  }

  const days = parseInt(String(value), 10);

  if (!Number.isFinite(days)) {
    return fallback;
  }

  const half = Math.floor(days / 2);

  return Math.max(1, Math.min(7, half || 1));
};

const buildConceptMasteryBandMap = (profile) => {
  const result = {};
  const topics = profile?.topics ?? [];

  for (const topic of topics) {
    const concept = String(topic.concept ?? topic['concept'] ?? '').trim();

    if (!concept) continue;

    const mastery = topic.mastery ?? topic['mastery'];

    const masteryValue =
      typeof mastery === 'number' && Number.isFinite(mastery)
        ? mastery
        : null;

    const newBand = masteryToBand(masteryValue);
    const existing = result[concept];

    if (existing === 'Red') continue;

    if (existing === 'Yellow' && newBand === 'Green') continue;

    result[concept] = newBand;
  }

  return result;
};

const resolveParamsFromProfile = (request, profile) => {
  if (!request || !profile) return request;

  const dostType = String(request.dost_type ?? request['dost_type'] ?? '').trim();

  if (
    dostType === 'practiceAssignment' &&
    (request.type_split === null || request.type_split === undefined)
  ) {
    request.type_split = getParamSpecs('practiceAssignment').defaults.type_split;
  }

  if (!isValidDifficulty(request.difficulty ?? request['difficulty'])) {
    request.difficulty = resolveDifficulty(profile);
  }

  if (request.isNCERT === null || request.isNCERT === undefined) {
    request.isNCERT = resolveIsNcert(profile);
  }

  if (
    dostType === 'practiceTest' &&
    (request.duration_minutes === null || request.duration_minutes === undefined)
  ) {
    request.duration_minutes = resolveDurationMinutes(profile);
  }

  if (dostType === 'revision') {
    if (
      request.daywiseTimePerPortion === null ||
      request.daywiseTimePerPortion === undefined
    ) {
      request.daywiseTimePerPortion = resolveDurationMinutes(profile);
    }

    if (request.allotedDay === null || request.allotedDay === undefined) {
      request.allotedDay = resolveAllotedDay(profile);
    }

    if (!('concept_mastery_band' in request)) {
      request.concept_mastery_band = buildConceptMasteryBandMap(profile);
    }
  }

  return request;
};

module.exports = {
  resolveParamsFromProfile,

  // Optional exports, useful for testing
  resolveDifficulty,
  resolveIsNcert,
  resolveDurationMinutes,
  resolveAllotedDay,
  buildConceptMasteryBandMap,
};
