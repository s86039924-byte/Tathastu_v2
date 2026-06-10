const { embed } = require('../config/openai');
const {
  getSubjectIndexes,
  searchTopK,
  getChunk,
} = require('./vectorSearch');

const { detectSubject } = require('./openaiPipeline');

const TOP_K = 10;
const FINAL_TOP_N = 15;
const RRF_K = 60;

const getIndexesForQuery = async (query, forcedSubject = null) => {
  const indexes = await getSubjectIndexes();

  if (forcedSubject && indexes[forcedSubject]) {
    return [[forcedSubject, indexes[forcedSubject]]];
  }

  const detected = await detectSubject(query);

  if (detected && indexes[detected]) {
    return [[detected, indexes[detected]]];
  }

  return Object.entries(indexes);
};

const searchSingle = async (
  queryText,
  subjectName,
  subjectData,
  topK = TOP_K,
) => {
  const [queryVec] = await embed(queryText);
  if (!queryVec) return [];
  const hits = searchTopK(subjectData, queryVec, topK);
  return hits
    .filter((h) => h.row >= 0 && h.row < subjectData.chunks.length)
    .map((h) => `${subjectName}||${h.row}`);
};

const searchQuery = async (queryText, topK = TOP_K, forcedSubject = null) => {
  const all = [];
  for (const [name, data] of await getIndexesForQuery(queryText, forcedSubject)) {
    const results = await searchSingle(queryText, name, data, topK);
    all.push(...results);
  }
  return all;
};

const reciprocalRankFusion = (
  rankings,
  k = RRF_K,
) => {
  const scores = new Map();
  for (const ranking of rankings) {
    ranking.forEach((docId, rank) => {
      scores.set(docId, (scores.get(docId) ?? 0) + 1.0 / (k + rank + 1));
    });
  }
  return Array.from(scores.entries()).sort((a, b) => b[1] - a[1]);
};

const depthBoost = async (docId) => {
  const chunk = await getChunk(docId);
  if (!chunk) return 1.0;
  const fields = ['subject', 'chapter', 'concept', 'subconcept'];
  const filled = fields.filter((f) => Boolean(chunk[f])).length;
  return ({ 1: 0.6, 2: 0.75, 3: 0.9, 4: 1.0 })[filled] ?? 1.0;
};

const buildResultTree = async (
  fused,
  topN = FINAL_TOP_N,
) => {
  const tree = {};

  for (const [docId, score] of fused.slice(0, topN)) {
    const chunk = await getChunk(docId);
    if (!chunk) continue;

    const subj = String(chunk['subject'] ?? 'Unknown');
    const chap = String(chunk['chapter'] ?? 'Unknown');
    const concept = String(chunk['concept'] ?? 'Unknown');
    const subcon = String(chunk['subconcept'] ?? '');
    const key = subcon || '_';

    if (!tree[subj]) tree[subj] = {};
    if (!tree[subj][chap]) tree[subj][chap] = {};
    if (!tree[subj][chap][concept]) tree[subj][chap][concept] = {};

    const existing = tree[subj][chap][concept][key];
    if (existing && score <= existing.score) continue;

    tree[subj][chap][concept][key] = {
      ...chunk,
      score: Math.round(score * 100000) / 100000,
      doc_id: docId,
    };
  }

  return tree;
};

const runSearchPipeline = async (
  expandedQueries,
  topK = TOP_K,
  finalTopN = FINAL_TOP_N,
  rrfK = RRF_K,
  forcedSubject = null,
) => {
  const queries = Array.isArray(expandedQueries)
    ? expandedQueries.filter((q) => typeof q === 'string' && q.trim())
    : [];

  if (queries.length === 0) {
    return {
      rankedResults: [],
      tree: {},
    };
  }

  const allRankings = [];

  for (const q of queries) {
    const ranking = await searchQuery(q, topK, forcedSubject);
    allRankings.push(ranking);
  }

  const fused = reciprocalRankFusion(allRankings, rrfK);

  const boosted = [];

  for (const [docId, score] of fused) {
    const boost = await depthBoost(docId);
    boosted.push([docId, score * boost]);
  }

  boosted.sort((a, b) => b[1] - a[1]);

  const tree = await buildResultTree(boosted, finalTopN);

  return {
    rankedResults: boosted,
    tree,
  };
};

module.exports = { getIndexesForQuery, searchSingle, searchQuery, reciprocalRankFusion, depthBoost, buildResultTree, runSearchPipeline };