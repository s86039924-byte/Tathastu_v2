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
  const pending = doc.copilot_pending || null;   // outstanding clarification, if any

  // [1] PLAN — planner sees the pending question and decides:
  //     answer the pending request, OR treat this as a new request (mode switch).
  const plan = await callPlanner({ journey, mentorMessage: message, chatHistory: chat, pending });

  // log the mentor turn
  await JourneyDB.appendChat(sessionId, { role: 'mentor', content: message, ts: nowIso() });

  // [2] slot-filling: not enough info → ask (and REMEMBER the question)
  if (plan.needs_clarification) {
    await JourneyDB.setCopilotPending(sessionId, plan.clarification || 'Could you clarify?');
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
    await JourneyDB.setCopilotPending(sessionId, clarification);
    await JourneyDB.appendChat(sessionId, { role: 'copilot', content: clarification, examples, ts: nowIso() });
    return { type: 'ask', message: clarification, examples };
  }

  // [3] resolved (answered the pending request OR a new request) → clear pending, apply
  await JourneyDB.setCopilotPending(sessionId, null);
  const updated = await applyActions(sessionId, journeyType, plan.actions ?? [], profile, journey);
  const finalJourney = (updated ?? doc).journeys.find((j) => j.type === journeyType);

  await JourneyDB.appendChat(sessionId, { role: 'copilot', content: plan.summary, ts: nowIso() });
  return { type: 'done', message: plan.summary || 'Done.', tathastujourney: finalJourney };
}

module.exports = { journeyCopilot };
