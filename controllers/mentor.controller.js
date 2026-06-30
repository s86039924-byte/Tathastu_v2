const { SessionDB } = require('../db/sessions');
const { JourneyDB } = require('../db/journeys');
const { StudentProfileDB } = require('../db/studentProfiles');
const { callAcadzaApiForPayloads } = require('./chanakya/integration');
const { journeyCopilot } = require('../services/copilot');
const User = require('../models/User');

// load session + ownership check.
// On failure it sends the error response itself and returns null.
const loadSession = async (req, res) => {
  const session = await SessionDB.get(req.params.sessionId);
  if (!session) {
    res.status(404).json({ success: false, message: 'Session not found' });
    return null;
  }
  const tokenUserId = req.user.id || req.user._id || req.user.userId || req.user.user_id;
  if (session.mentor_id && tokenUserId && String(session.mentor_id) !== String(tokenUserId)) {
    res.status(403).json({ success: false, message: 'Access denied' });
    return null;
  }
  return session;
};

// GET /mentor/sessions  → sessions assigned to THIS teacher (mentor_id === token id)
exports.listSessions = async (req, res) => {
  try {
    const teacherId = req.user.id || req.user._id || req.user.userId || req.user.user_id;
    const sessions = await SessionDB.listForMentor(teacherId);

    // join student NAME only (no phone) — skip student_ids that aren't real user _ids
    const ids = [...new Set(
      sessions.map((s) => String(s.student_id)).filter((id) => /^[0-9a-fA-F]{24}$/.test(id)),
    )];
    const users = ids.length
      ? await User.find({ _id: { $in: ids } }).select('name').lean()
      : [];
    const nameById = {};
    users.forEach((u) => { nameById[String(u._id)] = u.name; });

    return res.status(200).json({
      success: true,
      count: sessions.length,
      sessions: sessions.map((s) => ({
        session_id: s.session_id,
        student_id: s.student_id,
        student_name: nameById[String(s.student_id)] ?? null,
        original_query: s.original_query,
        status: s.status,
        mentorApproved: Boolean(s.mentor_approved),
        created_at: s.created_at,
      })),
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server Error', error: err.message });
  }
};

// GET /mentor/sessions/:sessionId/journeys  → the 3 journey drafts
exports.getJourneys = async (req, res) => {
  try {
    const session = await loadSession(req, res);
    if (!session) return;

    const doc = await JourneyDB.get(session.session_id);
    if (!doc) return res.status(404).json({ success: false, message: 'No journeys found' });

    const profile = await StudentProfileDB.get(session.student_id, session.session_id);

    return res.status(200).json({ success: true, session, tathastujourney: doc.journeys, profile });
  } catch (err) {
    console.error('get journeys error:', err);
    return res.status(500).json({ success: false, message: 'Server Error', error: err.message });
  }
};

// PATCH /mentor/sessions/:sessionId/journeys/:type/dosts/:idx  → edit a card field
exports.editDostField = async (req, res) => {
  try {
    const session = await loadSession(req, res);
    if (!session) return;
    const { field, value } = req.body ?? {};
    if (!field || typeof field !== 'string') {
      return res.status(400).json({ success: false, message: 'field (string) is required' });
    }
    const updated = await JourneyDB.updateDostPayload(
      session.session_id, req.params.type, Number(req.params.idx), field, value,
    );
    if (!updated) return res.status(404).json({ success: false, message: 'Journey or card not found' });
    return res.json({ success: true, tathastujourney: updated.journeys });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server Error', error: err.message });
  }
};

// POST .../dosts/:idx/remove  → remove a card
exports.removeDost = async (req, res) => {
  try {
    const session = await loadSession(req, res);
    if (!session) return;
    const updated = await JourneyDB.removeDost(session.session_id, req.params.type, Number(req.params.idx));
    if (!updated) return res.status(404).json({ success: false, message: 'Journey or card not found' });
    return res.json({ success: true, tathastujourney: updated.journeys });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server Error', error: err.message });
  }
};

// POST .../dosts/:idx/move  body: { destType }  → move a card to another journey
exports.moveDost = async (req, res) => {
  try {
    const session = await loadSession(req, res);
    if (!session) return;
    const { destType } = req.body ?? {};
    if (!destType) return res.status(400).json({ success: false, message: 'destType is required' });
    const updated = await JourneyDB.moveDost(session.session_id, req.params.srcType, destType, Number(req.params.idx));
    if (!updated) return res.status(404).json({ success: false, message: 'Journey or card not found' });
    return res.json({ success: true, tathastujourney: updated.journeys });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server Error', error: err.message });
  }
};

// POST .../:type/select  → mark a journey as the chosen final plan
exports.selectJourney = async (req, res) => {
  try {
    const session = await loadSession(req, res);
    if (!session) return;
    const updated = await JourneyDB.selectJourney(session.session_id, req.params.type);
    if (!updated) return res.status(404).json({ success: false, message: 'Journey not found' });
    return res.json({ success: true, tathastujourney: updated.journeys });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server Error', error: err.message });
  }
};

// POST .../:type/send  → create DOSTs on Acadza (real API)
exports.sendJourney = async (req, res) => {
  try {
    const session = await loadSession(req, res);
    if (!session) return;

    const doc = await JourneyDB.get(session.session_id);
    if (!doc) return res.status(404).json({ success: false, message: 'No journeys found' });

    const journey = doc.journeys.find((j) => j.type === req.params.type);
    if (!journey) return res.status(404).json({ success: false, message: 'Journey not found' });
    if (!journey.dosts?.length) {
      return res.status(400).json({ success: false, message: 'Journey has no cards to send' });
    }

    // 1) call the real Acadza API for each card's payload
    const payloads = journey.dosts.map((d) => d.payload);
    const results = await callAcadzaApiForPayloads(payloads);

    // 2) persist results back onto the cards + mark journey sent
    const updated = await JourneyDB.recordSendResults(session.session_id, req.params.type, results);

    // 3) mark this journey as the selected/final one too
    await JourneyDB.selectJourney(session.session_id, req.params.type);

    // 4) mentor sending = mentor approval → student can see it
    await SessionDB.setMentorApproved(session.session_id, true);

    const sentJourney = updated.journeys.find((j) => j.type === req.params.type);
    return res.status(200).json({ success: true, message: 'Journey sent', mentorApproved: true, tathastujourney: sentJourney });
  } catch (err) {
    console.error('send journey error:', err);
    return res.status(500).json({ success: false, message: 'Server Error', error: err.message });
  }
};

// POST .../:type/copilot  → natural-language journey edits
exports.copilot = async (req, res) => {
  try {
    const session = await loadSession(req, res);
    if (!session) return;
    const { message } = req.body ?? {};
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ success: false, message: 'message (string) is required' });
    }
    const result = await journeyCopilot({
      sessionId: session.session_id, journeyType: req.params.type, message,
    });
    return res.status(200).json({ success: true, ...result });
  } catch (err) {
    console.error('copilot error:', err);
    return res.status(500).json({ success: false, message: 'Server Error', error: err.message });
  }
};
