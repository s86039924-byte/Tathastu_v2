const { Router } = require('express');
const auth = require('../../middleware/auth.middleware');
const student = require('../../controllers/student.controller');

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

studentRouter.get('/sessions', requireStudent, student.listSessions);
studentRouter.get('/sessions/:sessionId/plan', requireStudent, student.getPlan);
studentRouter.get('/sessions/:sessionId/journey', requireStudent, student.getJourney);

module.exports = { studentRouter };
