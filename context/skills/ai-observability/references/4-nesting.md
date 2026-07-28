---
next_step: 5-verify.md
title: AI Observability Setup - Nesting
description: Attach the session id so traces group into conversations - and let spans come from the app's own tools rather than authoring them
---

`3-instrument.md` wired the bootstrap, so individual LLM calls now land. This step adds the one piece of structure the bootstrap can't infer.

Two rules. Everything else follows from them.

## Rule 1 — spans come from the app's own tool registration

If the app registers tools with its LLM calls, the tool executions **are** the spans, and the tracing layer emits them. You never hand-author a wrapper span around an ordinary helper function.

An app that registers no tools has no spans. **That is a correct, complete outcome** — a trace of two generations and nothing else is not a failure, and you must not invent spans to make the tree look fuller.

Which layers actually emit tool spans, so you know what to expect at verification:

| Mechanism | Tool spans? |
|---|---|
| Agent / orchestration frameworks (`openai-agents`, `claude-agent-sdk`, LangChain / LangGraph, CrewAI, Pydantic AI, …) | **Yes** — their tracing emits agent, tool, and handoff spans |
| Vercel AI SDK | **Yes** — `ai.toolCall` spans, automatically |
| Manual capture | Only what the app dispatches by hand |
| Raw provider SDK + OTel instrumentor | **No** — see below |

The last row is the one that surprises people. An OTel instrumentor patches only the vendor SDK's own methods (`Messages.create`, `chat.completions.create`, …). A tool the app executes in its own loop never passes through it, so it produces no span; the model's *request* to call that tool is recorded as attributes on the generation (`gen_ai.prompt.N.tool_calls.M.name`), not as a child. On this path a tool-using app still yields a generations-only trace — expected, not a defect to fix.

## Rule 2 — your job is the bootstrap plus identity

The bootstrap is done. Trace grouping is not a separate task: it falls out of the framework's own call structure, because the calls a request makes already share one OTel trace (or one framework run). What's left is the two things only the app can tell you — **which conversation these traces belong to** (`$ai_session_id`) and **who the person is** (the distinct id). Wire both; an unattributed trace is only half-instrumented.

### Where the session id and distinct id go

They follow the same rule, so place them together. **Prefer per-call whenever the mechanism offers it** — per-call identity keeps the bootstrap a literal copy of the install doc, and it stays correct when the app later serves more than one user per process.

| Mechanism | Where identity goes |
|---|---|
| Wrapper client | **Per call** — `posthog_distinct_id` and `posthog_properties={"$ai_session_id": …}` (camelCase in Node) |
| Vercel AI SDK | **Per call** — `experimental_telemetry.metadata` |
| Manual capture | **Per call** — event properties |
| Framework hook | Per call if the framework exposes metadata; otherwise the Resource |
| Raw provider SDK + OTel instrumentor | **Resource attributes only** — see below |

The last row is a real constraint, not a preference. The instrumentor creates the generation span itself, so you cannot pass it per-call metadata, and OTel does not inherit attributes parent→child — putting them on an enclosing span leaves the generation without them. `$ai_session_id` and `posthog.distinct_id` go on the Resource, beside `SERVICE_NAME`, exactly as the install doc shows for `posthog.distinct_id`:

```python
resource=Resource(attributes={
    SERVICE_NAME: "my-app",
    "posthog.distinct_id": USER_ID,      # the doc already shows this one
    "$ai_session_id": SESSION_ID,        # add this line
})
```

Because the Resource is built once at import, both values must be resolvable at module scope. **When they are** — a CLI, a script, a worker, one process serving one user — this is correct and costs two lines. **When they aren't**, the fix is to choose a mechanism with per-call identity (usually the wrapper variant), *not* to defer the bootstrap into an init function so it can receive them. A per-request session on the Resource is wrong regardless: it is global to the process, so every conversation collapses into one id.

If an app must stay on the raw OTel path *and* needs per-request values, use the standard `opentelemetry-processor-baggage` package; do not generate custom `SpanProcessor` classes in user codebases.

If the app has no user identifier at all, leave the distinct id unset and say so in the report — anonymous is a finding, not a blocker. Never invent one, and never substitute the session id for it.

Two details that bite either way: the key is the literal `$ai_session_id` (there is no `posthog.session_id` alias — only `posthog.distinct_id` and `posthog.geoip_disable` are remapped at ingest), and its value may contain only letters, numbers, and `- _ ~ . @ ( ) ! ' : |`. A raw thread id carrying a `/` or `#` is rejected, so check the app's identifier before passing it straight through.

### Always set a session — the graded property is cardinality

Every instrumented app gets an `$ai_session_id`, including one-shot and single-trace apps. Tagging costs nothing, keeps session-level aggregation consistent across the project, and is already correct the day the app grows a second turn.

When the app has no conversation field, **identify the boundary rather than skipping the step**: a CLI or worker run is a session; a server request carrying a thread id uses that; an agent framework run is a session even when it produces exactly one trace.

What must be right is the **cardinality** — one id shared by the traces that belong together. A fresh id minted per call or per trace is *worse than no session at all*: it looks instrumented and groups nothing.

Note the asymmetry with rule 1. Sessions: always set one, inferring the boundary if needed. Tools: never invent one.

## The wrapper path — the fresh-UUID trap

On PostHog's wrapper clients, per-call parameters carry the tree: `posthog_trace_id`, `posthog_distinct_id`, `posthog_properties` (where `$ai_session_id` goes), `posthog_groups`. Node equivalents are camelCase.

`posthog_trace_id` auto-generates a **fresh UUID per call** when omitted, so calls that belong to one request must be handed a shared id explicitly:

```python
from uuid import uuid4

def ask(self, question: str) -> str:
    trace_id = str(uuid4())                       # one per request; reuse for every call in it
    ph = dict(
        posthog_trace_id=trace_id,
        posthog_distinct_id=self.user_id,
        posthog_properties={"$ai_session_id": self.thread_id},
    )
    ...
```

## Manual capture

Only this path wires the tree by hand: every event in a request shares `$ai_trace_id`; child events set `$ai_parent_id` to the parent's trace or span id; `$ai_session_id` goes in properties. The manual-capture install page carries the full property tables.

## Do not

- Do not hand-author wrapper spans around ordinary helper functions — tool registration is what produces spans.
- Do not create spans to fill out a trace when the app registers no tools. "No tools, so no spans" is a finding to report, not a gap to close.
- Do not attach `$ai_session_id` or the distinct id to a hand-authored OTel span. Ingest keeps a span only when an **attribute key** starts with a provider prefix (`gen_ai.` / `ai.` / `traceloop.` / `pydantic_ai.`); the span *name* is never consulted, so such a span is dropped silently and takes those values with it.
- Do not mint a fresh session id per call or per trace — cardinality is the graded property.
- Do not put a runtime-varying `$ai_session_id` or distinct id on the Resource.
- Do not rely on an omitted `posthog_trace_id` to group wrapper-SDK calls.
- Do not ship a code path whose imports failed in the project's environment — go back to `1-begin.md` and take the next viable variant instead of shipping the caveat.
