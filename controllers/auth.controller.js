const bcrypt = require('bcryptjs');
const User = require('../models/User');
const { generateToken } = require('../utils/jwt');

const { savePlanToMongo } = require('../services/savePlanToMongo');

const {
  guardrailCheck,
  detectIntent,
  explainConcept,
  extractSignalsFromQuery,
  getNextQuestionOrStop,
  buildSearchQueries,
} = require('./openaiPipeline');

const { runSearchPipeline } = require('./search');

const {
  getPriorChaptersForSubject,
  buildStudentProfile,
} = require('./profileBuilder');

const { randomUUID } = require('crypto');

const {
  saveRuntimeFollowup,
  getRuntimeFollowup,
  deleteRuntimeFollowup,
} = require('./runtimeFollowupStore');

const REQUIRED_SLOTS_MISSING_MSG =
  'I need a bit more clarity to help you properly. ' +
  'Please start a new session and describe your doubt in more detail — ' +
  'mention the specific topic, what you tried, and what confused you.';

const runPlanFlow = async ({
  studentId,
  originalQuery,
  conversationHistory,
  collected,
  priorSignals,
}) => {
  const searchVariants = await buildSearchQueries(
    originalQuery,
    conversationHistory,
  );

  console.log('Search query variants:', searchVariants);

  const forcedSubject =
    collected?.subject || priorSignals?.subject || null;

  const searchResult = await runSearchPipeline(
    searchVariants,
    undefined,
    undefined,
    undefined,
    forcedSubject,
  );

  console.log('Search pipeline result:', {
    forcedSubject,
    rankedCount: searchResult.rankedResults.length,
    treeSubjects: Object.keys(searchResult.tree),
  });

  const profile = await buildStudentProfile({
    studentId,
    sessionId: '',
    originalQuery,
    conversationHistory,
    rankedResults: searchResult.rankedResults,
    collectedFollowupData: collected,
    queryClassification: null,
    ragResult: null,
  });

  console.log('Student profile built:', {
    detected_subject: profile.detected_subject,
    detected_topic: profile.detected_topic,
    topicsCount: profile.topics.length,
  });

  return {
    searchVariants,
    searchResult,
    profile,
  };
};

exports.register = async (req, res) => {
  try {
    const { name, phone, password, role, meta } = req.body;

    const existing = await User.findOne({ phone });

    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'User already exists',
      });
    }

    const hashed = await bcrypt.hash(password, 10);

    const user = await User.create({
      name,
      phone,
      password: hashed,
      role,
      meta,
    });

    const token = generateToken(user);

    return res.status(201).json({
      success: true,
      token,
      user,
    });
  } catch (e) {
    console.error('register error:', e);

    return res.status(500).json({
      success: false,
      message: 'Server Error',
    });
  }
};

exports.login = async (req, res) => {
  try {
    const { phone, password } = req.body;

    const user = await User.findOne({ phone });

    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials',
      });
    }

    const ok = await bcrypt.compare(password, user.password);

    if (!ok) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials',
      });
    }

    const token = generateToken(user);

    return res.json({
      success: true,
      token,
      user,
    });
  } catch (e) {
    console.error('login error:', e);

    return res.status(500).json({
      success: false,
      message: 'Server Error',
    });
  }
};

// POST /mentor/register — teacher/mentor signup
exports.registerMentor = async (req, res) => {
  try {
    const { name, phone, password, meta } = req.body;

    if (!name || !phone || !password) {
      return res.status(400).json({
        success: false,
        message: 'name, phone and password are required',
      });
    }

    const existing = await User.findOne({ phone });

    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'User already exists',
      });
    }

    const hashed = await bcrypt.hash(password, 10);

    const user = await User.create({
      name,
      phone,
      password: hashed,
      role: 'teacher',
      meta,
    });

    const token = generateToken(user);

    return res.status(201).json({
      success: true,
      token,
      user,
    });
  } catch (e) {
    console.error('registerMentor error:', e);

    return res.status(500).json({
      success: false,
      message: 'Server Error',
    });
  }
};

// POST /mentor/login — teacher/mentor login (rejects non-teachers)
exports.loginMentor = async (req, res) => {
  try {
    const { phone, password } = req.body;

    const user = await User.findOne({ phone });

    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials',
      });
    }

    const ok = await bcrypt.compare(password, user.password);

    if (!ok) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials',
      });
    }

    if (user.role !== 'teacher') {
      return res.status(403).json({
        success: false,
        message: 'Not a mentor account',
      });
    }

    const token = generateToken(user);

    return res.json({
      success: true,
      token,
      user,
    });
  } catch (e) {
    console.error('loginMentor error:', e);

    return res.status(500).json({
      success: false,
      message: 'Server Error',
    });
  }
};

// GET /users?role=student
exports.getAllUsers = async (req, res) => {
  try {
    const { role } = req.query;

    const filter = {};

    if (role) {
      filter.role = role;
    }

    const users = await User.find(filter)
      .select('-password')
      .sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      role: role || 'all',
      totalUsers: users.length,
      users,
    });
  } catch (e) {
    console.error('getAllUsers error:', e);

    return res.status(500).json({
      success: false,
      message: 'Server Error',
    });
  }
};

// GET /mentors — public list of mentors for students to choose from (NO phone)
exports.getMentors = async (req, res) => {
  try {
    const mentors = await User.find({ role: 'teacher' })
      .select('name meta createdAt')
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      count: mentors.length,
      mentors: mentors.map((m) => ({
        mentor_id: m._id,     // pass this as mentorId in process-query
        name: m.name,
        meta: m.meta ?? {},   // e.g. subject/expertise if you store it
      })),
    });
  } catch (e) {
    console.error('getMentors error:', e);
    return res.status(500).json({ success: false, message: 'Server Error' });
  }
};

// POST /process-query
exports.processQuery = async (req, res) => {
  try {
    const query = req.body.query;
    const studentId = req.body.studentId || req.body.student_id || 'demo-student';
    const mentorId = req.body.mentorId || req.body.mentor_id || null;
    const clientSessionUuid =
      req.body.clientSessionUuid || req.body.client_session_uuid || null;

    if (!query || !query.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Query is required',
      });
    }

    console.log('Incoming query:', query);
    console.log('Student ID:', studentId);

    // 1. Guardrail check
    const guardrailResult = await guardrailCheck(query);

    const allowed = guardrailResult[0];
    const guardrailMessage = guardrailResult[1];

    console.log('Guardrail response:', guardrailResult);

    if (!allowed) {
      return res.status(200).json({
        success: true,
        status: 'blocked',
        query,
        guardrail: {
          allowed: false,
          message: guardrailMessage,
        },
        response: {
          text: guardrailMessage,
        },
      });
    }

    // 2. Intent check
    const [intent, concept] = await detectIntent(query);

    console.log('Intent response:', {
      intent,
      concept,
    });

    // 3. If intent is EXPLAIN
    if (intent === 'EXPLAIN') {
      const explanation = await explainConcept(query, concept);

      return res.status(200).json({
        success: true,
        status: 'explain',
        query,
        studentId,
        guardrail: {
          allowed: true,
          message: '',
        },
        intent,
        concept: concept ?? query,
        response: {
          status: 'explain',
          concept: concept ?? query,
          text: explanation,
        },
      });
    }

    // 4. If intent is SEARCH, extract signals
    const priorSignals = await extractSignalsFromQuery(query);

    console.log('Prior signals:', priorSignals);

    const priorChapters = await getPriorChaptersForSubject(
      studentId,
      priorSignals.subject,
    );

    console.log('Prior chapters:', priorChapters);

    // 5. Check if enough data exists
    const {
      enough,
      nextQuestion,
      focus,
      collected,
      closingNote,
    } = await getNextQuestionOrStop(
      query,
      [],
      priorSignals ?? null,
      priorChapters ?? null,
    );

    console.log('Followup kickoff response:', {
      enough,
      nextQuestion,
      focus,
      collected,
      closingNote,
    });

    // 6. If enough data already exists, continue direct plan flow
    if (enough) {
      const requiredOk =
        Boolean(collected) &&
        Boolean(collected.subject) &&
        Boolean(collected.topic) &&
        Boolean(collected.struggle_area);

      if (!requiredOk) {
        return res.status(200).json({
          success: true,
          status: 'blocked',
          reason: REQUIRED_SLOTS_MISSING_MSG,
          response: {
            status: 'blocked',
            reason: REQUIRED_SLOTS_MISSING_MSG,
          },
        });
      }

      const {
        searchVariants,
        searchResult,
        profile,
      } = await runPlanFlow({
        studentId,
        originalQuery: query,
        conversationHistory: [],
        collected,
        priorSignals,
      });

      const saved = await savePlanToMongo({
        studentId,
        mentorId,
        clientSessionUuid,
        originalQuery: query,
        enrichedQuery: searchVariants.join(' | '),
        conversationHistory: [],
        rankedResults: searchResult.rankedResults,
        profile,
      });

      return res.status(200).json({
        success: true,
        status: 'journeys_ready',
        query,
        studentId,
        session_id: saved.session.session_id,
        session: saved.session,
        tathastujourney: saved.journeys,
        guardrail: {
          allowed: true,
          message: '',
        },
        intent,
        concept,
        priorSignals,
        priorChapters,
        collected,
        closingNote,
        searchVariants,
        profile,
        response: {
          status: 'journeys_ready',
          message: 'Profile built, 3 journeys generated, and saved to MongoDB.',
          session_id: saved.session.session_id,
          session: saved.session,
          tathastujourney: saved.journeys,
          closingNote,
          profile,
        },
      });
    }

    // 7. If follow-up is needed, save in runtime memory
    const tempSessionId = randomUUID();

    console.log('Saving follow-up session:', {
      tempSessionId,
      studentId,
      originalQuery: query,
    });

    await saveRuntimeFollowup(tempSessionId, {
      original_query: query,
      history: [],
      student_id: studentId,
      mentor_id: mentorId,
      client_session_uuid: clientSessionUuid,
      prior_signals: priorSignals,
      prior_chapters: priorChapters,
      pending_focus: focus,
      pending_question: nextQuestion,   // remember the question we asked
    });

    console.log('Follow-up session saved successfully');

    return res.status(200).json({
      success: true,
      status: 'followup_needed',
      query,
      studentId,
      temp_session_id: tempSessionId,
      guardrail: {
        allowed: true,
        message: '',
      },
      intent,
      concept,
      priorSignals,
      priorChapters,
      response: {
        status: 'followup_needed',
        temp_session_id: tempSessionId,
        question: nextQuestion,
        focus,
      },
    });
  } catch (err) {
    console.error('processQuery error:', err);

    return res.status(500).json({
      success: false,
      message: 'Server Error',
      error: err.message,
    });
  }
};

// POST /continue-followup
exports.continueFollowup = async (req, res) => {
  try {
    const tempSessionId =
      req.body.temp_session_id ||
      req.body.tempSessionId;

    const answer = req.body.answer;
    const question = req.body.question;

    if (!tempSessionId) {
      return res.status(400).json({
        success: false,
        message: 'temp_session_id is required',
      });
    }

    if (!answer || !answer.trim()) {
      return res.status(400).json({
        success: false,
        message: 'answer is required',
      });
    }

    console.log('Follow-up temp session:', tempSessionId);
    console.log('Follow-up answer:', answer);

    // 1. Get follow-up state from runtime memory
    const state = await getRuntimeFollowup(tempSessionId);

    if (!state) {
      return res.status(404).json({
        success: false,
        message: 'Follow-up session not found or expired',
      });
    }

    const pendingFocus = state.pending_focus ?? null;

    state.history = Array.isArray(state.history) ? state.history : [];

    // 2. Add current answer to history.
    //    If the client didn't echo the question, fall back to the one the
    //    server actually asked (pending_question) so history stays complete.
    state.history.push({
      q: question || state.pending_question || '',
      a: answer.trim() || 'not specified',
      focus: pendingFocus,
    });

    await saveRuntimeFollowup(tempSessionId, state);

    console.log('Updated follow-up history:', state.history);

    // 3. Check whether enough data is collected
    const {
      enough,
      nextQuestion,
      focus,
      collected,
      closingNote,
    } = await getNextQuestionOrStop(
      state.original_query,
      state.history,
      state.prior_signals ?? null,
      state.prior_chapters ?? null,
    );

    console.log('Follow-up continuation response:', {
      enough,
      nextQuestion,
      focus,
      collected,
      closingNote,
    });

    // 4. Update pending focus + remember the next question we're about to ask
    state.pending_focus = enough ? null : focus ?? null;
    state.pending_question = enough ? null : nextQuestion ?? null;

    await saveRuntimeFollowup(tempSessionId, state);

    // 5. If still not enough, return next follow-up question
    if (!enough && nextQuestion) {
      return res.status(200).json({
        success: true,
        status: 'followup_needed',
        temp_session_id: tempSessionId,
        response: {
          status: 'followup_needed',
          temp_session_id: tempSessionId,
          question: nextQuestion,
          focus,
        },
      });
    }

    // 6. If enough=true, continue direct plan flow
    if (enough) {
      const requiredOk =
        Boolean(collected) &&
        Boolean(collected.subject) &&
        Boolean(collected.topic) &&
        Boolean(collected.struggle_area);

      if (!requiredOk) {
        await deleteRuntimeFollowup(tempSessionId);

        return res.status(200).json({
          success: true,
          status: 'blocked',
          reason: REQUIRED_SLOTS_MISSING_MSG,
          response: {
            status: 'blocked',
            reason: REQUIRED_SLOTS_MISSING_MSG,
          },
        });
      }

      const {
        searchVariants,
        searchResult,
        profile,
      } = await runPlanFlow({
        studentId: state.student_id,
        originalQuery: state.original_query,
        conversationHistory: state.history,
        collected,
        priorSignals: state.prior_signals,
      });

      const saved = await savePlanToMongo({
        studentId: state.student_id,
        mentorId: state.mentor_id,
        clientSessionUuid: state.client_session_uuid,
        originalQuery: state.original_query,
        enrichedQuery: searchVariants.join(' | '),
        conversationHistory: state.history,
        rankedResults: searchResult.rankedResults,
        profile,
      });

      // Delete runtime follow-up session after completion
      await deleteRuntimeFollowup(tempSessionId);

      return res.status(200).json({
        success: true,
        status: 'journeys_ready',
        temp_session_id: tempSessionId,
        session_id: saved.session.session_id,
        session: saved.session,
        tathastujourney: saved.journeys,
        collected,
        closingNote,
        searchVariants,
        profile,
        response: {
          status: 'journeys_ready',
          message: 'Profile built, 3 journeys generated, and saved to MongoDB.',
          session_id: saved.session.session_id,
          session: saved.session,
          tathastujourney: saved.journeys,
          closingNote,
          profile,
        },
      });
    }

    return res.status(200).json({
      success: true,
      status: 'unknown',
      message: 'Follow-up processed, but no next action was found.',
    });
  } catch (err) {
    console.error('continueFollowup error:', err);

    return res.status(500).json({
      success: false,
      message: 'Server Error',
      error: err.message,
    });
  }
};