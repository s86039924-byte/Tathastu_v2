const { getSubjectIndexes } = require('../vectorSearch');

const integrateChanakyaIntoProfile = (
  profile,
  classification,
  ragResult,
) => {
  profile.chanakya = {
    query_mode: classification.mode,
    structured_answer: classification.structured_answer,
    translated_query: classification.translated,
    rag_reasoning: ragResult?.reasoning ?? null,
    request_list: ragResult?.requestList ?? [],
    rag_chunks: ragResult?.chunks ?? [],
  };

  return profile;
};

const enrichChapterGroupsFromProfile = (
  chapterGroups,
  profileTopics,
) => {
  if (!profileTopics || profileTopics.length === 0) {
    return chapterGroups;
  }

  return chapterGroups.map((group) => {
    const subject = group.subject ?? '';
    const chapter = group.chapter ?? '';

    if (!subject || !chapter) return group;

    const matching = profileTopics.filter(
      (t) => t.subject === subject && t.chapter === chapter,
    );

    if (matching.length === 0) return group;

    const concepts = new Set();
    const subconcepts = {};

    for (const topic of matching) {
      const concept = topic.concept;
      const subconcept = topic.subconcept;

      if (!concept) continue;

      concepts.add(concept);

      if (subconcept) {
        if (!subconcepts[concept]) {
          subconcepts[concept] = [];
        }

        if (!subconcepts[concept].includes(subconcept)) {
          subconcepts[concept].push(subconcept);
        }
      }
    }

    return {
      subject,
      chapter,
      concepts: [...concepts],
      subconcepts,
    };
  });
};

const subjectIndexKey = (subject) => {
  const s = String(subject ?? '').trim().toLowerCase();

  if (!s) return '';
  if (s.includes('chem')) return 'chemistry';
  if (s.includes('math')) return 'maths';
  if (s.includes('phys')) return 'physics';
  if (s.includes('bio')) return 'biology';

  return s;
};

const faissFillEmptyConceptGroups = async (
  chapterGroups,
  requestSubject,
  profileTopics,
) => {
  if (!chapterGroups || chapterGroups.length === 0) {
    return chapterGroups;
  }

  const subjKeyForProfile = subjectIndexKey(requestSubject ?? '');

  const profileCoversSubject =
    Boolean(profileTopics) &&
    (profileTopics ?? []).some(
      (t) =>
        subjectIndexKey(t.subject ?? '') === subjKeyForProfile &&
        subjKeyForProfile,
    );

  if (profileCoversSubject) {
    return chapterGroups;
  }

  let indexes = {};

  try {
    indexes = (await getSubjectIndexes()) ?? {};
  } catch (err) {
    console.error('[chanakya] FAISS fallback index load failed:', err.message);
    return chapterGroups;
  }

  if (Object.keys(indexes).length === 0) {
    return chapterGroups;
  }

  const filled = [];

  for (const group of chapterGroups) {
    if (group.concepts && group.concepts.length > 0) {
      filled.push(group);
      continue;
    }

    const chapter = String(group.chapter ?? '').trim();
    const groupSubject = String(group.subject ?? requestSubject ?? '').trim();

    if (!chapter || !groupSubject) {
      filled.push(group);
      continue;
    }

    const subjKey = subjectIndexKey(groupSubject);
    const idxBlob = indexes[subjKey];

    if (!idxBlob) {
      filled.push(group);
      continue;
    }

    const chunks = idxBlob.chunks ?? [];
    const chapterLower = chapter.toLowerCase();

    const conceptsOrder = [];
    const seen = new Set();
    const subconceptsMap = {};

    for (const chunk of chunks) {
      if (String(chunk.chapter ?? chunk['chapter'] ?? '').toLowerCase() !== chapterLower) {
        continue;
      }

      const c = String(chunk.concept ?? chunk['concept'] ?? '').trim();
      const s = String(chunk.subconcept ?? chunk['subconcept'] ?? '').trim();

      if (!c) continue;

      if (!seen.has(c)) {
        seen.add(c);
        conceptsOrder.push(c);
        subconceptsMap[c] = [];
      }

      if (s && !subconceptsMap[c].includes(s)) {
        subconceptsMap[c].push(s);
      }
    }

    if (conceptsOrder.length === 0) {
      filled.push(group);
      continue;
    }

    const capped = conceptsOrder.slice(0, 8);

    filled.push({
      ...group,
      concepts: capped,
      subconcepts: Object.fromEntries(
        capped.map((c) => [c, subconceptsMap[c] ?? []]),
      ),
    });
  }

  return filled;
};

const prepareRequestChapterGroups = async (
  request,
  profileTopics,
) => {
  if (!('chapter_groups' in request)) return request;

  const groups = request.chapter_groups ?? request['chapter_groups'] ?? [];

  let enriched = groups;

  if (profileTopics && profileTopics.length > 0) {
    enriched = enrichChapterGroupsFromProfile(groups, profileTopics);
  }

  if (request.dost_type === 'concept' || request['dost_type'] === 'concept') {
    enriched = await faissFillEmptyConceptGroups(
      enriched,
      request.subject ?? request['subject'],
      profileTopics,
    );
  }

  request.chapter_groups = enriched;

  return request;
};

module.exports = {
  integrateChanakyaIntoProfile,
  enrichChapterGroupsFromProfile,
  faissFillEmptyConceptGroups,
  prepareRequestChapterGroups,
  subjectIndexKey,
};