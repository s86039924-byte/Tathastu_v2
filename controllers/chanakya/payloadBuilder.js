const { prepareRequestChapterGroups } = require('./profileEnrichment');
const { resolveParamsFromProfile } = require('./paramResolver');
const { buildPayload } = require('./Builders');
const { createDost } = require('./dostTools/acadzaClient');

const DEFAULT_ACADZA_USER_ID =
  process.env.ACADZA_DEFAULT_USER_ID || null;

// Single source of truth for turning requestList into DOST payloads.
// Returns rich entries: { dost_type, payload, script, request }
const buildAllPayloads = async (args = {}) => {
  const effectiveUserId =
    args.acadzaUserId ||
    args.acadza_user_id ||
    DEFAULT_ACADZA_USER_ID;

  const effectiveProfile =
    args.profile ??
    (args.profileTopics ? { topics: args.profileTopics } : null);

  const profileTopics =
    args.profileTopics ??
    effectiveProfile?.topics ??
    null;

  const requestList = Array.isArray(args.requestList)
    ? args.requestList
    : [];

  const results = [];

  for (const raw of requestList) {
    if (!raw || typeof raw !== 'object') continue;

    const request = raw;
    const dostType = String(request.dost_type ?? request['dost_type'] ?? '').trim();

    if (!dostType) continue;

    try {
      resolveParamsFromProfile(request, effectiveProfile);

      await prepareRequestChapterGroups(request, profileTopics);

      const payload = await buildPayload(
        dostType,
        request,
        effectiveUserId,
        profileTopics,
      );

      if (!payload) continue;

      const payloadList = Array.isArray(payload) ? payload : [payload];

      for (const item of payloadList) {
        if (!item) continue;

        results.push({
          dost_type: dostType,
          payload: item,
          script: String(request.script ?? request['script'] ?? ''),
          request,
        });
      }
    } catch (err) {
      console.error('[chanakya payload-builder] failed:', {
        dostType,
        error: err.message,
      });
    }
  }

  return results;
};

// Calls Acadza API for payloads in parallel.
// payloads can be:
// 1. flat payload array
// 2. rich entries from buildAllPayloads: { payload, dost_type, ... }
const callAcadzaParallel = async (
  payloads,
  _studentId,
  opts = {},
) => {
  const list = Array.isArray(payloads) ? payloads : [];
  const maxWorkers = Math.max(1, opts.maxWorkers ?? 5);

  const results = new Array(list.length);
  let next = 0;

  const worker = async () => {
    while (true) {
      const idx = next;
      next += 1;

      if (idx >= list.length) return;

      const item = list[idx];
      const payload = item?.payload ?? item;

      try {
        results[idx] = await createDost(payload);
      } catch (err) {
        console.error('[acadza-executor] call failed:', {
          idx,
          error: err.message,
        });

        results[idx] = {
          success: false,
          link: null,
          dost_id: null,
          error: err.message ?? String(err),
        };
      }
    }
  };

  const workerCount = Math.min(maxWorkers, list.length);

  if (workerCount === 0) {
    return [];
  }

  await Promise.all(
    Array.from({ length: workerCount }, () => worker()),
  );

  return results;
};

module.exports = {
  buildAllPayloads,
  callAcadzaParallel,
};
