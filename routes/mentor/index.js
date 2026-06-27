const { Router } = require('express');
const auth = require('../../middleware/auth.middleware');
const mentor = require('../../controllers/mentor.controller');

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

mentorRouter.get('/sessions/:sessionId/journeys', requireMentor, mentor.getJourneys);
mentorRouter.patch('/sessions/:sessionId/journeys/:type/dosts/:idx', requireMentor, mentor.editDostField);
mentorRouter.post('/sessions/:sessionId/journeys/:type/dosts/:idx/remove', requireMentor, mentor.removeDost);
mentorRouter.post('/sessions/:sessionId/journeys/:srcType/dosts/:idx/move', requireMentor, mentor.moveDost);
mentorRouter.post('/sessions/:sessionId/journeys/:type/select', requireMentor, mentor.selectJourney);
mentorRouter.post('/sessions/:sessionId/journeys/:type/send', requireMentor, mentor.sendJourney);
mentorRouter.post('/sessions/:sessionId/journeys/:type/copilot', requireMentor, mentor.copilot);

module.exports = { mentorRouter };
