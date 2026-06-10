const { Router } = require('express');
const auth = require('../../middleware/auth.middleware');
const { SessionDB } = require('../../db/sessions');
const { JourneyDB } = require('../../db/journeys');

const studentRouter = Router();

const requireStudent = [
  auth,
  (req, res, next) => {
    if (req.user?.role !== 'student') {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    next();
  },
];

const tokenId = (req) =>
  req.user.id || req.user._id || req.user.userId || req.user.user_id;

// GET /student/sessions  → list the student's own sessions
studentRouter.get('/sessions', requireStudent, async (req, res) => {
  try {
    const sessions = await SessionDB.listForStudent(tokenId(req));
    return res.status(200).json({
      success: true,
      sessions: sessions.map((s) => ({
        session_id: s.session_id,
        original_query: s.original_query,
        status: s.status,
        created_at: s.created_at,
      })),
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server Error', error: err.message });
  }
});

// GET /student/sessions/:sessionId/plan  → the SENT journey (the student's plan)
studentRouter.get('/sessions/:sessionId/plan', requireStudent, async (req, res) => {
  try {
    const session = await SessionDB.get(req.params.sessionId);
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found' });
    }
    // ownership — students can only see their own
    if (String(session.student_id) !== String(tokenId(req))) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const doc = await JourneyDB.get(session.session_id);
    if (!doc) {
      return res.status(404).json({ success: false, message: 'Plan not ready yet' });
    }

    // the plan the student sees = the SENT journey (fallback to selected)
    const plan =
      doc.journeys.find((j) => j.sent) ||
      doc.journeys.find((j) => j.selected);

    if (!plan) {
      return res.status(200).json({
        success: true,
        status: 'pending',
        message: 'Your mentor is still preparing your plan.',
      });
    }

    // expose ONLY public fields — no internal payload/original_payload
    return res.status(200).json({
      success: true,
      status: 'ready',
      session_id: session.session_id,
      query: session.original_query,
      plan: {
        type: plan.type,
        items: (plan.dosts ?? [])
          .filter((d) => d.success)        // only successfully-created DOSTs
          .map((d) => ({
            dost_type: d.dost_type,
            title: d.title,
            link: d.link,                  // ← the Acadza resource the student opens
            dost_id: d.dost_id,
          })),
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server Error', error: err.message });
  }
});

module.exports = { studentRouter };
