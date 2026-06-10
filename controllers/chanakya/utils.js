const { randomUUID } = require('node:crypto');

const {
  isValidChapter,
  isValidConcept,
  isValidSubconcept,
  correctSubject,
} = require('./rag/conceptTree');

const buildPracticePortion = async (chapterGroups) => {
  const portion = [];

  for (const group of chapterGroups ?? []) {
    let subject = group.subject ?? '';
    const chapter = group.chapter ?? '';

    if (!subject || !chapter) continue;

    if (!(await isValidChapter(subject, chapter))) {
      subject = await correctSubject(chapter, subject);

      if (!(await isValidChapter(subject, chapter))) {
        continue;
      }
    }

    const concepts = group.concepts ?? [];
    const subconceptsMap = group.subconcepts ?? {};

    for (const concept of concepts) {
      if (!(await isValidConcept(subject, chapter, concept))) {
        continue;
      }

      const subs = subconceptsMap[concept] ?? [];

      if (subs.length > 0) {
        for (const sub of subs) {
          if (!(await isValidSubconcept(subject, chapter, concept, sub))) {
            continue;
          }

          portion.push({
            id: randomUUID(),
            content: {
              subject,
              chapter,
              concept,
              subConcept: sub,
            },
          });
        }
      } else {
        portion.push({
          id: randomUUID(),
          content: {
            subject,
            chapter,
            concept,
          },
        });
      }
    }
  }

  if (portion.length === 0) {
    console.warn('[chanakya utils] No valid practicePortion built');
  }

  return portion;
};

const buildPracticePortionFromProfile = (topics) => {
  const portion = [];
  const seen = new Set();

  for (const topic of topics ?? []) {
    const subject = topic.subject ?? '';
    const chapter = topic.chapter ?? '';
    const concept = topic.concept ?? '';
    const subconcept = topic.subconcept ?? '';

    if (!subject || !chapter || !concept) continue;

    const key = `${subject}|${chapter}|${concept}|${subconcept}`;

    if (seen.has(key)) continue;

    seen.add(key);

    const content = {
      subject,
      chapter,
      concept,
    };

    if (subconcept) {
      content.subConcept = subconcept;
    }

    portion.push({
      id: randomUUID(),
      content,
    });
  }

  return portion;
};

module.exports = {
  buildPracticePortion,
  buildPracticePortionFromProfile,
};