# Specification: Gemini API Token Usage Logging & Audit Trail

**Task ID:** gemini-token-usage-logging
**Created:** 2026-07-26
**Status:** Ready for Planning
**Version:** 1.0

## 1. Problem Statement

- **The Problem:** Every feature in MasterAPI that calls the Gemini API (food/label/QR/receipt scan, skin scan, diet plan generation, training plan generation, Dr. Moriesly chat, video-call session summaries, and the Gemini Live audio relay) runs today without ever reading or recording how many input/output tokens each request consumed. The Gemini SDK (`@google/genai`) already returns this data on every response (`response.usageMetadata`), but no code path touches it.
- **Current Situation:** Token spend is completely invisible. There is no log line, no stored record, and no way to answer "how many tokens did we burn this week" or "which feature/user is driving Gemini cost" without going to the Google Cloud billing console, which doesn't break costs down by internal feature or user.
- **Desired Outcome:** Every request that touches the Gemini API — regardless of call type (single-turn JSON generation, streaming chat, or the long-lived Live audio session) — emits a structured log line with input/output/total token counts, and also persists that same data to Firestore so it can be queried per user, per day, and per feature/model for ongoing cost audits.

## 2. User Personas

### Primary User: Backend/Platform Engineer (internal, e.g. the MasterAPI maintainer)
- **Who:** The person(s) operating and paying for the Gemini API usage behind MasterAPI's features.
- **Goals:** Understand token consumption per feature and per user, catch runaway/abusive usage early, and have a queryable audit trail to justify or investigate Gemini API cost.
- **Pain points today:** No visibility at all — token usage is a black box until the monthly Google Cloud bill arrives, with no way to attribute spend to a specific feature or user after the fact.

There is no end-user-facing persona for this feature — it is purely an internal observability capability. No mobile/frontend changes are involved.

## 3. Functional Requirements

### FR-1: Token Usage Capture for Single-Turn Gemini Calls
**Description:** Every non-streaming `generateContent` call site captures `usageMetadata` from the SDK response immediately after the call completes. This covers: `scan.service.ts` (`executeStandardScan`, `executeSkinScan`, `executeReanalyzeScan`, `executeVersusScan`, `executeAddonScan`), `diet.service.ts` (`generateJSON`, the shared helper behind `generateDailyPlan`/`generateWeeklyPlan`/`swapMeal`), `training.service.ts` (`generatePlan`), and `chat.service.ts` (`generateSessionSummary`).

**User Story:**
> As a platform engineer, I want every single-turn Gemini call to record its token usage so that I can see exactly how many tokens each scan, diet plan, training plan, or chat summary consumes.

**Acceptance Criteria:**
- [ ] Given any of the 8 existing non-streaming call sites completes successfully, when the Gemini response is returned, then `promptTokenCount`, `candidatesTokenCount`, and `totalTokenCount` (plus `thoughtsTokenCount`/`cachedContentTokenCount` when present) are extracted from `response.usageMetadata`.
- [ ] Given `response.usageMetadata` is missing or undefined (e.g. the model returned no candidates), when the call completes, then the system logs the event with token fields as `null`/absent rather than throwing.
- [ ] Given a new Gemini call site is added later that reuses the shared capture mechanism, when it is wired up the same way as the existing ones, then it automatically gets token logging without bespoke code.

**Priority:** Must Have

### FR-2: Token Usage Capture for Streaming Chat
**Description:** `chat.service.ts`'s `generateStream` (used by `POST /chat/sessions/:id/message` for Dr. Moriesly's SSE chat) captures the `usageMetadata` carried on the Gemini streaming response, which arrives with the final cumulative totals on the last chunk of the stream.

**User Story:**
> As a platform engineer, I want streaming chat responses to also report token usage so that chat — one of the most frequently used features — isn't a blind spot in the audit trail.

**Acceptance Criteria:**
- [ ] Given a chat stream completes normally, when the last chunk carrying `usageMetadata` is received, then the final token counts are captured before the generator finishes.
- [ ] Given the client disconnects or the stream errors mid-way, when no `usageMetadata` was ever received, then the system still records a usage event for that request marked as incomplete (token fields absent) rather than silently dropping it.
- [ ] Given token capture happens on the streaming path, when tokens are being forwarded to the client via SSE, then capturing usage metadata introduces no observable delay in token delivery to the user.

**Priority:** Must Have

### FR-3: Token Usage Capture for Gemini Live (Audio Video-Call) Sessions
**Description:** The Gemini Live WebSocket relay in `routes/chat.ts` (`geminiLive.live.connect`, used for the audio video-call feature) tracks the most recent `usageMetadata` received via `onmessage`, and logs/persists one summary record when the session ends (WebSocket `close`, or the existing `videoCallService.endSession` call), rather than on every individual `usageMetadata` event.

**User Story:**
> As a platform engineer, I want the audio video-call feature's Gemini Live sessions to report total token usage per session so I can audit its cost the same way as every other feature, without flooding the logs with per-message events during long calls.

**Acceptance Criteria:**
- [ ] Given a Live session receives one or more `usageMetadata` events during its lifetime, when the session ends (client closes the socket, server closes it, or an error terminates it), then the last known `usageMetadata` values are logged and persisted exactly once for that session.
- [ ] Given a Live session ends without ever having received a `usageMetadata` event (e.g. it failed immediately after connecting), when the session-end handler runs, then no usage record is force-created with fabricated zeros — either the record is omitted or explicitly marked as having no data, per the implementation's chosen convention (to be settled in planning).
- [ ] Given the session lasts several minutes with many audio/video frames exchanged, when it ends, then exactly one usage log line / one Firestore document is produced for that session — not one per frame.

**Priority:** Must Have

### FR-4: Structured Log Output
**Description:** Every captured usage event (from FR-1, FR-2, FR-3) produces one structured log line via the app's existing Pino-based logging, containing at minimum: `feature` (a stable label identifying which call site produced it, e.g. `scan.food`, `diet.daily`, `chat.stream`, `chat.live`), `model` (the Gemini model name used), `userId` (see FR-6), `promptTokenCount`, `candidatesTokenCount`, `totalTokenCount`.

**User Story:**
> As a platform engineer, I want a consistent, structured log shape for every Gemini request so I can grep/filter/aggregate token usage across all features from log output alone, without needing to query Firestore for quick checks.

**Acceptance Criteria:**
- [ ] Given a usage event is captured, when it is logged, then the log line includes `feature`, `model`, `userId` (or explicit absence), and all three core token counts as named fields (not just interpolated into a free-text message), so it can be parsed/filtered by log tooling.
- [ ] Given the app already uses Pino as its structured logger, when this feature logs usage events from service files (which don't currently have access to `app.log`), then it uses a logger instance available outside Fastify route handlers, producing the same structured JSON shape as `app.log` would.

**Priority:** Must Have

### FR-5: Firestore Persistence for Queryable Audit Trail
**Description:** In addition to structured logs, every captured usage event (FR-1, FR-2, FR-3) is written as one document to a Firestore collection dedicated to Gemini usage records, containing the same fields as the log line (`feature`, `model`, `userId`, token counts) plus a timestamp, so usage can be queried later (e.g. "total tokens for user X in the last 7 days", "total tokens by feature this month") without needing to parse logs.

**User Story:**
> As a platform engineer, I want token usage persisted somewhere queryable so that I can run ad-hoc audit queries (per user, per day, per feature) instead of grepping through log files.

**Acceptance Criteria:**
- [ ] Given a usage event is captured, when it is persisted, then a Firestore document is created containing `userId` (if available), `feature`, `model`, `promptTokenCount`, `candidatesTokenCount`, `totalTokenCount`, and a `createdAt` timestamp.
- [ ] Given the Firestore write happens after a Gemini call already succeeded, when the write itself fails (network issue, quota, permissions), then the failure is caught and logged as a warning — the original Gemini response already sent to/being sent to the caller is not affected.
- [ ] Given the need to query "total tokens per user over a date range" or "total tokens per feature", when records are written with `userId`, `feature`, and `createdAt` as indexed/queryable fields, then such aggregate queries are possible via standard Firestore queries (exact query/aggregation implementation is a planning-phase decision).

**Priority:** Must Have

### FR-6: User Attribution
**Description:** Every non-streaming and streaming call site threads the requesting user's ID (`request.user.uid`, already available in every route that reaches these services — all are behind the `authenticate` preHandler) down into the token-capture layer, so logs and Firestore records can be attributed to the user who triggered the request. Several service functions (e.g. `executeStandardScan`, `dietService.generateDailyPlan`, `trainingService.generatePlan`) do not currently accept a `userId` parameter and will need their signatures extended.

**User Story:**
> As a platform engineer, I want to know which user triggered each Gemini request so that I can audit per-user token consumption and investigate abnormal usage.

**Acceptance Criteria:**
- [ ] Given a route handler already has `request.user.uid` in scope (true for every existing Gemini-touching route: scan, diet, training, chat), when it calls the underlying service function, then the `userId` is passed through to wherever the usage event is captured and logged/persisted.
- [ ] Given a call site where `userId` genuinely cannot be determined (none currently exist, but the mechanism must not assume it always will), when a usage event is captured without a `userId`, then the event is still logged/persisted with `userId` explicitly absent rather than the capture being skipped entirely.

**Priority:** Must Have

### FR-7: Non-Fatal Failure Handling
**Description:** Any failure in extracting, logging, or persisting token usage data must never cause the underlying Gemini request/response to fail, delay, or change behavior for the end user. This is purely an observability layer bolted onto existing functionality.

**User Story:**
> As a platform engineer, I want token usage logging to be strictly best-effort so that a bug or outage in the logging/persistence path never breaks scanning, chatting, or plan generation for actual users.

**Acceptance Criteria:**
- [ ] Given the usage-capture or Firestore-write logic throws an exception, when this happens, then it is caught internally and logged as a warning/error — the calling feature's existing response/behavior is unaffected.
- [ ] Given `response.usageMetadata` is absent, malformed, or partially populated, when the capture logic runs, then it does not throw and does not block the caller from receiving its normal Gemini result.

**Priority:** Must Have

## 4. Non-Functional Requirements

- **Performance:** Token capture and logging must add negligible latency to existing Gemini call sites (no additional network round-trip — `usageMetadata` is already part of the response payload). The Firestore write should not block the response being sent to the end user for non-streaming calls beyond what's acceptable for existing writes in this codebase (e.g. comparable to the existing `addMessage`/`plansCol().doc().set()` patterns already in use); for the streaming chat path, the Firestore write must happen after the SSE stream has already been flushed to the client, never delaying token delivery.
- **Consistency / Maintainability:** All Gemini call sites should route through one shared capture mechanism (not 8+ hand-copied logging snippets), so that adding a new Gemini-touching feature in the future doesn't silently omit token logging by default.
- **Privacy:** Only token counts and request metadata (`feature`, `model`, `userId`, timestamp) are logged/persisted — prompt text, response text, and images (which may contain health/biometric data from scan/skin-scan features) are never included in usage logs or Firestore usage records.
- **Data Retention:** No specific retention policy is required for this task (existing Firestore usage of the project has no TTL/retention automation); this can be revisited later if the usage collection grows large.

## 5. Out of Scope

- **Cost estimation in USD** — per-model Gemini pricing tables are not maintained in this task; only raw token counts are captured. Can be added later as a follow-up once the underlying data exists.
- **Dashboard/UI for visualizing usage** — this task delivers structured logs + queryable Firestore records only; building a dashboard or admin screen on top of this data is a separate future task.
- **Real-time usage-based quota enforcement or alerting** — the existing `usage.service.ts` (`checkAndIncrementUsage`) already enforces daily scan/chat *count* limits unrelated to token counts; this task does not touch or extend that quota system, and does not add token-based rate limiting or alerting.
- **Retroactive backfill of historical usage** — requests made before this feature ships were never recorded and cannot be reconstructed.
- **Changes to the Gemini Live audio pipeline's actual behavior** — only usage observability is added; no changes to how audio/video is streamed, transcribed, or relayed.

## 6. Edge Cases & Error Handling

| Scenario | Expected Behavior |
|---|---|
| `response.usageMetadata` is undefined (e.g. content blocked before generation) | Log/persist the event with token fields absent/null; do not throw. |
| Streaming chat aborts mid-stream (client disconnect) before any `usageMetadata` chunk arrives | Record a usage event marked incomplete (no token counts) rather than dropping it silently. |
| Gemini Live session ends without ever receiving a `usageMetadata` message (e.g. connection fails immediately) | No usage record is force-created with fabricated zero values; either omit the record or mark it explicitly as "no data," per the convention chosen in planning. |
| Firestore write fails (network/quota/permission error) | Caught and logged as a warning; the Gemini response already returned/being returned to the caller is unaffected. |
| A user fires many rapid scan requests in succession (e.g. reanalyze retries) | Each request produces its own independent usage record (auto-generated Firestore doc ID) — no shared counter document that could create write contention. |
| A Gemini Live session runs for the platform's maximum allowed duration (see `VIDEO_CALL_MAX_DURATION_SECONDS`) and receives multiple `usageMetadata` events over its lifetime | Only the most recent/cumulative `usageMetadata` is kept and logged once at session end — intermediate events are not each logged separately. |

| Error | User Message | System Action |
|---|---|---|
| Usage capture/logging throws internally | None (invisible to the end user) | Caught, logged as a warning with context (feature, error), original Gemini flow continues unaffected. |
| Firestore usage-record write fails | None (invisible to the end user) | Caught, logged as a warning; no retry required for this task's scope. |

## 7. Success Metrics

| Metric | Target | How to Measure |
|---|---|---|
| Call-site coverage | 100% of Gemini call sites (8 non-streaming + 1 streaming + 1 Live) route through the shared token-capture mechanism | Code review: no direct `ai.models.generateContent`/`generateContentStream` calls exist outside the shared capture layer; grep confirms zero bypasses. |
| Log completeness | Every successfully completed Gemini request produces exactly one structured log line with token fields | Manually trigger each feature (scan, diet, training, chat, live) in a dev/staging environment and confirm a log line with `promptTokenCount`/`candidatesTokenCount`/`totalTokenCount` appears for each. |
| Firestore audit queryability | Able to answer "total tokens used by user X in the last 7 days" and "total tokens by feature this month" using only the new collection, with no code changes | Run an ad-hoc Firestore query against the usage collection after exercising a few features and confirm correct aggregation. |
| No regression in Gemini-call reliability | 0% increase in error rate for existing Gemini-touching endpoints attributable to the new logging/persistence layer | Compare error rates/response shapes for scan, diet, training, chat endpoints before and after the change (manual smoke test is sufficient given no existing automated test suite for these routes). |

## 8. Open Questions

- [ ] Exact Firestore collection shape/location: a single top-level collection (e.g. `geminiUsage`) vs. a subcollection under each user (e.g. `users/{uid}/geminiUsage`) — affects query patterns and is a planning-phase decision.
- [ ] Naming convention for the `feature` label per call site (e.g. `scan.food` vs. `scan_food` vs. `ScanFood`) — needs to be fixed once during planning so it stays consistent across all 10 call sites.
- [ ] Whether the shared logger for services (outside Fastify route handlers) should be a standalone `pino()` instance or something else — a technical decision for `/plan`, not a requirement here.
- [ ] Retention/cleanup policy for the Firestore usage collection if it grows large over time — explicitly deferred, not blocking for initial implementation.

## 9. Revision History

| Version | Date | Changes |
|---|---|---|
| 1.0 | 2026-07-26 | Initial specification |

## Next Steps
1. Review this specification, in particular the open questions in Section 8.
2. Resolve open questions during technical planning (Firestore shape, `feature` label naming, logger implementation).
3. Move to `/plan` for `gemini-token-usage-logging` to produce a concrete file-by-file implementation plan.
