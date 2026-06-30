const mongoose = require('mongoose');

const SessionSchema = new mongoose.Schema(
  {
    session_id:          { type: String, required: true, unique: true, index: true },
    student_id:          { type: String, required: true, index: true },
    mentor_id:           { type: String, default: null, index: true },
    original_query:      { type: String, required: true },
    enriched_query:      { type: String, default: '' },
    followup_qa:         { type: Array, default: [] },
    ranked_results:      { type: Array, default: [] },
    client_session_uuid: { type: String, default: null },
    status:              { type: String, default: 'pending', index: true },
    mentor_approved:     { type: Boolean, default: false },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } },
);

module.exports = mongoose.model('Session', SessionSchema);
