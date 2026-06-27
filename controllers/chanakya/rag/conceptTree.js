const { readFile } = require('fs/promises');
const path = require('path');

const VECTOR_STORE = {
  tathastuIndexesDir: 'openai_subject_index',
  subjects: ['physics', 'chemistry', 'maths', 'biology'],
};

// JEE/NEET → Subject → Chapter → Concept → Subconcepts[]

let _tree = null;

const perSubjectTreePath = (subject) => {
  return path.join(
    VECTOR_STORE.tathastuIndexesDir,
    `${subject}_tagging_module`,
    `${subject}_acadza_concept_tree.json`,
  );
};

const mergeInto = (dst, src) => {
  for (const [stream, subjects] of Object.entries(src ?? {})) {
    if (!dst[stream]) dst[stream] = {};

    for (const [subject, chapters] of Object.entries(subjects ?? {})) {
      dst[stream][subject] = chapters;
    }
  }
};

const loadTree = async () => {
  if (_tree) return _tree;

  const merged = {};

  for (const subject of VECTOR_STORE.subjects) {
    const filePath = perSubjectTreePath(subject);

    try {
      const raw = await readFile(filePath, 'utf-8');
      const parsed = JSON.parse(raw);

      mergeInto(merged, parsed);
    } catch (err) {
      console.warn('[chanakya] per-subject tree skipped:', {
        subject,
        filePath,
        error: err.message,
      });
    }
  }

  _tree = merged;

  const subjectCount = Object.values(merged).reduce((total, stream) => {
    return total + Object.keys(stream ?? {}).length;
  }, 0);

  console.log('[chanakya] concept tree merged from openai_subject_index:', {
    streams: Object.keys(merged),
    subjects: subjectCount,
  });

  return _tree;
};

const getConceptTree = async () => {
  return loadTree();
};

const closeMatch = (needle, haystack, cutoff = 0.7) => {
  if (!needle) return null;

  const lower = String(needle).toLowerCase();

  for (const h of haystack ?? []) {
    if (String(h).toLowerCase() === lower) {
      return h;
    }
  }

  let best = null;
  let bestScore = 0;

  for (const h of haystack ?? []) {
    const hLower = String(h).toLowerCase();

    if (hLower.includes(lower) || lower.includes(hLower)) {
      const score =
        Math.min(lower.length, hLower.length) /
        Math.max(lower.length, hLower.length);

      if (score > bestScore && score >= cutoff) {
        best = h;
        bestScore = score;
      }
    }
  }

  return best;
};

const correctSubject = async (chapter, subjectHint) => {
  const tree = await loadTree();

  for (const stream of Object.values(tree)) {
    for (const [subject, chapters] of Object.entries(stream ?? {})) {
      const chapterNames = Object.keys(chapters ?? {});

      if (closeMatch(chapter, chapterNames, 0.7)) {
        return subject;
      }
    }
  }

  return subjectHint;
};

const isValidChapter = async (subject, chapter) => {
  const tree = await loadTree();

  for (const stream of Object.values(tree)) {
    if (stream?.[subject]?.[chapter]) {
      return true;
    }
  }

  return false;
};

const isValidConcept = async (
  subject,
  chapter,
  concept,
) => {
  const tree = await loadTree();

  for (const stream of Object.values(tree)) {
    if (stream?.[subject]?.[chapter]?.[concept]) {
      return true;
    }
  }

  return false;
};

const isValidSubconcept = async (
  subject,
  chapter,
  concept,
  subconcept,
) => {
  const tree = await loadTree();

  for (const stream of Object.values(tree)) {
    const subs = stream?.[subject]?.[chapter]?.[concept];

    if (Array.isArray(subs) && subs.includes(subconcept)) {
      return true;
    }
  }

  return false;
};

module.exports = {
  getConceptTree,
  correctSubject,
  isValidChapter,
  isValidConcept,
  isValidSubconcept,
};