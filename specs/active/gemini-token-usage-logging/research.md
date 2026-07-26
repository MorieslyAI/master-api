# Research: Gemini API Token Usage Logging (Audit)

**Task ID:** gemini-token-usage-logging
**Date:** 2026-07-26

## Executive Summary

Every call site in this repo that talks to Gemini uses the `@google/genai` SDK directly (`ai.models.generateContent`, `ai.models.generateContentStream`, `ai.live.connect`), and none of them read or log the response's `usageMetadata`. That metadata is already returned by the SDK on every response — it just isn't being touched. The SDK's `GenerateContentResponse.usageMetadata` object exposes `promptTokenCount` (input), `candidatesTokenCount` (output), and `totalTokenCount`, confirmed directly from the installed package's type definitions (`node_modules/@google/genai/dist/genai.d.ts:4671-4694`). The streaming and Live (WebSocket audio) paths expose the equivalent data too, just under slightly different field names and delivery points.

There are 7 distinct Gemini call sites across 4 files (`scan.service.ts` ×5, `diet.service.ts` ×1 shared helper used 3×, `training.service.ts` ×1, `chat.service.ts` ×2) plus one Gemini Live WebSocket relay (`routes/chat.ts`). All of them are missing token accounting. The cleanest fix is a single shared wrapper function that every call site routes through, rather than adding `console.log(response.usageMetadata)` seven times by hand — the codebase doesn't currently have any Gemini-specific abstraction layer (each service instantiates its own `new GoogleGenAI(...)` client), so introducing one small `lib/gemini.ts` module is a natural, low-risk fit for existing conventions (`src/lib/firebase.ts`, `src/lib/jwt.ts` already play this "shared client/helper" role).

The app already has a structured logger (Fastify's built-in Pino instance, `app.log`, configured in `src/app.ts:22-35`) but the Gemini services are plain modules without access to `app.log` — they currently use raw `console.error`. So the recommendation also needs to pick a logging surface that works both inside Fastify route handlers and inside standalone service classes.

## Codebase Analysis

### Existing Patterns

**All Gemini call sites** (confirmed via repo-wide grep for `@google/genai`/`generateContent`):

| File | Function | Call type | Notes |
|---|---|---|---|
| `src/services/scan.service.ts:360` | `executeStandardScan` | `generateContent` | food/label/qr/receipt scan, image input |
| `src/services/scan.service.ts:401` | `executeSkinScan` | `generateContent` | face image input |
| `src/services/scan.service.ts:486` | `executeReanalyzeScan` | `generateContent` | optional image input |
| `src/services/scan.service.ts:523` | `executeVersusScan` | `generateContent` | 2 images input |
| `src/services/scan.service.ts:541` | `executeAddonScan` | `generateContent` | text only |
| `src/services/diet.service.ts:141` | `DietService.generateJSON<T>` (private) | `generateContent` | shared by `generateDailyPlan`, `generateWeeklyPlan`, `swapMeal` — **already a single choke point** |
| `src/services/training.service.ts:158` | `TrainingService.generatePlan` (private) | `generateContent` | single choke point already |
| `src/services/chat.service.ts:190` | `chatService.generateStream` | `generateContentStream` | async generator, SSE-backed, per-token yield |
| `src/services/chat.service.ts:225` | `chatService.generateSessionSummary` | `generateContent` | wrapped in try/catch, silently degrades on failure |
| `src/routes/chat.ts:319` | Gemini **Live** relay (`geminiLive.live.connect`) | WebSocket audio session | long-lived, not request/response — needs a different accounting model |

Every non-Live call follows the exact same shape:
```ts
const response = await ai.models.generateContent({ model, contents, config });
if (response.text) { /* parse JSON */ }
throw new Error("Failed to extract text from AI response");
```
None of them reference `response.usageMetadata` anywhere (`Grep` for `usageMetadata` across `src/` returns zero matches).

**Client instantiation is duplicated per-file**, not shared:
- `scan.service.ts:5`, `diet.service.ts:105`, `training.service.ts:57` — module-level `const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY })`.
- `chat.service.ts:156,211` and `routes/chat.ts:54` instantiate a **new** `GoogleGenAI` client per call/per route registration instead of reusing one.

This means there is no existing "Gemini client" abstraction to hook into — a wrapper needs to be introduced, not extended.

### Logging Infrastructure

- Fastify is configured with Pino as `app.log` (`src/app.ts:22-35`), pretty-printed in dev, JSON in production (`NODE_ENV === "production"`). This is the only structured logger in the project.
- Outside route handlers (inside `*.service.ts` files, which are plain singletons/classes with no access to the Fastify instance), the codebase falls back to raw `console.error` (e.g. `chat.service.ts:238`). There is no shared standalone logger export.
- **Implication:** to log token usage consistently from services *and* routes, either (a) export a bare `pino()` instance for services to import, or (b) pass `app.log` down into the service call — the latter would touch every call site's signature, which is a bigger change than this task needs. Option (a) is simpler and matches how `console.error` is already used ad hoc in services today.

### Conventions to Follow

- Response text is always cleaned of ```` ```json ```` fences before `JSON.parse` — same snippet repeated 7 times (`.replace(/\`\`\`json/g, "").replace(/\`\`\`/g, "").trim()`). Not directly relevant to token logging, but confirms this codebase tolerates duplicated boilerplate across call sites rather than always centralizing (so a lightweight wrapper is idiomatic, not a big refactor).
- Errors carry a `statusCode` field via a local `httpError()` helper (`diet.service.ts:129`, `training.service.ts:73`) — any new error paths (e.g. missing `usageMetadata`) should not throw; token logging must be non-fatal since it is an observability concern, not a functional one.
- Model name is a per-file constant (`MANUAL_SCAN_MODEL`, `DIET_MODEL`, `TRAINING_MODEL`, or an inline string literal in `chat.service.ts`/`routes/chat.ts`) — useful to include in the audit log line so token spend can be broken down per model/feature later.

## External Solutions

### Gemini API `usageMetadata` shape (confirmed from installed SDK types)

Source: `node_modules/@google/genai/dist/genai.d.ts` (package version `^1.49.0`, already installed — this is authoritative for this exact codebase, not just generic docs).

**Non-streaming / streaming `generateContent(Stream)`** — `GenerateContentResponse.usageMetadata: GenerateContentResponseUsageMetadata` (`genai.d.ts:4671-4694`):
```ts
class GenerateContentResponseUsageMetadata {
  promptTokenCount?: number;       // INPUT tokens (text+image+etc, incl. cached content if any)
  candidatesTokenCount?: number;   // OUTPUT tokens (the generated response)
  thoughtsTokenCount?: number;     // "thinking" tokens, if the model does extended thinking
  toolUsePromptTokenCount?: number;
  cachedContentTokenCount?: number;
  totalTokenCount?: number;        // sum of prompt + candidates + tool-use + thoughts
  promptTokensDetails?: ModalityTokenCount[];     // per-modality breakdown (text/image/audio/...)
  candidatesTokensDetails?: ModalityTokenCount[];
  trafficType?: TrafficType;
}
```
This is present on the object returned by `ai.models.generateContent(...)` directly — no extra API call needed, no extra latency, it's already inside the same HTTP response.

**Streaming (`generateContentStream`)**: Gemini's streaming protocol attaches `usageMetadata` to the chunks of the stream, with counts accumulating and the **final chunk** carrying the complete totals for the whole request (this is the standard Gemini API streaming behavior, not something added by the SDK). `chat.service.ts`'s `generateStream` currently only reads `chunk.text` and discards the rest of each chunk (`chat.service.ts:196-199`) — the chunk object needs to be inspected for `.usageMetadata` in addition to `.text`, and the last non-empty one captured.

**Live API (`ai.live.connect`, used for the audio video-call relay in `routes/chat.ts`)**: `LiveServerMessage.usageMetadata: UsageMetadata` (`genai.d.ts:7521-7522`, shape at `genai.d.ts:11998-12015`):
```ts
interface UsageMetadata {
  promptTokenCount?: number;
  cachedContentTokenCount?: number;
  responseTokenCount?: number;   // note: named differently than candidatesTokenCount here
  toolUsePromptTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
  promptTokensDetails?: ModalityTokenCount[];
}
```
This arrives as one of the possible `onmessage` payloads during the live session (`routes/chat.ts:336`, the `onmessage: (serverMessage: LiveServerMessage) => {...}` callback) — currently that callback only branches on `serverContent`, never checks `serverMessage.usageMetadata`.

### Option 1: Per-call-site `console.log`/inline logging (minimal effort)
- **Overview:** Add a one-line log statement after each of the 7 `generateContent(Stream)` calls and the Live `onmessage` handler.
- **Pros:** No new files, trivial to review, works immediately.
- **Cons:** 7+ copy-pasted log lines, easy to forget on the next new Gemini call site (this is exactly how the app got into "running without showing tokens" in the first place), no consistent log shape to grep/aggregate for an audit, no per-feature/model breakdown without re-deriving it from ad hoc log lines.
- **Fit:** Low — doesn't solve the actual ask ("agar bisa diaudit" / so it can be audited) since inconsistent ad hoc logs are hard to audit reliably.

### Option 2: Centralized wrapper around the Gemini client (`lib/gemini.ts`)
- **Overview:** One shared module exporting a `geminiClient` (singleton `GoogleGenAI`) plus thin wrapper functions — e.g. `generateContent(params, meta)`, `generateContentStream(params, meta)` — that call the real SDK method, then unconditionally log `{ feature, model, promptTokenCount, candidatesTokenCount, totalTokenCount }` via a shared logger before returning the response untouched. All 7 non-Live call sites swap `ai.models.generateContent(...)` for the wrapper; no other code changes required since the wrapper returns the exact same `GenerateContentResponse`.
- **Pros:** Single place to change if the log format, destination, or extra fields (cost estimate, per-user attribution) need to evolve; impossible to add a new Gemini call site without also getting logging "for free"; consistent structured shape → directly greppable/aggregatable for audit; also becomes the natural place to fix the duplicated-client-instantiation issue found above.
- **Cons:** Touches all 7 call sites' imports (mechanical, low risk — same function signature). The Live API (`ai.live.connect`) doesn't go through `ai.models.*` so it needs its own small logging hook in the `onmessage` callback, not the same wrapper — this is a necessary exception, not a flaw in the approach.
- **Fit:** High — matches the actual audit requirement and the codebase's existing "shared `lib/` helper" convention (`lib/firebase.ts`, `lib/jwt.ts`).

### Option 3: Third-party LLM observability platform (Langfuse, Helicone, etc.)
- **Overview:** Route Gemini calls through a proxy/SDK wrapper from an LLM observability vendor that automatically captures token usage, cost, latency, and gives a dashboard.
- **Pros:** Dashboards/alerting out of the box, cost estimation, no need to hand-roll aggregation later.
- **Cons:** New dependency + likely new external account/API key + network hop (proxy-based ones add latency and a new failure mode) for a codebase that currently has zero observability tooling beyond Pino logs; overkill for "just show me input/output tokens per request" when the SDK already returns that data for free.
- **Fit:** Low for the stated ask right now — worth revisiting later if the team wants dashboards/cost alerts, but not needed to solve "no visibility into token usage today."

## Comparison Matrix

| Criteria | Opt 1: Inline logs | Opt 2: Central wrapper | Opt 3: Observability vendor |
|---|---|---|---|
| Solves the audit need | Partial (inconsistent shape) | Yes | Yes (and more) |
| Implementation effort | Very low | Low | Medium–High |
| Risk of missed call sites later | High | Low (enforced by the wrapper) | Low |
| New dependencies | None | None | Yes (SDK/account) |
| Fits existing conventions | Yes (matches ad hoc `console.error` style) | Yes (matches `lib/` pattern) | No (nothing like it exists here) |
| Covers streaming + Live API | Manual, per-site | Wrapper + one Live-specific hook | Depends on vendor SDK support |

## Recommendations

### Primary Recommendation
Add a small `src/lib/gemini.ts` module (Option 2) that:
1. Owns a single shared `GoogleGenAI` client instance (fixes the current duplicated-instantiation issue as a side effect).
2. Exports wrapper functions mirroring `ai.models.generateContent` / `generateContentStream`, each taking a `feature` label (e.g. `"scan.food"`, `"diet.daily"`, `"training.plan"`, `"chat.stream"`, `"chat.summary"`) so logs can be filtered per feature.
3. After each call/stream completion, logs a structured line with `feature`, `model`, `promptTokenCount`, `candidatesTokenCount`, `totalTokenCount` (and `thoughtsTokenCount`/`cachedContentTokenCount` if present) via a shared Pino instance (a bare `pino()` export usable both from services and, if desired, later merged with `app.log` in routes).
4. For the streaming path, captures `usageMetadata` off the last chunk that carries it (Gemini sends the final cumulative totals on the last chunk of the stream) and logs once when the generator completes.
5. For the Gemini Live relay in `routes/chat.ts`, adds a check for `serverMessage.usageMetadata` inside the existing `onmessage` callback and logs it the same way when present — this cannot go through the same wrapper since it's a persistent WebSocket session, not a single call.
6. Never throws on missing `usageMetadata` — logging failures/absence must be silently tolerated (matches the project's existing pattern of treating summary-generation failures as non-fatal, `chat.service.ts:237-239`).

This directly answers "semua yang menyentuh hit API Gemini mengeluarkan input dan output token setiap request" (everything touching the Gemini API emits input/output tokens per request) with one change surface, and makes it structurally hard to add a new Gemini call site in the future without also getting the logging.

### Alternative Approach
If the team wants this shipped in the next few minutes with the least review overhead, Option 1 (inline `console.log`/`app.log` calls at each of the 7+1 call sites) is acceptable as a stopgap — but should be treated as temporary, since it doesn't prevent future call sites from silently skipping logging. It's straightforward to migrate to Option 2 later once the log shape has been observed in production.

## Open Questions
- Should token counts also be persisted (e.g. Firestore per-user/per-day) for a queryable audit trail, or is structured log output (searchable via existing log tooling / Cloud Logging if deployed there) sufficient for now? This changes scope significantly (schema, write cost) — needs a decision before planning.
- Should the log include a cost estimate (USD) per call, which requires hardcoding/config for per-model Gemini pricing that will drift over time?
- For the Live API (audio) session, should usage be logged per `usageMetadata` message received (Gemini may emit it multiple times during a long session) or only accumulated once at session end?
- Is per-user/per-request attribution needed (e.g. tag logs with `userId`) for the audit, given this is a multi-tenant API? All the service functions above don't currently receive `userId` except where the caller already has it in scope (routes do, most services don't) — worth deciding if the wrapper's `meta` should require it.

## Next Steps
1. Review findings, especially the open questions above (persistence vs. logs-only, cost estimate, per-user attribution).
2. Move to `/specify` or `/plan` for `gemini-token-usage-logging` to turn the recommended wrapper approach into concrete acceptance criteria and a file-by-file change list.
