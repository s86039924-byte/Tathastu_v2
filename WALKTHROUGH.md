# Tathastu Backend — File-by-File Walkthrough

A guided tour in the order data actually flows. Use this to explain the system end to end.

## The one-sentence story
A student asks a doubt → the system builds a profile and generates **3 study journeys** →
a mentor reviews/edits them (manually or via an AI copilot) → mentor **sends** the chosen journey,
creating real resources on Acadza → the student sees their final plan.

---

## PART 1 — Bootstrap

- **`app.js`** — entry point. Loads `.env`, creates Express, enables CORS + JSON, calls `connectDB()`,
  then `app.listen()`. Mounts 3 routers: `/api/auth`, `/mentor`, `/student`.
- **`config/db.js`** — `connectDB()` opens the Mongoose connection to `MONGO_URI` (once, at boot).
- **`config/openai.js`** — the single OpenAI wrapper (SDK v3, axios-based):
  - `getOpenAI()` — the client
  - `callOpenAI({system, user, ...})` — one chat completion → cleaned text
  - `embed(texts)` — text → normalized vectors (for search)
  - `parseJsonResponse(raw, fallback)` — safe JSON parse
  Every LLM/embedding call goes through here.

---

## PART 2 — Authentication

- **`routes/auth.routes.js`** — thin wiring for `/register`, `/login`, `/mentor/register`,
  `/mentor/login`, `/process-query`, `/continue-followup`, `/users`.
- **`controllers/auth.controller.js`** — `register`/`login` (generic), `registerMentor`/`loginMentor`
  (force/verify `role:"teacher"`), and `processQuery`/`continueFollowup` (start of Part 3).
- **`utils/jwt.js`** — `generateToken(user)` signs a JWT `{ userId, role }`.
- **`middleware/auth.middleware.js`** — verifies `Authorization: Bearer` → sets `req.user`.
- **`models/User.js`** — `name, phone, password(hashed), role`.

**Flow:** login → JWT → sent on protected routes → middleware → `req.user` → guards check `req.user.role`.

---

## PART 3 — Query → 3 Journeys (the core pipeline)

Entry: `POST /api/auth/process-query` → `auth.controller.js`. Step by step:

1. **Guardrail** — `openaiPipeline.js: guardrailCheck()` — academic? (regex then LLM).
2. **Intent** — `openaiPipeline.js: detectIntent()` — `EXPLAIN` vs `SEARCH`. EXPLAIN → `explainConcept()`, stop.
3. **Signal extraction** — `openaiPipeline.js: extractSignalsFromQuery()` — subject/topic/struggle.
4. **Follow-up gate** — `openaiPipeline.js: getNextQuestionOrStop()` — enough? If not → ask a question
   (`followup_needed`); state held in `controllers/runtimeFollowupStore.js` (in-memory Map).
5. **Search** —
   - `openaiPipeline.js: buildSearchQueries()` → 3 variants
   - `controllers/search.js: runSearchPipeline()` → reciprocal-rank-fusion + depth boost
   - `controllers/vectorSearch.js` → loads `.npy` + chunk data, cosine top-k (the in-process vector DB)
6. **Profile** — `controllers/profileBuilder.js: buildStudentProfile()` — confidence, struggle,
   days-to-exam, and the topic list (`extractTopicsFromFaiss`: whole-chapter by default, narrows only
   when a specific topic is named).
7. **Generate 3 journeys** — `services/generateThreeJourneys.js` (adaptive, no LLM): difficulty ladder
   + question counts from the profile → `revision / concept / practice`, each with DOST cards
   (via `chanakya/integration.js: generateDostPayloads`).
8. **Save** — `services/savePlanToMongo.js` → Session + StudentProfile + Journey → returns `session_id`.

Response: `status:"journeys_ready"` with `session_id`, `journeys`, `profile`.

---

## PART 4 — The "chanakya" payload layer (used by step 7)

Turns "practiceAssignment on Thermodynamics" into the exact JSON Acadza expects.

- **`controllers/chanakya/integration.js`** — façade: `generateDostPayloads()`, `callAcadzaApiForPayloads()`.
- **`controllers/chanakya/payloadBuilder.js`** — `buildAllPayloads()`: request → params → payload.
- **`controllers/chanakya/paramResolver.js`** — fills defaults from the profile.
- **`controllers/chanakya/Builders.js`** — `buildAssignment/Test/Formula/Revision/Concept…`.
- **`controllers/chanakya/utils.js`**, **`rag/conceptTree.js`** — validate names against the syllabus.
- **`rag/prompts.js`, `ragEngine.js`, `paramConfig.js`** — RAG prompt + allowed DOST types/params.

---

## PART 5 — Storage layer

**Models:** `models/Session.js` (the doubt), `models/StudentProfile.js` (built profile),
`models/Journey.js` (3 journeys + `copilot_messages`).

**`db/` (data-access, plain objects, no classes):**
- `db/sessions.js` — `SessionDB.create/get/listForStudent`
- `db/studentProfiles.js` — `StudentProfileDB.save/get`
- `db/journeys.js` — `JourneyDB`: `get/save` + mutations
  (`addDost, removeDost, moveDost, reorderDost, setPayload, updateDostPayload, recordSendResults,
  selectJourney, appendChat`) — all via one `mutate()` helper.

Controllers never touch Mongoose directly — they call `JourneyDB.x()`.

---

## PART 6 — Mentor review & edit

- **`routes/mentor/index.js`** — thin: `requireMentor` guard + path → `mentor.controller`.
- **`controllers/mentor.controller.js`** — handlers (+ `loadSession` ownership helper):
  `getJourneys`, `editDostField` (PATCH), `removeDost`, `moveDost`, `selectJourney`,
  `sendJourney` (Part 7), `copilot` (Part 6b).

### Part 6b — the AI copilot (`services/copilot/`)
- **`index.js`** (orchestrator) — load journey + profile + chat → planner → slot-fill guard → apply → log chat.
- **`planner.js`** — 1 LLM call: mentor message + slim journey summary → `{ actions[] }` or `{ needs_clarification }`.
- **`applyPlan.js`** — executes actions (`add/remove/move/reorder/edit_field/add_portion/remove_portion`)
  via `JourneyDB.*`; derives question split from `total_count`.
- **`conceptFinder.js`** — vector-search exact concept names ("all/every" → exhaustive match).

Planner **decides** (cheap, on a summary); applyPlan **executes** (on the real DB doc).

---

## PART 7 — Send to Acadza

`mentor.controller.js: sendJourney`
→ `chanakya/integration.js: callAcadzaApiForPayloads()`
→ **`controllers/chanakya/dostTools/acadzaClient.js: createDost()`** — POSTs each payload to Acadza
  (or returns a **mock** when `ACADZA_MOCK_MODE=true`); retries + timeout.
→ results (`dost_id, link, success`) written back via `JourneyDB.recordSendResults()`, journey marked `sent`.

---

## PART 8 — Student views the plan

- **`routes/student/index.js`** — thin: `requireStudent` + path → `student.controller`.
- **`controllers/student.controller.js`**:
  - `listSessions` → the student's own sessions
  - `getPlan` → only the **sent** journey, only **successful** cards, only **public** fields
    (`dost_type, title, link, dost_id`), ownership-checked.

---

## THE COMPLETE LOOP — with file paths at each step

### 1. login (student or mentor)
```
routes/auth.routes.js
  → controllers/auth.controller.js        (login / loginMentor)
      → utils/jwt.js                        (generateToken)
      → models/User.js                      (find + bcrypt compare)
returns JWT
```

### 2. process-query
```
routes/auth.routes.js
  → controllers/auth.controller.js          (processQuery)
      → controllers/openaiPipeline.js        (guardrailCheck → detectIntent → extractSignalsFromQuery → getNextQuestionOrStop)
      → controllers/search.js                (runSearchPipeline)
          → controllers/vectorSearch.js      (.npy load + cosine top-k)
      → controllers/profileBuilder.js        (buildStudentProfile)
      → services/generateThreeJourneys.js    (3 journeys, adaptive)
          → controllers/chanakya/integration.js     (generateDostPayloads)
              → controllers/chanakya/payloadBuilder.js
              → controllers/chanakya/paramResolver.js
              → controllers/chanakya/Builders.js
      → services/savePlanToMongo.js          (persist)
          → db/sessions.js          (+ models/Session.js)
          → db/studentProfiles.js   (+ models/StudentProfile.js)
          → db/journeys.js          (+ models/Journey.js)
returns { session_id, journeys, profile }
```

### 3. continue-followup  (only if process-query returned followup_needed)
```
routes/auth.routes.js
  → controllers/auth.controller.js          (continueFollowup)
      → controllers/runtimeFollowupStore.js  (read/update follow-up state)
      → controllers/openaiPipeline.js        (getNextQuestionOrStop)
      → (when enough) same plan flow as step 2 → services/savePlanToMongo.js
```

### 4. mentor login
```
routes/auth.routes.js → controllers/auth.controller.js (loginMentor) → utils/jwt.js
```

### 5. view journeys
```
routes/mentor/index.js
  → controllers/mentor.controller.js        (getJourneys)
      → db/sessions.js          (ownership)
      → db/journeys.js          (the 3 journeys)
      → db/studentProfiles.js   (profile)
```

### 6a. edit — direct
```
routes/mentor/index.js
  → controllers/mentor.controller.js        (editDostField / removeDost / moveDost / selectJourney)
      → db/journeys.js          (updateDostPayload / removeDost / moveDost / selectJourney)
```

### 6b. edit — AI copilot
```
routes/mentor/index.js
  → controllers/mentor.controller.js        (copilot)
      → services/copilot/index.js            (orchestrator)
          → services/copilot/planner.js       (1 LLM call → actions[])
          → services/copilot/applyPlan.js     (execute actions)
              → services/copilot/conceptFinder.js   (vector search for concept names)
              → controllers/chanakya/integration.js (when adding a new DOST)
          → db/journeys.js                    (mutations + appendChat)
```

### 7. SEND → DOSTs on Acadza
```
routes/mentor/index.js
  → controllers/mentor.controller.js        (sendJourney)
      → controllers/chanakya/integration.js  (callAcadzaApiForPayloads)
          → controllers/chanakya/dostTools/acadzaClient.js (createDost — real or mock)
      → db/journeys.js          (recordSendResults → marks sent, writes dost_id/link)
```

### 8. student login → GET plan → open Acadza links
```
routes/auth.routes.js → controllers/auth.controller.js (login)     # student token

routes/student/index.js
  → controllers/student.controller.js       (getPlan)
      → db/sessions.js          (ownership)
      → db/journeys.js          (the sent journey → public fields + Acadza links)
returns { plan: { items: [{ dost_type, title, link, dost_id }] } }
```

---

## Layer cheat-sheet (who calls whom)
```
route  →  controller  →  service / db-layer  →  (model | OpenAI | Acadza | vector index)
 thin       logic          reusable work            external systems
```
- **routes/** = wiring + auth guards only
- **controllers/** = request handling (validate, orchestrate, respond)
- **services/** = reusable business logic (journey generation, copilot, save)
- **db/** = the only place that talks to Mongoose
- **models/** = schemas
- **config/** = DB + OpenAI clients
