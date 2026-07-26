# Technical Plan: Gemini API Token Usage Logging & Audit Trail

**Task ID:** gemini-token-usage-logging
**Status:** Ready for Implementation
**Based on:** spec.md (v1.0), research.md

## 1. System Architecture

All Gemini traffic in MasterAPI currently flows through the `@google/genai` SDK directly from 4 service files + 1 route file, each instantiating its own client. This plan introduces one shared instrumentation layer (`src/lib/gemini.ts`) that every call site is migrated to go through, plus one shared logger (`src/lib/logger.ts`) that unifies Fastify's request logging and service-level logging into the same Pino instance.

```
                        ┌─────────────────────────────┐
route handlers  ──────▶ │  services (scan/diet/        │
(pass userId)           │  training/chat)               │
                        └───────────────┬───────────────┘
                                         │ generateContentTracked()
                                         │ generateContentStreamTracked()
                                         ▼
                        ┌─────────────────────────────┐
                        │   src/lib/gemini.ts           │
                        │   - shared GoogleGenAI client  │
                        │   - tracked wrappers           │
                        │   - recordGeminiUsage()        │
                        └──────┬──────────────┬─────────┘
                               │              │
                     (sync, buffered)   (fire-and-forget)
                               ▼              ▼
                    src/lib/logger.ts   Firestore
                    (shared Pino)       users/{uid}/geminiUsage/{id}
                                        (or geminiUsageUnattributed/{id})

routes/chat.ts (Gemini Live, WS) ──▶ recordGeminiUsage() directly
                                     (called once at session end,
                                      not through the wrappers above)
```

Non-streaming and streaming `generateContent*` calls are wrapped transparently — the wrapper calls the real SDK method, captures `usageMetadata` from the already-in-hand response/final chunk, and returns the exact same object to the caller unchanged. The Gemini Live WebSocket relay is architecturally different (a long-lived session, not a single request/response), so it calls the shared `recordGeminiUsage()` primitive directly from its own `onmessage`/session-end logic instead of going through a "tracked" wrapper.

### Architecture Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Instrumentation point | Wrap the SDK call, not the individual service functions | One choke point (`lib/gemini.ts`) instead of 10 copy-pasted logging blocks; new call sites get logging by construction if they use the wrapper. |
| Firestore layout | Subcollection `users/{userId}/geminiUsage/{autoId}`, one doc per request/session | Matches every existing per-user data pattern in this codebase (`dietPlans`, `trainingPlans`, `chat_sessions`, `daily_usage` are all `users/{uid}/...` subcollections — see `diet.service.ts`, `training.service.ts`, `chat.service.ts`, `usage.service.ts`). Trivially answers "usage for user X" with no filter needed. Cross-user/per-feature aggregate queries (spec FR-5's "total tokens by feature this month") use a Firestore **collection group query** (`db.collectionGroup("geminiUsage")`), which Firestore supports natively across all `users/*/geminiUsage` subcollections. |
| Fallback for missing `userId` | Separate top-level collection `geminiUsageUnattributed/{autoId}` | Spec FR-6 requires persisting even when `userId` is absent (currently a theoretical case only — every existing route is behind `authenticate`). Keeps the primary collection's path shape (`users/{uid}/...`) valid without a sentinel `uid`. |
| Logger | Extract the Fastify Pino config into `src/lib/logger.ts`, pass that instance into `Fastify({ logger })`, and import the same instance from services | Fastify accepts a pre-built Pino instance in place of a config object. This makes `app.log` (used in routes) and the service-level logger literally the same object — one log format, one place to change level/transport, no divergence between route logs and service logs. |
| Firestore write timing | Fire-and-forget (`void recordGeminiUsage(...).catch(...)`), never `await`ed on the response-sending path | NFR requires zero added latency. This is a long-running Fastify process (not a serverless function that freezes after the response), so a detached promise reliably completes. Logging itself (`logger.info(...)`) is already synchronous/buffered via Pino and adds negligible time. |
| Streaming capture point | Capture inside `generateContentStreamTracked`'s own `for await` loop, in a `finally` block | Guarantees usage is recorded even if the *outer* consumer (`routes/chat.ts`'s SSE loop) exits early on client disconnect — capture doesn't depend on the caller fully draining the generator. |
| Live API field mapping | Normalize Live's `responseTokenCount` → the same `candidatesTokenCount` field name used by every other record | Keeps the Firestore schema and log shape uniform across all 10 call sites so `feature`-based aggregation queries don't need to special-case Live records. |

## 2. Technology Stack

| Layer | Technology | Version (already in project) | Rationale |
|---|---|---|---|
| Gemini SDK | `@google/genai` | `^1.49.0` (existing) | Already the only Gemini client in the project; `usageMetadata` is native to it, no new dependency. |
| Logging | `pino` (via Fastify's bundled logger) + `pino-pretty` in dev | existing (`fastify` ships Pino; `pino-pretty` already a devDependency) | Already the project's only structured logger; no new dependency needed — `pino` itself is a transitive dependency of `fastify` and can be imported directly. |
| Persistence | `firebase-admin` Firestore | `^13.0.0` (existing) | Already the project's only datastore; matches every other feature's persistence pattern. |
| Language/runtime | TypeScript, Node (ESM, `tsx`) | existing | No change. |

**New dependencies: none.** This task only reorganizes existing dependencies (`@google/genai`, `pino`, `firebase-admin`).

## 3. Component Design

### `src/lib/logger.ts` (new)
- **Purpose:** Single shared Pino logger instance usable both by Fastify (as `app.log`) and by plain service modules that have no access to a Fastify instance.
- **Responsibilities:** Build the same Pino options object currently inlined in `src/app.ts:22-35` (level by `NODE_ENV`, `pino-pretty` transport outside production) and export a ready-to-use logger instance.
- **Interface:**
  ```ts
  export const logger: pino.Logger;
  ```
- **Dependencies:** `pino`, `src/config/env.ts`.
- **Consumers:** `src/app.ts` (passes it into `Fastify({ logger })` instead of the inline options object), `src/lib/gemini.ts`.

### `src/lib/gemini.ts` (new)
- **Purpose:** Own the single shared Gemini client and provide instrumented equivalents of the SDK methods currently called ad hoc from 4 service files.
- **Responsibilities:**
  - Construct one `GoogleGenAI` client (replaces the 5 separate `new GoogleGenAI(...)` instantiations across `scan.service.ts`, `diet.service.ts`, `training.service.ts`, `chat.service.ts` ×2, `routes/chat.ts`).
  - `generateContentTracked(params, meta)` — calls `client.models.generateContent(params)`, extracts `usageMetadata`, calls `recordGeminiUsage`, returns the untouched `GenerateContentResponse`.
  - `generateContentStreamTracked(params, meta)` — async generator wrapping `client.models.generateContentStream(params)`; yields every chunk through unchanged, tracks the latest `usageMetadata` seen, and calls `recordGeminiUsage` in a `finally` block once iteration ends (normally or via early exit/error).
  - `recordGeminiUsage(meta, usage)` — the shared low-level primitive: builds a `GeminiUsageRecord`, logs it via `logger.info({...}, "gemini.usage")`, and fires-and-forgets the Firestore write. Exported standalone so the Gemini Live relay (which doesn't go through the wrappers above) can call it directly.
- **Interface:**
  ```ts
  interface GeminiCallMeta {
    feature: string;        // e.g. "scan.food", "chat.live"
    userId?: string;
    sessionId?: string;     // optional, used by chat.live
  }

  function generateContentTracked(
    params: Parameters<GoogleGenAI["models"]["generateContent"]>[0],
    meta: GeminiCallMeta,
  ): Promise<GenerateContentResponse>;

  function generateContentStreamTracked(
    params: Parameters<GoogleGenAI["models"]["generateContentStream"]>[0],
    meta: GeminiCallMeta,
  ): AsyncGenerator<GenerateContentResponse>; // chunks, unchanged

  function recordGeminiUsage(
    meta: GeminiCallMeta & { model: string },
    usage: UsageMetadataLike | undefined, // shape shared between GenerateContentResponseUsageMetadata and Live's UsageMetadata
  ): void; // fire-and-forget internally; does not throw
  ```
- **Dependencies:** `@google/genai`, `src/lib/logger.ts`, `src/lib/firebase.ts`, `src/config/env.ts`.
- **Consumers:** `scan.service.ts`, `diet.service.ts`, `training.service.ts`, `chat.service.ts`, `routes/chat.ts`.

### Service changes (no new files — signature + call-site edits)

| File | Function | Change |
|---|---|---|
| `src/services/scan.service.ts` | `executeStandardScan`, `executeSkinScan`, `executeReanalyzeScan`, `executeVersusScan`, `executeAddonScan` | Add `userId: string` parameter; replace `ai.models.generateContent(...)` with `generateContentTracked(..., { feature: "scan.<mode>", userId })`; remove the module-level `const ai = new GoogleGenAI(...)`. |
| `src/services/diet.service.ts` | `DietService.generateJSON<T>` (private) | Add `feature: string` + `userId: string` parameters (passed through from `generateDailyPlan`/`generateWeeklyPlan`/`swapMeal`, which each pass a distinct `feature` label); swap to `generateContentTracked`. |
| `src/services/training.service.ts` | `TrainingService.generatePlan` (private) | Add `userId: string` parameter (already receives enough context to label `feature: "training.plan"` statically); swap to `generateContentTracked`. |
| `src/services/chat.service.ts` | `generateStream` | Add `userId: string` parameter; swap `ai.models.generateContentStream(...)` for `generateContentStreamTracked(..., { feature: "chat.stream", userId })`; remove per-call `new GoogleGenAI(...)`. |
| `src/services/chat.service.ts` | `generateSessionSummary` | Add optional `userId?: string` parameter (some callers, like the video-call summary path, already have it); swap to `generateContentTracked(..., { feature: "chat.summary", userId })`. |

### Route changes (thread `userId` through)

| File | Change |
|---|---|
| `src/routes/scan.ts` | Pass `userId` (`req.user.uid`, already in scope) as the new last argument to each `execute*Scan` call. |
| `src/routes/diet.ts` | Pass `request.user.uid` into `dietService.generateDailyPlan`/`generateWeeklyPlan`/`swapMeal` call chains (via `generateAndSaveDailyPlan`/`generateAndSaveWeeklyPlan`, which already receive `userId` — just needs to be threaded one level deeper into the private `generateJSON` calls). |
| `src/routes/training.ts` | `trainingService.generateAndSavePlan` already receives `userId` — thread it into the private `generatePlan` call. |
| `src/routes/chat.ts` (SSE endpoint) | Pass `userId` into `chatService.generateStream(...)`. |
| `src/routes/chat.ts` (Gemini Live WS relay) | See below — separate instrumentation path. |

### Gemini Live relay instrumentation (`src/routes/chat.ts`)
- **Purpose:** Capture token usage for the long-lived audio video-call session without going through the tracked-wrapper pattern (Live uses `ai.live.connect`, a persistent session object, not a single request).
- **Responsibilities:**
  - Add a closure-scoped `let lastUsage: UsageMetadata | undefined` inside the WS handler (alongside the existing `hasInitializedLive`, `liveSessionPromise` state).
  - In the existing `onmessage: (serverMessage: LiveServerMessage) => {...}` callback, add: `if (serverMessage.usageMetadata) lastUsage = serverMessage.usageMetadata;`.
  - In both `ws.on("close", ...)` and `ws.on("error", ...)` handlers (which already call `videoCallService.endSession(...)`), also call `recordGeminiUsage({ feature: "chat.live", userId, sessionId }, lastUsage && { model: "gemini-2.5-flash-native-audio-latest", ...normalizeLiveUsage(lastUsage) })` exactly once, guarded by the existing `isClosed` flag so it can't fire twice.
- **Dependencies:** `src/lib/gemini.ts` (`recordGeminiUsage`).

## 4. Data Model

```ts
// src/lib/gemini.ts

interface GeminiUsageRecord {
  feature: string;                    // "scan.food" | "scan.label" | "scan.qr" | "scan.receipt"
                                       // | "scan.skin" | "scan.reanalyze" | "scan.versus" | "scan.addon"
                                       // | "diet.daily" | "diet.weekly" | "diet.swap"
                                       // | "training.plan" | "chat.stream" | "chat.summary" | "chat.live"
  model: string;                      // e.g. "gemini-2.5-flash", "gemini-2.5-flash-native-audio-latest"
  userId?: string;                    // request.user.uid; absent only in the theoretical unattributed case
  sessionId?: string;                 // set only for feature === "chat.live"
  promptTokenCount?: number;
  candidatesTokenCount?: number;      // normalized name; Live's `responseTokenCount` is mapped here
  totalTokenCount?: number;
  thoughtsTokenCount?: number;
  cachedContentTokenCount?: number;
  status: "ok" | "no_usage_data";     // "no_usage_data" when usageMetadata was absent (blocked prompt,
                                       // aborted stream, Live session that never received usage)
  createdAt: FirebaseFirestore.FieldValue; // FieldValue.serverTimestamp()
}
```

**Firestore layout:**
- `users/{userId}/geminiUsage/{autoId}` — primary path, used whenever `userId` is known (i.e. always, in practice).
- `geminiUsageUnattributed/{autoId}` — fallback, used only if `userId` is ever missing (no current call site hits this).

**Indexing:** Firestore auto-indexes single fields by default (sufficient for `where("createdAt", ">", ...)` per-user history queries). A composite/collection-group index on `(feature, createdAt)` should be added (via `firestore.indexes.json` if the project manages one, or created on first query error in the Firebase console) to support the cross-user "total tokens by feature this month" collection-group query from spec FR-5.

**No changes to any existing Firestore documents/collections** — this is purely additive.

## 5. API Contracts

No new public HTTP endpoints or request/response shape changes — this is an internal instrumentation feature. Every existing endpoint (`POST /scan`, `POST /diet/generate`, `POST /diet/weekly`, `POST /diet/swap`, `POST /training/generate`, `POST /chat/sessions/:id/message`, `WS /chat/video/live`, etc.) keeps its exact current request/response contract; only their internal service calls change to thread `userId` and route through the tracked wrapper.

The only "contract" introduced is internal: the `GeminiUsageRecord` shape (Section 4) and the `recordGeminiUsage(meta, usage)` function signature (Section 3), which is the stable interface any future Gemini call site (or the Live relay) must call into.

## 6. Security Considerations

- **Authentication:** No change — every route that now threads `userId` through already required `authenticate` as a preHandler; no new unauthenticated surface is introduced.
- **Authorization:** Firestore writes happen server-side only via the existing Admin SDK (`firebase-admin`), which bypasses Firestore security rules entirely (as all other writes in this codebase already do) — no rule changes needed.
- **Data protection:** Per spec NFR, usage records contain **only** token counts + `feature`/`model`/`userId`/`sessionId`/timestamp — never prompt text, response text, or image data (which for scan/skin-scan features may include sensitive health/biometric imagery). This must be enforced by construction: `recordGeminiUsage`'s input type (`GeminiUsageRecord`) simply has no field capable of holding prompt/response content.
- **Checklist:**
  - [ ] `recordGeminiUsage` never receives or logs raw prompt/response text.
  - [ ] Firestore writes use the existing Admin SDK credentials (`env.FIREBASE_*`) — no new secrets.
  - [ ] Failures in the usage-capture path are caught and never surface as an HTTP error to the client (spec FR-7).

## 7. Performance Strategy

- **No added Gemini API latency:** `usageMetadata` is already part of the response payload the app receives today — reading it costs nothing extra.
- **No added response latency:** the structured log call (`logger.info`) is synchronous/buffered by Pino; the Firestore write is fire-and-forget (`void recordGeminiUsage(...)`), never awaited before a route sends its reply — including the SSE chat path, where usage is captured after the stream has already fully flushed to the client.
- **Write volume:** one extra Firestore document per Gemini request/session (10 call sites × current traffic volume). Given the existing per-user daily scan/chat count limits (`usage.service.ts`, `PLAN_LIMITS`) already cap request volume per user per day, this stays bounded and proportional to existing Gemini spend — no separate scaling concern.
- **No caching layer needed** — this is a write-mostly, audit-oriented feature; reads (ad hoc audit queries) are expected to be low-frequency, manual/administrative, not part of any hot path.

## 8. Implementation Phases

### Phase 1 — Foundation (no behavior change yet)
- [ ] Create `src/lib/logger.ts`, extract the Pino options currently inlined in `src/app.ts:22-35`, export a shared `logger` instance.
- [ ] Update `src/app.ts` to pass `logger` into `Fastify({ logger, ... })` instead of the inline options object.
- [ ] Create `src/lib/gemini.ts`: shared `GoogleGenAI` client, `GeminiUsageRecord` type, `recordGeminiUsage()`, `generateContentTracked()`, `generateContentStreamTracked()`. No call sites changed yet — verify in isolation (e.g. a throwaway manual test call) that a single `generateContentTracked` call produces both a log line and a Firestore doc under `users/{testUid}/geminiUsage`.
- [ ] `tsc --noEmit` passes.

### Phase 2 — Migrate non-streaming call sites
- [ ] `scan.service.ts`: add `userId` param to all 5 `execute*Scan` functions; swap to `generateContentTracked` with per-mode `feature` labels; remove the module-level Gemini client.
- [ ] `routes/scan.ts`: pass `userId` through to all 5 call sites.
- [ ] `diet.service.ts`: thread `feature`/`userId` through `generateJSON` from `generateDailyPlan` ("diet.daily"), `generateWeeklyPlan` ("diet.weekly"), `swapMeal` ("diet.swap"); swap to `generateContentTracked`; remove the module-level client.
- [ ] `routes/diet.ts`: confirm `userId` already flows from `request.user.uid` into `generateAndSaveDailyPlan`/`generateAndSaveWeeklyPlan`/`swapMeal` — thread the one extra hop into the private generation methods.
- [ ] `training.service.ts`: thread `userId` into `generatePlan` ("training.plan"); swap to `generateContentTracked`; remove the module-level client.
- [ ] `routes/training.ts`: thread `userId` the one extra hop into `generatePlan`.
- [ ] `chat.service.ts`: `generateSessionSummary` gets `feature: "chat.summary"` + optional `userId`; swap to `generateContentTracked`.
- [ ] `tsc --noEmit` passes; manually exercise each endpoint in dev and confirm a log line + Firestore doc for each.

### Phase 3 — Migrate streaming chat
- [ ] `chat.service.ts`: `generateStream` gets `userId` param; swap to `generateContentStreamTracked` with `feature: "chat.stream"`; remove the per-call `new GoogleGenAI(...)`.
- [ ] `routes/chat.ts`: thread `userId` into the `generateStream(...)` call in the SSE handler.
- [ ] Manually test: (a) a normal chat turn completes and produces exactly one usage record with real token counts; (b) forcibly disconnect mid-stream (e.g. close the client early) and confirm a `status: "no_usage_data"` (or partial) record is still produced, not a crash.

### Phase 4 — Instrument Gemini Live relay
- [ ] `routes/chat.ts`: add `lastUsage` closure variable; update it in the existing `onmessage` callback when `serverMessage.usageMetadata` is present.
- [ ] Call `recordGeminiUsage(...)` once from both `ws.on("close")` and `ws.on("error")`, guarded so it only ever fires once per session (reuse the existing `isClosed` flag).
- [ ] Manually run a short video-call session end-to-end and confirm exactly one `chat.live` usage record is produced after the call ends, with `sessionId` populated.

### Phase 5 — Validation & cleanup
- [ ] Grep for any remaining direct `ai.models.generateContent`/`generateContentStream`/`new GoogleGenAI(` calls outside `src/lib/gemini.ts` — should return zero results (except the Live `.live.connect` call, which is expected to remain, and `test-gemini.ts`, a standalone script outside the app — decide whether to update or leave it, since it's not part of the served app).
- [ ] Temporarily simulate a Firestore write failure (e.g. bad collection path) and confirm the underlying scan/chat/diet/training endpoints still return successfully — validates spec FR-7.
- [ ] Confirm no prompt/response text appears in any log line or Firestore document produced by this feature.

## 9. Risk Assessment

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| Threading `userId` through ~15 call sites introduces a typo/mismatch that breaks an existing endpoint | High (feature breakage) | Low | Do it incrementally per phase, run `tsc --noEmit` after each file, manually smoke-test each endpoint before moving to the next phase. |
| Streaming usage capture missed if the outer consumer breaks out of the generator early | Medium (silent gap in audit data) | Medium | Capture happens in a `finally` block inside `generateContentStreamTracked` itself, not dependent on the caller finishing the loop. |
| Firestore write volume/cost grows unexpectedly at scale | Low–Medium | Low | Volume is already bounded by existing daily scan/chat quotas (`usage.service.ts`); revisit retention/archival later if needed (explicitly out of scope for this task per spec). |
| Fire-and-forget Firestore write throws an unhandled rejection | Medium (could crash the Node process if unhandled) | Low | `recordGeminiUsage` internally wraps the Firestore write in `.catch(err => logger.warn(...))` — never left as a bare unhandled promise. |
| Live API's `usageMetadata` field names differ from `generateContent`'s (`responseTokenCount` vs. `candidatesTokenCount`) causing inconsistent records | Low | Medium (easy to miss) | Explicit normalization step in `recordGeminiUsage`/the Live call site, documented in Section 1's decision table — call out in code review. |
| `test-gemini.ts` (standalone dev script) still constructs its own raw `GoogleGenAI` client outside the app | Low (it's not part of the served API) | N/A | Leave as-is; it's a manual debug script, not a served code path — explicitly noted in Phase 5, no action required unless the team wants it updated for consistency. |

## 10. Open Questions

- [ ] Should a Firestore composite/collection-group index for `(feature, createdAt)` be added proactively (e.g. via a checked-in `firestore.indexes.json`), or created reactively the first time the cross-user audit query is run and Firestore prompts for it? (No existing `firestore.indexes.json` was found in the repo — confirm during implementation whether index management is otherwise handled manually via the Firebase console.)
- [ ] Confirm whether `test-gemini.ts` should also be migrated to the shared client/logger for consistency, or left untouched as a standalone script (leaning: leave untouched, per Section 9).
- [ ] Confirm exact `feature` label list against Section 4 before implementation starts, so it's fixed once and not renamed mid-way (renaming later would fragment historical audit data by label).

## Next Steps
- Review this plan, in particular the Firestore layout decision and the `feature` label list in Section 4.
- Break Section 8's phases into individual implementation tasks.
- Begin implementation with Phase 1 (foundation: `lib/logger.ts` + `lib/gemini.ts`), since every later phase depends on it.
