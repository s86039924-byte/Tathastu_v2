const { getOpenAI } = require('../../config/openai');

const MODEL = 'gpt-4o-mini';

const SYSTEM = `
You are the Journey Copilot Planner for a mentor tool. The mentor edits a student's
study "journey" (a list of DOST cards). Read the mentor's message, the current journey,
and the chat so far. Output ONE strict JSON object with a LIST of actions to perform —
OR a clarifying question if any required info is missing. NEVER invent values.

INPUT:
- journey: { type, subject, chapter, dosts:[{ index, dost_type, payload }] }
- mentor_message
- chat_history

DOST TYPES + REQUIRED params:
- practiceAssignment : difficulty(easy|moderate|hard), total_count(int = total number of questions).
                       OPTIONAL qtype_hint(free text, e.g. "mostly numericals", "conceptual").
                       Do NOT ask for or emit a per-type scq/mcq/integer breakdown — the system
                       derives it from total_count (+ qtype_hint if given).
- practiceTest       : difficulty, duration_minutes(int), paperPattern(default "Mains")
- concept            : concepts (names) — needs concept search if mentor named one
- formula            : (chapter only)
- revision           : allotedDay(int), daywiseTimePerPortion(minutes int)
- clickingPower      : totalQuestions(int)
- pickingPower       : (chapter only)
- speedRace          : totalQuestions(int)

ACTIONS (each item in "actions"):
- add_dost        {dost_type, params, needs_concept_search, concept_query}
- remove_dost     {target_index}
- move_dost       {target_index, dest_type}
- reorder_dost    {target_index, to_index}
- edit_field      {target_index, field, value}     // field: difficulty|total_count|qtype_hint|duration_minutes|isNCERT|paperPattern|allotedDay|daywiseTimePerPortion|totalQuestions
- add_portion     {target_index, needs_concept_search, concept_query}   // add concept(s) INSIDE an existing card
- remove_portion  {target_index, portion_index}
- none

RULES:
1. Decompose compound requests into MULTIPLE actions ("add a test and make the assignment hard" -> 2 actions). "make everything harder" -> one edit_field per applicable card.
2. If a REQUIRED value is missing -> set "needs_clarification": true, describe the gap, write a friendly "clarification" + 1-2 "examples". Do NOT emit those actions.
   - For practiceAssignment, the ONLY count you need is total_count. If it is missing -> ask, with examples like "15 questions" or "20, mostly numericals". NEVER ask for the scq/mcq/integer breakdown.
   - If the mentor mentions a question-type preference ("mostly numericals", "more conceptual"), put it in qtype_hint; do not treat its absence as missing info.
3. If an action references a concept named in words -> set needs_concept_search:true and put the phrase in concept_query. Do NOT invent concept names.
4. Normalise difficulty: hard/tough->hard, medium->moderate, easy/basic->easy.
5. target_index refers to journey.dosts index. Resolve "the test"/"the assignment" by dost_type.
6. PENDING CLARIFICATION: if a PENDING_QUESTION is shown below, you asked it earlier and are awaiting an answer.
   - If the mentor's message ANSWERS it, use the CHAT history to COMPLETE the original request — emit the real actions, do NOT re-ask.
   - If the message is a NEW/different instruction (a "mode switch"), DROP the pending question and handle the new instruction fresh.
7. Output JSON ONLY.

OUTPUT:
{
  "actions": [ { "action": "...", ...fields } ],
  "needs_clarification": false,
  "clarification": "",
  "examples": [],
  "summary": ""
}
`;

async function callPlanner({ journey, mentorMessage, chatHistory = [], pending = null }) {
  // Send ONLY the knobs the planner reasons about — never full payloads
  // (practicePortion/formulaCart/original_payload). Keeps input ~300 tokens, not 5-10k.
  const slim = {
    type: journey.type,
    subject: journey.subject ?? journey.dosts?.[0]?.payload?.practicePortion?.[0]?.content?.subject ?? '',
    chapter: journey.chapter ?? journey.dosts?.[0]?.payload?.meta?.chapter ?? '',
    dosts: (journey.dosts ?? []).map((d) => ({
      index: d.index,
      dost_type: d.dost_type,
      title: d.title,
      level: d.payload?.level,
      count: d.payload?.assignmentQuesCount,
      minutes: d.payload?.noOfMinutes,
      portion_size: d.payload?.practicePortion?.length
        ?? d.payload?.formulaCart?.length
        ?? d.payload?.meta?.conceptBasketData?.length,
    })),
  };
  const pendingBlock = pending ? `\n\nPENDING_QUESTION (awaiting the mentor's answer): "${pending}"` : '';
  const user = `JOURNEY:\n${JSON.stringify(slim)}\n\nCHAT:\n${JSON.stringify(chatHistory.slice(-6))}${pendingBlock}\n\nMENTOR MESSAGE:\n"${mentorMessage}"`;

  const resp = await getOpenAI().createChatCompletion(
    {
      model: MODEL,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }],
    },
    { timeout: 60000 },
  );

  try {
    return JSON.parse(resp.data.choices[0]?.message?.content ?? '{}');
  } catch {
    return { actions: [], needs_clarification: false, summary: 'parse error' };
  }
}

module.exports = { callPlanner };
