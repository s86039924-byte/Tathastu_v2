const mongoose = require('mongoose');

const JourneySchema = new mongoose.Schema(
  {
    session_id: { type: String, required: true, unique: true, index: true },
    student_id: { type: String, index: true },
    mentor_id:  { type: String, default: null, index: true },
    journeys:   { type: Array, default: [] },   // [{ type, dosts:[...], alignment_score, recommended_rank }]
    copilot_messages: { type: Array, default: [] },   // [{ role, content, examples?, ts }]
    copilot_pending:  { type: String, default: null }, // the clarification question awaiting an answer
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } },
);

module.exports = mongoose.model('Journey', JourneySchema, 'tathastujourney');
