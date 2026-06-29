const { queryChecker } = require('./queryChecker');

const {
  runRagPipelineFromProfile,
} = require('./rag/ragEngine');

const {
  prepareRequestChapterGroups, integrateChanakyaIntoProfile,
} = require('./profileEnrichment');

const { buildAllPayloads } = require('./payloadBuilder');
const { createDost } = require('./dostTools/acadzaClient');

const DEFAULT_ACADZA_USER_ID =
  process.env.ACADZA_DEFAULT_USER_ID || null;

const classifyQuery = async (query, inputType = 'text') => {
  try {
    const result = await queryChecker(query, {
      translateIfDostOrMixed: true,
      inputType,
    });

    return {
      mode: result.mode ?? 'error',
      ...(result.structured_answer
        ? { structured_answer: result.structured_answer }
        : {}),
      ...(result.translated ? { translated: result.translated } : {}),
      ...(result.error ? { error: result.error } : {}),
    };
  } catch (err) {
    console.error('[chanakya] classify failed:', err.message);

    return {
      mode: 'error',
      error: `Query classification failed: ${err.message}`,
    };
  }
};

const runChanakyaRagPipelineFromProfile = async (
  profile,
  opts = {},
) => {
  try {
    return await runRagPipelineFromProfile(
      profile,
      opts.journeyIntent ?? null,
      opts.ladderSpec ?? null,
    );
  } catch (err) {
    console.error('[chanakya] RAG profile failed:', err.message);

    return {
      chunks: [],
      requestList: [],
      reasoning: '',
      error: `RAG pipeline failed: ${err.message}`,
    };
  }
};

const generateDostPayloads = async ({
  requestList = [],
  profile = null,
  profileTopics = null,
  acadzaUserId = null,
}) => {
  const payloadResults = await buildAllPayloads({
    requestList,
    profile,
    profileTopics,
    acadzaUserId,
  });

  return payloadResults.map((result) => result.payload);
};

const callAcadzaApi = async (payload, opts = {}) => {
  return createDost(payload, opts);
};

const callAcadzaApiForPayloads = async (payloads, opts = {}) => {
  const results = [];

  for (const item of payloads ?? []) {
    const payload = item?.payload ?? item;
    const result = await callAcadzaApi(payload, opts);
    results.push(result);
  }

  return results;
};

const runChanakyaIntegrationFromProfile = async ({
  profile,
  acadzaUserId = null,
  journeyIntent = null,
  ladderSpec = null,
  createDostNow = false,
}) => {
  const ragResult = await runChanakyaRagPipelineFromProfile(profile, {
    journeyIntent,
    ladderSpec,
  });

  const profileTopics = profile?.topics ?? [];

  const payloadResults = await buildAllPayloads({
    requestList: ragResult.requestList ?? [],
    profile,
    profileTopics,
    acadzaUserId,
  });

  const payloads = payloadResults.map((result) => result.payload);

  let acadzaResults = [];

  if (createDostNow) {
    acadzaResults = await callAcadzaApiForPayloads(payloadResults);
  }

  return {
    ragResult,
    requestList: ragResult.requestList ?? [],
    payloadResults,
    payloads,
    acadzaResults,
  };
};

module.exports = {
  classifyQuery,
  runChanakyaRagPipelineFromProfile,
  generateDostPayloads,
  callAcadzaApi,
  callAcadzaApiForPayloads,
  runChanakyaIntegrationFromProfile,

  integrateChanakyaIntoProfile,
  prepareRequestChapterGroups,
};
