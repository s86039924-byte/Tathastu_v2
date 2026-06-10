const { SessionDB } = require('../../db/sessions');
const { JourneyDB } = require('../../db/journeys');
const { StudentProfileDB } = require('../../db/studentProfiles');
const { callPlanner } = require('./planner');
const { applyActions } = require('./applyPlan');

const nowIso = () => new Date().toISOString();

async function journeyCopilot({ sessionId, journeyType, message }) {
  const session = await SessionDB.get(sessionId);
  if (!session) return { type: 'error', message: 'Session not found' };

  const doc = await JourneyDB.get(sessionId);
  const journey = doc?.journeys?.find((j) => j.type === journeyType);
  if (!journey) return { type: 'error', message: 'Journey not found' };

  // enrich journey with subject/chapter for the planner + apply step
  const profile = await StudentProfileDB.get(session.student_id, sessionId);
  journey.subject = profile?.detected_subject ?? journey.dosts?.[0]?.payload?.practicePortion?.[0]?.content?.subject ?? '';
  journey.chapter = profile?.detected_topic ?? journey.dosts?.[0]?.payload?.meta?.chapter ?? '';

  const chat = doc.copilot_messages ?? [];

  // [1] PLAN
  const plan = await callPlanner({ journey, mentorMessage: message, chatHistory: chat });

  // log the mentor turn
  await JourneyDB.appendChat(sessionId, { role: 'mentor', content: message, ts: nowIso() });

  // [2] slot-filling: not enough info → ask
  if (plan.needs_clarification) {
    await JourneyDB.appendChat(sessionId, { role: 'copilot', content: plan.clarification, examples: plan.examples, ts: nowIso() });
    return { type: 'ask', message: plan.clarification, examples: plan.examples ?? [] };
  }

  // [2b] deterministic slot-fill guard: a NEW practiceAssignment MUST carry a
  // total_count. If the planner tried to add one without it (e.g. "add some hard
  // problems"), ask instead of silently defaulting the count.
  const missingCount = (plan.actions ?? []).some((a) =>
    a.action === 'add_dost'
    && a.dost_type === 'practiceAssignment'
    && a?.params?.total_count == null
    && a?.params?.type_split == null,
  );
  if (missingCount) {
    const clarification = 'How many questions should the assignment have?';
    const examples = ['15 questions', '20, mostly numericals'];
    await JourneyDB.appendChat(sessionId, { role: 'copilot', content: clarification, examples, ts: nowIso() });
    return { type: 'ask', message: clarification, examples };
  }

  // [3] apply
  const updated = await applyActions(sessionId, journeyType, plan.actions ?? [], profile, journey);
  const finalJourney = (updated ?? doc).journeys.find((j) => j.type === journeyType);

  await JourneyDB.appendChat(sessionId, { role: 'copilot', content: plan.summary, ts: nowIso() });
  return { type: 'done', message: plan.summary || 'Done.', journey: finalJourney };
}

module.exports = { journeyCopilot };
