const Journey = require('../models/Journey');

const reindex = (arr) => arr.forEach((d, i) => { d.index = i; });

// generic: load (non-lean) → mutate via fn(doc) → save. fn returns false to abort.
const mutate = async (sessionId, fn) => {
  const doc = await Journey.findOne({ session_id: sessionId });
  if (!doc) return null;
  const ok = fn(doc);
  if (ok === false) return null;
  doc.markModified('journeys');
  await doc.save();
  return doc.toObject();
};

const findJourney = (doc, type) => doc.journeys.find((j) => j.type === type);

const JourneyDB = {
  async save(sessionId, data) {
    await Journey.updateOne(
      { session_id: sessionId },
      { $set: { ...data, session_id: sessionId } },
      { upsert: true },
    );
    return JourneyDB.get(sessionId);
  },

  async get(sessionId) {
    return Journey.findOne({ session_id: sessionId }).lean();
  },

  addDost(sessionId, type, card) {
    return mutate(sessionId, (doc) => {
      const j = findJourney(doc, type); if (!j) return false;
      j.dosts = j.dosts ?? [];
      j.dosts.push(card);
      reindex(j.dosts);
    });
  },

  removeDost(sessionId, type, idx) {
    return mutate(sessionId, (doc) => {
      const j = findJourney(doc, type); if (!j) return false;
      if (idx < 0 || idx >= (j.dosts?.length ?? 0)) return false;
      j.dosts.splice(idx, 1); reindex(j.dosts);
    });
  },

  moveDost(sessionId, srcType, destType, idx) {
    return mutate(sessionId, (doc) => {
      const s = findJourney(doc, srcType); const d = findJourney(doc, destType);
      if (!s || !d || idx < 0 || idx >= (s.dosts?.length ?? 0)) return false;
      const [card] = s.dosts.splice(idx, 1);
      d.dosts = d.dosts ?? []; d.dosts.push(card);
      reindex(s.dosts); reindex(d.dosts);
    });
  },

  reorderDost(sessionId, type, from, to) {
    return mutate(sessionId, (doc) => {
      const j = findJourney(doc, type); if (!j) return false;
      const n = j.dosts?.length ?? 0;
      if (from < 0 || from >= n || to < 0 || to >= n) return false;
      const [card] = j.dosts.splice(from, 1);
      j.dosts.splice(to, 0, card); reindex(j.dosts);
    });
  },

  // set ONE raw payload key (also used by the mentor PATCH route)
  updateDostPayload(sessionId, type, idx, key, value) {
    return mutate(sessionId, (doc) => {
      const j = findJourney(doc, type); const dost = j?.dosts?.[idx];
      if (!dost) return false;
      dost.payload = { ...(dost.payload ?? {}), [key]: value };
    });
  },

  // alias used by the copilot for the same single-key set
  setPayloadKey(sessionId, type, idx, key, value) {
    return JourneyDB.updateDostPayload(sessionId, type, idx, key, value);
  },

  // replace a whole payload (used when applyPlan rebuilds via buildPayload)
  setPayload(sessionId, type, idx, payload) {
    return mutate(sessionId, (doc) => {
      const j = findJourney(doc, type); const dost = j?.dosts?.[idx];
      if (!dost) return false;
      dost.payload = payload;
    });
  },

  recordSendResults(sessionId, type, results) {
    return mutate(sessionId, (doc) => {
      const j = findJourney(doc, type); if (!j) return false;
      j.dosts.forEach((d, i) => {
        const r = results[i] ?? {};
        d.success = Boolean(r.success); d.dost_id = r.dost_id ?? null;
        d.link = r.link ?? null; d.error = r.error ?? null;
        d.status = r.success ? 'sent' : 'failed';
      });
      j.sent = true;
    });
  },

  selectJourney(sessionId, type) {
    return mutate(sessionId, (doc) => {
      let found = false;
      doc.journeys.forEach((j) => { j.selected = j.type === type; if (j.selected) found = true; });
      return found ? undefined : false;
    });
  },

  appendChat(sessionId, entry) {
    return mutate(sessionId, (doc) => {
      doc.copilot_messages = doc.copilot_messages ?? [];
      doc.copilot_messages.push(entry);
      doc.markModified('copilot_messages');
    });
  },

  // the clarification question the copilot is currently waiting an answer to
  setCopilotPending(sessionId, pending) {
    return mutate(sessionId, (doc) => {
      doc.copilot_pending = pending ?? null;
      doc.markModified('copilot_pending');
    });
  },
};

module.exports = { JourneyDB };
