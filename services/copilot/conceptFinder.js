const { embed } = require('../../config/openai');
const { getSubjectIndexes, searchTopK } = require('../../controllers/vectorSearch');

const subjKey = (s) => {
  const x = String(s ?? '').toLowerCase();
  if (x.includes('chem')) return 'chemistry';
  if (x.includes('math')) return 'maths';
  if (x.includes('phys')) return 'physics';
  if (x.includes('bio')) return 'biology';
  return x;
};

// words that carry no topic meaning in a "find concepts" phrase
const STOP = new Set([
  'all', 'every', 'the', 'of', 'for', 'a', 'an', 'and', 'in', 'on', 'to', 'me',
  'add', 'give', 'please', 'formula', 'formulas', 'sheet', 'concept', 'concepts',
  'topic', 'topics', 'law', // keep singular "law" via singularize below; plural handled there
]);

const isExhaustive = (q) => /\b(all|every|entire|complete|whole)\b/i.test(String(q));

// crude singularize so "laws" matches "law"
const singular = (w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w);

// EXHAUSTIVE name match: every concept/subconcept in the chapter whose name
// contains a meaningful term from the query. Deterministic — no embeddings.
function nameMatch(idx, query, chapter) {
  const chapterWords = new Set(
    String(chapter ?? '').toLowerCase().split(/\W+/).filter(Boolean),
  );

  // distinctive terms = query words minus stopwords minus chapter-name words
  const terms = String(query ?? '')
    .toLowerCase()
    .split(/\W+/)
    .filter(Boolean)
    .map(singular)
    .filter((w) => w.length >= 3 && !STOP.has(w) && !chapterWords.has(w));

  if (terms.length === 0) return [];

  const out = [];
  const seen = new Set();

  for (const c of idx.chunks) {
    if (chapter && String(c.chapter) !== String(chapter)) continue;

    const concept = String(c.concept ?? '');
    const sub = String(c.subconcept ?? '');
    const cl = concept.toLowerCase();
    const sl = sub.toLowerCase();

    // concept-name hit → include the whole concept (all its subconcepts get added as we iterate)
    // subconcept-name hit → include just that pair
    const hit = terms.some((t) => cl.includes(t) || sl.includes(t));
    if (!hit) continue;

    const key = `${concept}|${sub}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ subject: c.subject, chapter: c.chapter, concept, subconcept: sub });
  }

  return out;
}

// resolve a phrase → EXACT {concept, subconcept} names from the index (within the chapter)
async function findConcepts(query, subject, chapter, k = 6) {
  const indexes = await getSubjectIndexes();
  const idx = indexes[subjKey(subject)];
  if (!idx) return [];

  // "all X" / "every X" → exhaustive, deterministic name match over the chapter
  if (isExhaustive(query)) {
    const matches = nameMatch(idx, query, chapter);
    if (matches.length) return matches;
    // no name match → fall through to semantic search
  }

  // default: semantic vector search, top-k
  const [vec] = await embed(query);
  if (!vec) return [];
  const hits = searchTopK(idx, vec, k * 4);
  const out = [];
  const seen = new Set();
  for (const h of hits) {
    const c = idx.chunks[h.row];
    if (chapter && String(c.chapter) !== String(chapter)) continue;
    const key = `${c.concept}|${c.subconcept}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ subject: c.subject, chapter: c.chapter, concept: c.concept, subconcept: c.subconcept });
    if (out.length >= k) break;
  }
  return out;
}

module.exports = { findConcepts };
