# Tathastu — JEE/NEET Mentor Backend

Node/Express backend that turns a student's doubt into a **personalized study plan**, lets a
**mentor (teacher)** review/edit/agentically-tune it, sends the resources to **Acadza** (the
"DOST" learning tools), and exposes the final plan back to the **student**.

```
student query → 3 journeys → mentor views → edits (direct + AI copilot) → SEND (Acadza) → student sees plan
```

---

## 1. Tech stack

| Piece | What |
|---|---|
| Runtime | Node.js (v18+, uses `structuredClone`/global `fetch`) |
| Web | Express 4 |
| DB | MongoDB via Mongoose 7 |
| Auth | JWT (`jsonwebtoken`) + `bcryptjs` |
| LLM | OpenAI (`gpt-4o-mini` for classify/planner, `text-embedding-3-small` for vectors) |
| Vector search | In-process cosine over `.npy` embeddings (no external vector DB) |

---

## 2. Setup

```bash
npm install
cp .env.example .env     # fill in values
# make sure MongoDB is running:  sudo systemctl start mongod
npm run dev              # nodemon (auto-reload)   |   npm start (plain node)
```

### Environment (`.env`)
| Var | Purpose |
|---|---|
| `MONGO_URI` | e.g. `mongodb://127.0.0.1:27017/tathastu` |
| `PORT` | default `4000` |
| `JWT_SECRET` | token signing secret (required for any auth) |
| `JWT_EXPIRES_IN` | e.g. `7d` |
| `ACADZA_MOCK_MODE` | `true` = fake DOST creation; `false` = call real Acadza |
| `ACADZA_API_BASE_URL` | real Acadza base URL (when mock off) |
| `OPENAI_API_KEY` | currently hard-coded in `config/openai.js` — **move to env for production** |

> ⚠️ After changing `.env` you must restart the server (`dotenv` reads it once at boot).

---

## 3. Directory map (where things live)

```
app.js                         # express bootstrap, connects DB, mounts routers
config/
  db.js                        # connectDB() — mongoose connection
  openai.js                    # getOpenAI(), callOpenAI(), embed(), parseJsonResponse()
routes/
  auth.routes.js               # /api/auth/*  (public)
  mentor/index.js              # /mentor/*    (teacher JWT)
  student/index.js             # /student/*   (student JWT)
middleware/auth.middleware.js  # verifies JWT → req.user
utils/jwt.js                   # generateToken()
models/                        # Mongoose schemas: User, Session, StudentProfile, Journey
db/                            # data-access layer (plain objects, not classes)
  sessions.js  studentProfiles.js  journeys.js
controllers/
  auth.controller.js           # register/login (+mentor), process-query, continue-followup
  openaiPipeline.js            # guardrail, intent, follow-up engine, signal extraction, search-query gen
  search.js                    # multi-query + reciprocal-rank-fusion search
  vectorSearch.js              # .npy loader + cosine top-k + getChunk
  profileBuilder.js            # builds the student profile + topic selection
  chanakya/                    # RAG → DOST payloads
    integration.js             # generateDostPayloads, callAcadzaApiForPayloads
    Builders.js                # buildAssignment/Test/Formula/Revision/Concept payloads
    paramResolver.js  payloadBuilder.js  profileEnrichment.js  queryChecker.js
    dostTools/acadzaClient.js  # createDost() — real/mock Acadza HTTP
    rag/ ragEngine.js prompts.js paramConfig.js conceptTree.js
services/
  savePlanToMongo.js           # Session + StudentProfile + 3 Journeys
  generateThreeJourneys.js     # adaptive 3-journey builder (revision/concept/practice)
  copilot/                     # the AI mentor copilot
    index.js                   # orchestrator (plan → guard → apply → log)
    planner.js                 # 1 LLM call → actions[] or clarification
    applyPlan.js               # applies each action to the journey (DB mutations)
    conceptFinder.js           # vector search → exact concept/subconcept names
openai_subject_index/          # per-subject chunk_data.json + embedding_vectors.npy + concept_tree.json
```

---

## 4. Core data models

**Session** (`models/Session.js`) — one student doubt.
`session_id, student_id, mentor_id, original_query, enriched_query, followup_qa[], ranked_results[], status`

**StudentProfile** (`models/StudentProfile.js`) — the built profile, keyed by `(student_id, session_id)`.

**Journey** (`models/Journey.js`) — the 3 plans for a session.
```
{ session_id, student_id, mentor_id,
  journeys: [ { type:"revision"|"concept"|"practice", dosts:[card], alignment_score,
                recommended_rank, selected?, sent? } ],
  copilot_messages: [ { role, content, examples?, ts } ] }
```
A **card (dost)**: `{ index, dost_type, title, payload, original_payload, script, status, success, dost_id, link, error }`.

DOST types: `practiceAssignment, practiceTest, concept, formula, revision, clickingPower, pickingPower, speedRace`.

---

## 5. Auth model

JWT carries `{ userId, role }`. Three guards:
- `/api/auth/*` → **public** (no token)
- `/mentor/*` → `requireMentor` (role `teacher` + session ownership)
- `/student/*` → `requireStudent` (role `student` + owns the session)

Ownership = `session.mentor_id`/`student_id` must match the token's user `_id`
(`mentor_id: null` sessions are visible to any teacher).

---

## 6. API reference

Base URL: `http://localhost:4000`

### 6.1 Auth (public)

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/api/auth/register` | `{name, phone, password, role}` | generic register |
| POST | `/api/auth/login` | `{phone, password}` | returns `{token, user}` |
| POST | `/api/auth/mentor/register` | `{name, phone, password}` | forces `role:"teacher"` |
| POST | `/api/auth/mentor/login` | `{phone, password}` | 403 if not a teacher |
| GET | `/api/auth/users?role=student` | — | list users (debug) |

### 6.2 Query → plan (public)

**`POST /api/auth/process-query`**
Body: `{ query (required), studentId?, mentorId?, clientSessionUuid? }`
(`studentId` defaults to `"demo-student"`; pass the student's real `_id` for ownership.)

Outcomes:
- `status:"explain"` — direct concept explanation, no session.
- `status:"followup_needed"` — `{ temp_session_id, response.question }`. Continue below.
- `status:"journeys_ready"` — `{ session_id, session, journeys, profile }`. Plan saved.

**`POST /api/auth/continue-followup`**
Body: `{ temp_session_id, question, answer }` → loops `followup_needed` or returns `journeys_ready`.

> Pipeline (see `auth.controller.js`): guardrail → intent (EXPLAIN/SEARCH) → signal extract →
> follow-up gate → vector search → `buildStudentProfile` → `generateThreeJourneys` → `savePlanToMongo`.

### 6.3 Mentor (teacher token)

| Method | Path | Body | Does |
|---|---|---|---|
| GET | `/mentor/sessions/:sessionId/journeys` | — | the 3 journeys + profile |
| PATCH | `/mentor/sessions/:sessionId/journeys/:type/dosts/:idx` | `{field, value}` | edit one card field |
| POST | `/mentor/sessions/:sessionId/journeys/:type/dosts/:idx/remove` | — | remove a card |
| POST | `/mentor/sessions/:sessionId/journeys/:srcType/dosts/:idx/move` | `{destType}` | move card to another journey |
| POST | `/mentor/sessions/:sessionId/journeys/:type/select` | — | mark journey as chosen |
| POST | `/mentor/sessions/:sessionId/journeys/:type/copilot` | `{message}` | **AI edit** (see 6.5) |
| POST | `/mentor/sessions/:sessionId/journeys/:type/send` | — | create DOSTs on Acadza |

`:type` ∈ `revision | concept | practice`. Edit/send return `{ success, journeys|journey }`.

### 6.4 Student (student token)

| Method | Path | Returns |
|---|---|---|
| GET | `/student/sessions` | the student's own sessions |
| GET | `/student/sessions/:sessionId/plan` | the **sent** journey: `{ type, items:[{dost_type, title, link, dost_id}] }` (public fields only; `status:"pending"` if not sent) |

### 6.5 Copilot (agentic editing)

`POST /mentor/sessions/:sessionId/journeys/:type/copilot` with `{ "message": "<natural language>" }`.

Flow (`services/copilot/`): **planner** (1 LLM call) → `{actions[]}` or a clarification →
deterministic slot-fill guard → **applyPlan** mutates the journey → concept-bearing actions resolve
exact names via **conceptFinder** (vector search) → chat logged to `copilot_messages`.

Responses:
- `{ type:"done", message, journey }` — applied.
- `{ type:"ask", message, examples }` — needs info (e.g. assignment with no question count).

Supported actions: `add_dost, remove_dost, move_dost, reorder_dost, edit_field, add_portion, remove_portion`.
Compound messages decompose into multiple actions ("make the assignment hard **and** add a 90 min test").

Notes:
- **practiceAssignment** needs only `difficulty` + `total_count`; the per-type split (scq/mcq/integer)
  is derived (`splitFromTotal`), tilted by an optional `qtype_hint` ("mostly numericals").
- "**all/every** X" (e.g. "all thermodynamics laws") triggers an **exhaustive name match** over the
  chapter's concepts; a specific phrase ("entropy") uses **semantic top-k**.
- `buildFormula` scopes to the requested concepts (validated against the index); whole-chapter only
  when no concept is named.

---

## 7. Journey generation logic (`services/generateThreeJourneys.js`)

Builds 3 journeys from one profile, **adaptively, no LLM**:
- **Difficulty ladder** from `overall_confidence`: low→`[easy,moderate]`, medium→`[easy,moderate,hard]`, high→`[moderate,hard]`.
- **Question volume** from confidence (+`struggle_area`: `problem_solving`→more integer, `theory`→more scq/mcq).
- **Recipes:** concept = `concept + formula + assignment(easiest)`; revision = `formula + revision + test(mid)`;
  practice = `assignment per ladder rung + test(hardest)`.
- **Ranking:** `alignment_score` from struggle_area → `recommended_rank`.

---

## 8. Acadza send (`controllers/chanakya/dostTools/acadzaClient.js`)

`createDost(payload, {mockMode})`:
- `mockMode` (or `ACADZA_MOCK_MODE=true`) → returns a fake `{dost_id, link}`.
- else → POST `…/combined/create` (or `…/shorturl/create` for concept), with retries/timeout.
Results are written back onto each card (`status, dost_id, link, error`) and the journey is marked `sent`.

---

## 9. End-to-end quick test (curl)

```bash
BASE=http://localhost:4000
# tokens
STOK=$(curl -s -X POST $BASE/api/auth/login -H 'Content-Type: application/json' -d '{"phone":"7000000001","password":"secret123"}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).token||""))')
SUID=$(curl -s -X POST $BASE/api/auth/login -H 'Content-Type: application/json' -d '{"phone":"7000000001","password":"secret123"}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).user._id||""))')
TOK=$(curl -s -X POST $BASE/api/auth/mentor/login -H 'Content-Type: application/json' -d '{"phone":"9990001111","password":"secret123"}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).token||""))')

# 1. generate plan
curl -s -X POST $BASE/api/auth/process-query -H 'Content-Type: application/json' \
  -d "{\"query\":\"class 12, weak in thermodynamics problem solving, help with all concepts\",\"studentId\":\"$SUID\"}"
# (answer continue-followup if it asks; capture session_id → SID)

# 2. mentor views / edits / copilot / sends
curl -s $BASE/mentor/sessions/$SID/journeys -H "Authorization: Bearer $TOK"
curl -s -X POST $BASE/mentor/sessions/$SID/journeys/practice/copilot -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d '{"message":"make the assignment hard and add a 90 minute test"}'
curl -s -X POST $BASE/mentor/sessions/$SID/journeys/practice/send -H "Authorization: Bearer $TOK"

# 3. student sees the plan
curl -s $BASE/student/sessions/$SID/plan -H "Authorization: Bearer $STOK"
```

---

## 10. Known limits / TODO

- **OpenAI key is hard-coded** in `config/openai.js` → move to `OPENAI_API_KEY` env.
- **No re-send guard** — calling `/send` twice re-creates DOSTs on Acadza (duplicates). Add a `409 if already sent`.
- **copilot `edit_field`** has no per-type validation (won't reject a field that doesn't belong to a type).
- **Thermodynamics vs Thermochemistry** can't be cleanly separated — the index has no per-concept
  sub-area tag (both share one chapter). Would need a `section` field on chunks.
- **Repeat-session / profile memory** keys on `studentId`; omit it and everything lumps under `"demo-student"`.
```
