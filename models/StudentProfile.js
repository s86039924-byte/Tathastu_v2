const mongoose = require('mongoose');

const StudentProfileSchema = new mongoose.Schema(
  {
    student_id: { type: String, required: true, index: true },
    session_id: { type: String, required: true, index: true },
    profile:    { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } },
);

StudentProfileSchema.index({ student_id: 1, session_id: 1 }, { unique: true });

module.exports = mongoose.model('StudentProfile', StudentProfileSchema);


