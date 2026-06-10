const { Router } = require('express');
const auth = require('../../middleware/auth.middleware');
const { SessionDB } = require('../../db/sessions');
const { JourneyDB } = require('../../db/journeys');
const { StudentProfileDB } = require('../../db/studentProfiles');
const { callAcadzaApiForPayloads } = require('../../controllers/chanakya/integration');
const { journeyCopilot } = require('../../services/copilot');

const mentorRouter = Router();

const requireMentor = [
  auth,
  (req, res, next) => {
    if (req.user?.role !== 'teacher') {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    next();
  },
];

// shared: load session + ownership check
const loadSession = async (req, res) => {
  const session = await SessionDB.get(req.params.sessionId);
  if (!session) { res.status(404).json({ success: false, message: 'Session not found' }); return null; }
  const tokenUserId = req.user.id || req.user._id || req.user.userId || req.user.user_id;
  if (session.mentor_id && tokenUserId && String(session.mentor_id) !== String(tokenUserId)) {
    res.status(403).json({ success: false, message: 'Access denied' });
    return null;
  }
  return session;
};

// GET /mentor/sessions/:sessionId/journeys  → the 3 journey drafts
mentorRouter.get('/sessions/:sessionId/journeys', requireMentor, async (req, res) => {
  try {
    const session = await SessionDB.get(req.params.sessionId);
    if (!session) return res.status(404).json({ success: false, message: 'Session not found' });

    const tokenUserId = req.user.id || req.user._id || req.user.userId || req.user.user_id;
    if (session.mentor_id && tokenUserId && String(session.mentor_id) !== String(tokenUserId)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const doc = await JourneyDB.get(session.session_id);
    if (!doc) return res.status(404).json({ success: false, message: 'No journeys found' });

    const profile = await StudentProfileDB.get(session.student_id, session.session_id);

    return res.status(200).json({ success: true, session, journeys: doc.journeys, profile });
  } catch (err) {
    console.error('get journeys error:', err);
    return res.status(500).json({ success: false, message: 'Server Error', error: err.message });
  }
});

// EDIT a card field
mentorRouter.patch('/sessions/:sessionId/journeys/:type/dosts/:idx', requireMentor, async (req, res) => {
  try {
    const session = await loadSession(req, res); if (!session) return;
    const { field, value } = req.body ?? {};
    if (!field || typeof field !== 'string') {
      return res.status(400).json({ success: false, message: 'field (string) is required' });
    }
    const updated = await JourneyDB.updateDostPayload(
      session.session_id, req.params.type, Number(req.params.idx), field, value,
    );
    if (!updated) return res.status(404).json({ success: false, message: 'Journey or card not found' });
    return res.json({ success: true, journeys: updated.journeys });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server Error', error: err.message });
  }
});

// REMOVE a card
mentorRouter.post('/sessions/:sessionId/journeys/:type/dosts/:idx/remove', requireMentor, async (req, res) => {
  try {
    const session = await loadSession(req, res); if (!session) return;
    const updated = await JourneyDB.removeDost(session.session_id, req.params.type, Number(req.params.idx));
    if (!updated) return res.status(404).json({ success: false, message: 'Journey or card not found' });
    return res.json({ success: true, journeys: updated.journeys });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server Error', error: err.message });
  }
});

// MOVE a card to another journey   body: { destType }
mentorRouter.post('/sessions/:sessionId/journeys/:srcType/dosts/:idx/move', requireMentor, async (req, res) => {
  try {
    const session = await loadSession(req, res); if (!session) return;
    const { destType } = req.body ?? {};
    if (!destType) return res.status(400).json({ success: false, message: 'destType is required' });
    const updated = await JourneyDB.moveDost(session.session_id, req.params.srcType, destType, Number(req.params.idx));
    if (!updated) return res.status(404).json({ success: false, message: 'Journey or card not found' });
    return res.json({ success: true, journeys: updated.journeys });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server Error', error: err.message });
  }
});

// SELECT the final journey
mentorRouter.post('/sessions/:sessionId/journeys/:type/select', requireMentor, async (req, res) => {
  try {
    const session = await loadSession(req, res); if (!session) return;
    const updated = await JourneyDB.selectJourney(session.session_id, req.params.type);
    if (!updated) return res.status(404).json({ success: false, message: 'Journey not found' });
    return res.json({ success: true, journeys: updated.journeys });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server Error', error: err.message });
  }
});

// SEND a journey → create DOSTs on Acadza (mock if ACADZA_MOCK_MODE=true)
mentorRouter.post('/sessions/:sessionId/journeys/:type/send', requireMentor, async (req, res) => {
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

    // 1) call Acadza for each card's payload (mock or real, per ACADZA_MOCK_MODE)
    const payloads = journey.dosts.map((d) => d.payload);
    const results = await callAcadzaApiForPayloads(payloads, {
      mockMode: process.env.ACADZA_MOCK_MODE === 'true',
    });

    // 2) persist results back onto the cards + mark journey sent
    const updated = await JourneyDB.recordSendResults(session.session_id, req.params.type, results);

    // 3) mark this journey as the selected/final one too
    await JourneyDB.selectJourney(session.session_id, req.params.type);

    const sentJourney = updated.journeys.find((j) => j.type === req.params.type);
    return res.status(200).json({
      success: true,
      message: 'Journey sent',
      journey: sentJourney,
    });
  } catch (err) {
    console.error('send journey error:', err);
    return res.status(500).json({ success: false, message: 'Server Error', error: err.message });
  }
});

// COPILOT — natural-language journey edits
mentorRouter.post('/sessions/:sessionId/journeys/:type/copilot', requireMentor, async (req, res) => {
  try {
    const session = await loadSession(req, res); if (!session) return;
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
});

module.exports = { mentorRouter };
