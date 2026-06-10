const { randomUUID } = require('node:crypto');
const { getSubjectIndexes } = require('../vectorSearch');

const {
  buildPracticePortion,
  buildPracticePortionFromProfile,
} = require('./utils');

const DIFFICULTY_NORMALIZE = {
  easy: 'EASY',
  moderate: 'MODERATE',
  medium: 'MODERATE',
  med: 'MODERATE',
  hard: 'HARD',
  tough: 'HARD',
};

const normalizeDifficulty = (value, fallback = 'EASY') => {
  const key = String(value ?? '').trim().toLowerCase();
  return DIFFICULTY_NORMALIZE[key] ?? fallback;
};

const uniqueChapterTitle = (groups, suffix) => {
  const seen = new Set();
  const ordered = [];

  for (const group of groups ?? []) {
    const chapter = group.chapter ?? '';

    if (chapter && !seen.has(chapter)) {
      seen.add(chapter);
      ordered.push(chapter);
    }
  }

  const title = ordered.length > 0 ? ordered.join(' + ') : 'Selected Chapters';

  return `${title} ${suffix}`;
};

const DEFAULT_QUES_COUNT = {
  scq: 10,
  mcq: 10,
  integerQuestion: 0,
  passageQuestion: 0,
  matchQuestion: 0,
};

const buildAssignment = async (
  _subject,
  chapterGroups,
  params,
  studentId,
  profileTopics,
) => {
  const title = uniqueChapterTitle(chapterGroups, 'Assignment');

  const portion = profileTopics
    ? buildPracticePortionFromProfile(profileTopics)
    : await buildPracticePortion(chapterGroups);

  return {
    bulkRequestType: 'practiceAssignment',
    userId: studentId,
    practiceType: 'assignment',
    title,
    isNCERT: params.isNCERT ?? params['isNCERT'],
    level: normalizeDifficulty(params.difficulty ?? params['difficulty']),
    assignmentQuesCount:
      params.type_split ??
      params['type_split'] ??
      DEFAULT_QUES_COUNT,
    practicePortion: portion,
  };
};

const buildTest = async (
  _subject,
  chapterGroups,
  params,
  studentId,
  profileTopics,
) => {
  const title = uniqueChapterTitle(chapterGroups, 'Test');

  const portion = profileTopics
    ? buildPracticePortionFromProfile(profileTopics)
    : await buildPracticePortion(chapterGroups);

  return {
    bulkRequestType: 'practiceTest',
    userId: studentId,
    practiceType: 'test',
    title,
    paperPattern: params.paperPattern ?? params['paperPattern'] ?? 'Mains',
    level: normalizeDifficulty(params.difficulty ?? params['difficulty']),
    natureOfTest: 'Random',
    noOfMinutes: params.duration_minutes ?? params['duration_minutes'] ?? 60,
    coachingView: 'PACE',
    batchs: [],
    sectionOrder: [
      'singleQuestions',
      'multipleQuestions',
      'integerQuestions',
      'passageQuestions',
      'matchQuestions',
    ],
    passageQuestionLimit: 3,
    isNCERT: params.isNCERT ?? params['isNCERT'],
    helpRequired: false,
    isMultiple: false,
    practicePortion: portion,
  };
};

const fullChapterConcepts = async (subject, chapter) => {
  if (!subject || !chapter) return null;

  let indexes;

  try {
    indexes = await getSubjectIndexes();
  } catch {
    return null;
  }

  const subj = indexes[subject.toLowerCase()];

  if (!subj) return null;

  const concepts = [];
  const subconcepts = {};
  const seen = new Set();

  for (const chunk of subj.chunks ?? []) {
    if ((chunk.chapter ?? chunk['chapter']) !== chapter) continue;

    const concept = String(chunk.concept ?? chunk['concept'] ?? '');
    const subconcept = String(chunk.subconcept ?? chunk['subconcept'] ?? '');

    if (concept && !seen.has(concept)) {
      concepts.push(concept);
      seen.add(concept);
    }

    if (concept && subconcept) {
      if (!subconcepts[concept]) {
        subconcepts[concept] = [];
      }

      if (!subconcepts[concept].includes(subconcept)) {
        subconcepts[concept].push(subconcept);
      }
    }
  }

  if (concepts.length === 0) return null;

  return {
    concepts,
    subconcepts,
  };
};

const buildFormula = async (
  subject,
  chapterGroups,
  studentId,
) => {
  if (!chapterGroups || chapterGroups.length === 0) {
    return null;
  }

  const payloads = [];

  for (const group of chapterGroups) {
    const chapter = group.chapter ?? '';
    const groupSubject = group.subject ?? subject;
    const requestedConcepts = group.concepts ?? [];
    const requestedSubs = group.subconcepts ?? {};

    // index = source of truth for this chapter (validates names + supplies subconcepts)
    const full = await fullChapterConcepts(groupSubject, chapter);
    const indexConcepts = full?.concepts ?? [];
    const indexSubs = full?.subconcepts ?? {};

    let concepts;
    let subconcepts;
    let scoped = false;

    if (requestedConcepts.length > 0) {
      // SCOPED: keep only the requested concepts that actually exist in the index
      concepts = full
        ? requestedConcepts.filter((c) => indexConcepts.includes(c))
        : requestedConcepts;

      subconcepts = {};
      for (const c of concepts) {
        // prefer the requested subconcepts (validated against the index);
        // if none were named for this concept, include all of its index subconcepts
        const reqForC = (requestedSubs[c] ?? []).filter(
          (s) => !indexSubs[c] || indexSubs[c].includes(s),
        );
        subconcepts[c] = reqForC.length ? reqForC : (indexSubs[c] ?? requestedSubs[c] ?? []);
      }

      scoped = concepts.length > 0;

      // nothing matched the index → fall back to the whole chapter
      if (concepts.length === 0 && full) {
        concepts = indexConcepts;
        subconcepts = indexSubs;
      }
    } else {
      // BROAD: no concept named → whole chapter
      concepts = full ? indexConcepts : [];
      subconcepts = full ? indexSubs : {};
    }

    const cart = [];

    for (const concept of concepts) {
      const subs = subconcepts[concept] ?? [];

      if (subs.length === 0) {
        cart.push({
          id: randomUUID(),
          content: {
            subject: groupSubject,
            chapter,
            concept,
            subConcept: '',
            text: concept,
            selected: true,
            disabled: false,
          },
        });

        continue;
      }

      for (const sub of subs) {
        cart.push({
          id: randomUUID(),
          content: {
            subject: groupSubject,
            chapter,
            concept,
            subConcept: sub,
            text: sub,
            selected: true,
            disabled: false,
          },
        });
      }
    }

    const title = (scoped && concepts.length > 0 && concepts.length <= 3)
      ? `${concepts.join(', ')} Formula Sheet`
      : `${chapter} Formula Sheet`;

    payloads.push({
      bulkRequestType: 'formula',
      studentid: studentId,
      title,
      formulaCart: cart,
    });
  }

  return payloads.length === 1 ? payloads[0] : payloads;
};

const buildRevision = (
  subject,
  chapterGroups,
  params,
  studentId,
) => {
  const title = uniqueChapterTitle(chapterGroups, 'Revision Plan');

  const importanceMap = params.importance ?? params['importance'] ?? {};
  const conceptBandMap =
    params.concept_mastery_band ??
    params['concept_mastery_band'] ??
    {};

  const allotedDays = Number(params.allotedDay ?? params['allotedDay'] ?? 3);

  const portionItems = [];

  for (const group of chapterGroups ?? []) {
    const chapter = group.chapter ?? '';
    const concepts = group.concepts ?? [];
    const subconcepts = group.subconcepts ?? {};

    for (const concept of concepts) {
      let importance;

      if (typeof importanceMap === 'object' && importanceMap !== null) {
        importance =
          importanceMap[concept] ??
          importanceMap.default ??
          importanceMap['default'] ??
          'medium';
      } else {
        importance = importanceMap || 'medium';
      }

      const area = conceptBandMap[concept] ?? 'Red';
      const subs = subconcepts[concept] ?? [];

      const weakData = subs.length
        ? subs.map((sub) => ({
            subject,
            chapter,
            concept,
            subConcept: sub,
            area,
            importance,
          }))
        : [
            {
              subject,
              chapter,
              concept,
              subConcept: '',
              area,
              importance,
            },
          ];

      portionItems.push({
        subject,
        chapter,
        concept,
        importance,
        ratio: null,
        area,
        time:
          params.daywiseTimePerPortion ??
          params['daywiseTimePerPortion'] ??
          60,
        star: 1,
        task: [
          {
            type: 'assignment',
            completed: false,
          },
          {
            type: 'test',
            completed: false,
          },
        ],
        impratio: 3,
        weakData,
      });
    }
  }

  const daywisePortion = {};
  const itemsPerDay = Math.max(1, Math.floor(portionItems.length / allotedDays));

  for (let day = 1; day <= allotedDays; day++) {
    const start = (day - 1) * itemsPerDay;
    const end = day === allotedDays ? portionItems.length : start + itemsPerDay;

    daywisePortion[`day${day}`] = {
      portion: portionItems.slice(start, end),
    };
  }

  return {
    bulkRequestType: 'revision',
    userId: studentId,
    title,
    allotedDay: allotedDays,
    allotedTime: params.allotedTime ?? params['allotedTime'] ?? 1,
    strategy: params.strategy ?? params['strategy'] ?? 1,
    daywisePortion,
  };
};

const buildClicking = (
  subject,
  chapter,
  studentId,
) => ({
  bulkRequestType: 'clickingPower',
  user: studentId,
  chapters: [chapter],
  subject,
  totalQuestions: '10',
});

const buildPicking = (
  subject,
  chapter,
  studentId,
) => ({
  bulkRequestType: 'pickingPower',
  user: studentId,
  chapter,
  subject,
});

const buildRace = (
  subject,
  chapter,
  studentId,
) => ({
  bulkRequestType: 'speedRace',
  subject,
  chapters: [chapter],
  totalQuestions: 15,
  scheduledTime: '',
  duration: '',
  opponentType: 'bot',
  rank: 100,
  user: studentId,
});

const buildConcept = (
  subject,
  chapterGroups,
  studentId,
) => {
  const conceptBasketData = [];
  const seen = new Set();

  for (const group of chapterGroups ?? []) {
    const chapter = group.chapter ?? '';
    const groupSubject = group.subject ?? subject;
    const requestedConcepts = group.concepts ?? [];
    const requestedSubs = group.subconcepts ?? {};

    for (const concept of requestedConcepts) {
      const subs = requestedSubs[concept] ?? [];

      if (subs.length === 0) {
        const key = `${chapter}|${concept}|`;

        if (!seen.has(key)) {
          seen.add(key);

          conceptBasketData.push({
            subject: groupSubject,
            subSubject: groupSubject,
            chapter,
            concept,
            subConcept: '',
          });
        }
      } else {
        for (const sub of subs) {
          const key = `${chapter}|${concept}|${sub}`;

          if (!seen.has(key)) {
            seen.add(key);

            conceptBasketData.push({
              subject: groupSubject,
              subSubject: groupSubject,
              chapter,
              concept,
              subConcept: sub,
            });
          }
        }
      }
    }
  }

  const seenChapters = new Set();
  const orderedChapters = [];

  for (const group of chapterGroups ?? []) {
    const chapter = group.chapter ?? '';

    if (chapter && !seenChapters.has(chapter)) {
      seenChapters.add(chapter);
      orderedChapters.push(chapter);
    }
  }

  const chapterTitle =
    orderedChapters.length > 0
      ? orderedChapters.join(' + ')
      : 'Concept Basket';

  const shorturl = `cb-${randomUUID()}`;
  const longurl = `/dosts/share-concept-basket/view/${shorturl}`;

  return {
    bulkRequestType: 'concept',
    studentid: studentId,
    shorturl,
    longurl,
    title: `${chapterTitle} Concept Basket`,
    meta: {
      chapter: chapterTitle,
      discription: 'Concept Basket',
      conceptBasketData,
    },
  };
};

const buildPayload = async (
  dostType,
  request,
  studentId,
  profileTopics,
) => {
  const chapterGroups = (
    request.chapter_groups ??
    request['chapter_groups'] ??
    []
  ).filter(Boolean);

  const subject = String(request.subject ?? request['subject'] ?? '');

  if (dostType === 'practiceTest') {
    return buildTest(subject, chapterGroups, request, studentId, profileTopics);
  }

  if (dostType === 'practiceAssignment') {
    return buildAssignment(subject, chapterGroups, request, studentId, profileTopics);
  }

  if (dostType === 'formula') {
    return buildFormula(subject, chapterGroups, studentId);
  }

  if (dostType === 'revision') {
    return buildRevision(subject, chapterGroups, request, studentId);
  }

  if (dostType === 'concept') {
    return buildConcept(subject, chapterGroups, studentId);
  }

  const payloads = [];

  for (const group of chapterGroups) {
    const chapter = group.chapter ?? '';
    const subj = group.subject ?? subject;

    if (!chapter || !subj) continue;

    if (dostType === 'clickingPower') {
      payloads.push(buildClicking(subj, chapter, studentId));
    } else if (dostType === 'pickingPower') {
      payloads.push(buildPicking(subj, chapter, studentId));
    } else if (dostType === 'speedRace') {
      payloads.push(buildRace(subj, chapter, studentId));
    }
  }

  return payloads.length === 0 ? null : payloads;
};

module.exports = {
  buildAssignment,
  buildTest,
  buildFormula,
  buildRevision,
  buildClicking,
  buildPicking,
  buildRace,
  buildConcept,
  buildPayload,
  normalizeDifficulty,
  uniqueChapterTitle,
};
