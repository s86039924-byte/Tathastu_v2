const { randomUUID } = require('node:crypto');
const { JourneyDB } = require('../../db/journeys');
const { generateDostPayloads } = require('../../controllers/chanakya/integration');
const { findConcepts } = require('./conceptFinder');

const normDiff = (v) => ({ easy: 'EASY', moderate: 'MODERATE', medium: 'MODERATE', hard: 'HARD', tough: 'HARD' }[String(v).toLowerCase()] ?? 'MODERATE');

// derive the per-type breakdown from a total count (+ optional hint + difficulty).
// mentor only gives total_count; we never ask for scq/mcq/integer.
const splitFromTotal = (total, hint = '', difficulty = '') => {
  const t = Math.max(1, Math.round(Number(total) || 0));
  const h = String(hint).toLowerCase();
  const d = String(difficulty).toLowerCase();

  let wScq = 0.4, wMcq = 0.3, wInt = 0.3; // balanced default

  if (/numeric|integer|calculation|sums?|problem/.test(h)) {
    wScq = 0.25; wMcq = 0.2; wInt = 0.55;        // numerical-heavy
  } else if (/concept|theory|definition|mcq|reasoning/.test(h)) {
    wScq = 0.5; wMcq = 0.4; wInt = 0.1;          // conceptual-heavy
  }

  if (d === 'hard' || d === 'tough') { wInt += 0.1; wScq -= 0.1; } // harder → more numericals

  const scq = Math.max(0, Math.round(t * wScq));
  const mcq = Math.max(0, Math.round(t * wMcq));
  let integerQuestion = Math.max(0, t - scq - mcq); // remainder keeps the sum == total

  return { scq, mcq, integerQuestion, passageQuestion: 0, matchQuestion: 0 };
};

// logical field → payload key mutation, per dost_type
const setField = (payload, dostType, field, value) => {
  const p = { ...payload };
  if (field === 'difficulty') p.level = normDiff(value);
  else if (field === 'duration_minutes') p.noOfMinutes = Number(value);
  else if (field === 'isNCERT') p.isNCERT = Boolean(value);
  else if (field === 'paperPattern') p.paperPattern = String(value);
  else if (field === 'type_split') p.assignmentQuesCount = value;
  else if (field === 'total_count') {
    p.total_count = Number(value);
    p.assignmentQuesCount = splitFromTotal(value, p.qtype_hint, p.level);
  } else if (field === 'qtype_hint') {
    p.qtype_hint = String(value);
    // re-derive the split from the existing total using the new hint
    const total = p.total_count
      ?? Object.values(p.assignmentQuesCount ?? {}).reduce((a, b) => a + (Number(b) || 0), 0);
    if (total) p.assignmentQuesCount = splitFromTotal(total, value, p.level);
  } else if (field === 'allotedDay') p.allotedDay = Number(value);
  else if (field === 'totalQuestions') p.totalQuestions = (dostType === 'clickingPower') ? String(value) : Number(value);
  else p[field] = value; // fallback
  return p;
};

const addPortionItems = (payload, dostType, items) => {
  const p = structuredClone(payload);
  if (dostType === 'concept') {
    p.meta = p.meta ?? { conceptBasketData: [] };
    p.meta.conceptBasketData = p.meta.conceptBasketData ?? [];
    items.forEach((it) => p.meta.conceptBasketData.push({
      subject: it.subject, subSubject: it.subject, chapter: it.chapter, concept: it.concept, subConcept: it.subconcept ?? '',
    }));
  } else if (dostType === 'formula') {
    p.formulaCart = p.formulaCart ?? [];
    items.forEach((it) => p.formulaCart.push({
      id: randomUUID(),
      content: { subject: it.subject, chapter: it.chapter, concept: it.concept, subConcept: it.subconcept ?? '', text: it.subconcept || it.concept, selected: true, disabled: false },
    }));
  } else { // assignment / test
    p.practicePortion = p.practicePortion ?? [];
    items.forEach((it) => p.practicePortion.push({
      id: randomUUID(),
      content: { subject: it.subject, chapter: it.chapter, concept: it.concept, ...(it.subconcept ? { subConcept: it.subconcept } : {}) },
    }));
  }
  return p;
};

const removePortionItem = (payload, dostType, portionIndex) => {
  const p = structuredClone(payload);
  if (dostType === 'concept') p.meta?.conceptBasketData?.splice(portionIndex, 1);
  else if (dostType === 'formula') p.formulaCart?.splice(portionIndex, 1);
  else p.practicePortion?.splice(portionIndex, 1);
  return p;
};

const groupConcepts = (subject, chapter, items) => {
  const concepts = []; const subconcepts = {};
  for (const it of items) {
    if (!concepts.includes(it.concept)) concepts.push(it.concept);
    if (it.subconcept) (subconcepts[it.concept] = subconcepts[it.concept] ?? []).push(it.subconcept);
  }
  return [{ subject, chapter, concepts, subconcepts }];
};

// apply ONE action
async function applyAction(sessionId, journeyType, action, profile, journey) {
  const subject = journey.subject; const chapter = journey.chapter;

  switch (action.action) {
    case 'remove_dost':
      return JourneyDB.removeDost(sessionId, journeyType, action.target_index);

    case 'move_dost':
      return JourneyDB.moveDost(sessionId, journeyType, action.dest_type, action.target_index);

    case 'reorder_dost':
      return JourneyDB.reorderDost(sessionId, journeyType, action.target_index, action.to_index);

    case 'edit_field': {
      const dost = journey.dosts[action.target_index]; if (!dost) return null;
      const newPayload = setField(dost.payload, dost.dost_type, action.field, action.value);
      return JourneyDB.setPayload(sessionId, journeyType, action.target_index, newPayload);
    }

    case 'add_portion': {
      const dost = journey.dosts[action.target_index]; if (!dost) return null;
      let items = action.items ?? [];
      if (action.needs_concept_search) items = await findConcepts(action.concept_query, subject, chapter);
      if (!items.length) return null;
      const newPayload = addPortionItems(dost.payload, dost.dost_type, items);
      return JourneyDB.setPayload(sessionId, journeyType, action.target_index, newPayload);
    }

    case 'remove_portion': {
      const dost = journey.dosts[action.target_index]; if (!dost) return null;
      const newPayload = removePortionItem(dost.payload, dost.dost_type, action.portion_index);
      return JourneyDB.setPayload(sessionId, journeyType, action.target_index, newPayload);
    }

    case 'add_dost': {
      // resolve concepts (or fall back to the whole chapter / journey topics)
      let items = [];
      if (action.needs_concept_search) items = await findConcepts(action.concept_query, subject, chapter);
      const profileTopics = profile?.topics ?? [];
      const chapterGroups = items.length
        ? groupConcepts(subject, chapter, items)
        : [{ subject, chapter }]; // whole chapter

      const params = { ...(action.params ?? {}) };

      // practiceAssignment: mentor gives total_count (+ optional qtype_hint);
      // derive the per-type split here, the builder never sees total_count.
      if (action.dost_type === 'practiceAssignment' && params.total_count != null && params.type_split == null) {
        params.type_split = splitFromTotal(params.total_count, params.qtype_hint, params.difficulty);
      }
      delete params.total_count;
      delete params.qtype_hint;

      const request = {
        dost_type: action.dost_type,
        subject,
        chapter_groups: chapterGroups,
        ...params,
      };
      const payloads = await generateDostPayloads({
        requestList: [request], profile, profileTopics,
      });
      if (!payloads.length) return null;
      const card = {
        dost_type: action.dost_type,
        title: payloads[0].title ?? action.dost_type,
        payload: payloads[0],
        original_payload: structuredClone(payloads[0]),
        script: '', status: 'draft',
        success: null, dost_id: null, link: null, error: null,
      };
      return JourneyDB.addDost(sessionId, journeyType, card);
    }

    default:
      return null;
  }
}

// apply all actions in order; re-read journey between actions so indices stay valid
async function applyActions(sessionId, journeyType, actions, profile, journey) {
  let latest = null;
  let current = journey;
  for (const action of actions) {
    if (action.action === 'none') continue;
    const updated = await applyAction(sessionId, journeyType, action, profile, current);
    if (updated) {
      latest = updated;
      current = updated.journeys.find((j) => j.type === journeyType); // refresh for next action
    }
  }
  return latest;
}

module.exports = { applyActions };
