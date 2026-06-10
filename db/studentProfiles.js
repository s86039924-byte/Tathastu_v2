const StudentProfile = require('../models/StudentProfile');

const StudentProfileDB = {
  async save(studentId, sessionId, profile) {
    await StudentProfile.updateOne(
      { student_id: studentId, session_id: sessionId },
      { $set: { profile: profile ?? {} } },
      { upsert: true },
    );
    return profile;
  },

  async get(studentId, sessionId) {
    const row = await StudentProfile.findOne({ student_id: studentId, session_id: sessionId }).lean();
    return row?.profile ?? null;
  },
};

module.exports = { StudentProfileDB };
