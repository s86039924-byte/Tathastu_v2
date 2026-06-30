const { randomUUID } = require('crypto');
const Session = require('../models/Session');

const newId = () => randomUUID().replace(/-/g, '').slice(0, 8);

const SessionDB = {
  async create(args) {
    const doc = await Session.create({
      session_id: newId(),
      student_id: args.studentId,
      mentor_id: args.mentorId ?? null,
      original_query: args.originalQuery,
      enriched_query: args.enrichedQuery ?? '',
      followup_qa: args.followupQa ?? [],
      ranked_results: args.rankedResults ?? [],
      client_session_uuid: args.clientSessionUuid ?? null,
      status: 'pending',
    });
    return doc.toObject();
  },

  async get(sessionId) {
    return Session.findOne({ session_id: sessionId }).lean();
  },

  async listForStudent(studentId) {
    return Session.find({ student_id: studentId })
      .sort({ created_at: -1 })
      .lean();
  },

  async listForMentor(mentorId) {
    return Session.find({ mentor_id: mentorId })
      .sort({ created_at: -1 })
      .lean();
  },

  async setMentorApproved(sessionId, approved) {
    return Session.findOneAndUpdate(
      { session_id: sessionId },
      { $set: { mentor_approved: Boolean(approved) } },
      { new: true },
    ).lean();
  },
};

module.exports = { SessionDB };
