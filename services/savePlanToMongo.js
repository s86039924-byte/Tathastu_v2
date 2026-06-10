const { SessionDB } = require('../db/sessions');
const { StudentProfileDB } = require('../db/studentProfiles');
const { JourneyDB } = require('../db/journeys');
const { generateThreeJourneys } = require('./generateThreeJourneys');

/**
 * Persist a completed plan to MongoDB: Session + StudentProfile + 3 Journeys.
 * Call AFTER the profile is built. Returns { session, journeys }.
 */
const savePlanToMongo = async ({
  studentId,
  mentorId = null,
  clientSessionUuid = null,
  originalQuery,
  enrichedQuery = '',
  conversationHistory = [],
  rankedResults = [],
  profile,
}) => {
  const session = await SessionDB.create({
    studentId, mentorId, originalQuery, enrichedQuery,
    followupQa: conversationHistory, rankedResults, clientSessionUuid,
  });

  await StudentProfileDB.save(studentId, session.session_id, profile);

  const journeys = await generateThreeJourneys({ profile });

  await JourneyDB.save(session.session_id, {
    student_id: studentId,
    mentor_id: mentorId,
    journeys,
  });

  return { session, journeys };
};

module.exports = { savePlanToMongo };
