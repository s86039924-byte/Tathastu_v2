const { getFinalPayloadFromGpt } = require('./prompts');

const extractChunksFromProfile = (profile) => {
  const topics = profile?.topics ?? [];

  return topics.map((topic) => {
    const subject = String(topic.subject ?? topic['subject'] ?? '');
    const chapter = String(topic.chapter ?? topic['chapter'] ?? '');
    const concept = String(topic.concept ?? topic['concept'] ?? '');
    const subconcept = String(topic.subconcept ?? topic['subconcept'] ?? '');

    return {
      subject,
      chapter,
      concept,
      subconcept,
      text: `${subject} > ${chapter} > ${concept} > ${subconcept}`,
      score: Number(topic.relevance_score ?? topic['relevance_score'] ?? 0),
      doc_id: topic.doc_id ?? topic['doc_id'] ?? null,
    };
  });
};

const runRagPipelineFromProfile = async (
  profile,
  journeyIntent = null,
  ladderSpec = null,
) => {
  const query = String(profile?.original_query ?? '');

  const chunks = extractChunksFromProfile(profile);

  const result = await getFinalPayloadFromGpt(
    query,
    chunks,
    profile,
    journeyIntent,
    ladderSpec,
  );

  return {
    chunks,
    requestList: result.requestList ?? [],
    reasoning: result.reasoning ?? '',
    ...(result.error ? { error: result.error } : {}),
  };
};

module.exports = {
  extractChunksFromProfile,
  runRagPipelineFromProfile,
};