---
next_step: 5-verify.md
title: AI Observability Setup - Nesting
description: Build the session → trace → span → generation tree on top of the bootstrap — this step is mandatory, not optional polish
---

The instrumentation from `3-instrument.md` captures each LLM call in isolation. It has no concept of what constitutes a *request* (a trace), a *conversation* (a session), or a *non-LLM step* (a span) — those are application semantics only the code can tell you. Without this step, a request that makes two model calls with a lookup in between lands as two disconnected single-generation traces, no session, no user attribution, and the lookup invisible. The product is built around the tree; flat generations degrade it to a per-call cost log.

Use the structure map you wrote down in `1-begin.md`. This step turns it into code.

## The nesting model

One vocabulary, every variant:

| Concept | Property | Notes |
|---|---|---|
| Session | `$ai_session_id` | optional; groups traces (a conversation, workflow, thread) |
| Trace | `$ai_trace_id` | **required**; groups one request's events |
| Span | `$ai_span` event + `$ai_span_id` / `$ai_span_name` | a non-LLM step (retrieval, tool call, validation) |
| Generation | `$ai_generation` event | one LLM call |
| Tree edge | `$ai_parent_id` | parent is a `trace_id` or another `span_id` |

The mechanism was chosen at the gate in `1-begin.md` and wired in `3-instrument.md` — use that path's section below. If its imports fail in the project's environment during verification (some `posthog` releases don't ship `posthog.ai.otel` — 6.9.3, which older Pythons silently resolve to, doesn't; 7.29.0 does), return to the gate and take the next viable path; don't ship the caveat.

## The wrapper path

Per-call parameters, no manual spans needed. Python kwargs: `posthog_trace_id`, `posthog_distinct_id`, `posthog_properties` (put `$ai_session_id` here), `posthog_groups`. Node equivalents are camelCase (`posthogTraceId`, …).

**Trap:** `posthog_trace_id` auto-generates a *fresh UUID per call* when omitted. To group multiple calls into one trace you must pass a shared id explicitly:

```python
from uuid import uuid4

def ask(self, question: str) -> str:
    trace_id = str(uuid4())                       # one per request; reuse for every call in it
    ph = dict(
        posthog_trace_id=trace_id,
        posthog_distinct_id=self.user_id,
        posthog_properties={"$ai_session_id": self.thread_id},
    )
    category = self._classify(question, ph)       # client.messages.create(..., **ph)
    order = lookup_order(self.user_id) if category == "order_status" else None
    return self._answer(question, category, order, ph)
```

Non-LLM steps worth seeing: emit a `$ai_span` event with `posthog.capture()` sharing the same `$ai_trace_id` (shape below, under manual capture).

## The OTel path

Three goals, three separate mechanisms — don't conflate them:

**Trace grouping — an enclosing span, any name, zero attributes.** Auto-instrumented generations inside it inherit its OTel trace context in-process, so they share one `$ai_trace_id`. The enclosing span itself does **not** need to survive ingest (or carry anything) for this to work:

```python
def ask(self, question: str) -> str:
    with tracer.start_as_current_span("support_request"):   # name is irrelevant to ingest
        category = self._classify(question)                 # generation, same trace
        order = self._lookup_order(category)
        return self._answer(question, category, order)      # generation, same trace
```

**Session + user — two Resource attributes in the bootstrap you already wrote.** Ingest copies Resource attributes onto every surviving event (only `host.` / `process.` / `os.` / `telemetry.` prefixes are filtered), and `posthog.distinct_id` on the Resource is the documented identity mechanism:

```python
resource=Resource(attributes={
    SERVICE_NAME: "my-app",
    "posthog.distinct_id": user_id,      # already in the install docs
    "$ai_session_id": session_id,        # add this line; process-global
})
```

Resource attributes are process-global by nature — fine when one process serves one session/user. An app on the OTel path whose session/user vary per request should reconsider the wrapper at the `1-begin.md` gate first. If an app genuinely must stay on OTel *and* needs per-request values, use the standard `opentelemetry-processor-baggage` package — do not generate custom `SpanProcessor` classes in user codebases.

**Non-LLM step — a manual `$ai_span` event via `posthog.capture()`** (the `posthog` client class ships in the package you already installed), sharing the OTel trace id:

```python
from opentelemetry import trace as otel_trace

def _lookup_order(self, category: str) -> dict | None:
    if category != "order_status":
        return None
    result = lookup_order(self.user_id)
    ctx = otel_trace.get_current_span().get_span_context()
    posthog.capture(
        distinct_id=self.user_id,
        event="$ai_span",
        properties={
            "$ai_trace_id": format(ctx.trace_id, "032x"),   # same trace as the generations
            "$ai_span_name": "lookup_order",
        },
    )
    return result
```

Or omit it and say so in the report — "no non-LLM step worth tracing" is a finding.

**Why not hand-authored OTel spans with attributes?** Ingest keeps a span only if an **attribute key** starts with a provider prefix (`gen_ai.` / `ai.` / `traceloop.` / `pydantic_ai.`) — the span *name* is never consulted. A hand-made span carrying only `$ai_session_id` or `posthog.distinct_id` is silently dropped, taking those values with it. Don't fight this rule; put session/user on the Resource and non-LLM steps through `capture()`, as above.

## Manual capture

Emit `$ai_trace` / `$ai_span` / `$ai_generation` events explicitly and wire the tree yourself: every event in a request shares `$ai_trace_id`; child events set `$ai_parent_id` to the parent's `trace_id` or `span_id`; `$ai_session_id` goes in properties. The manual-capture install page carries the full property tables.

## What to actually edit

For each request-shaped code path you mapped in `1-begin.md`:

1. Group its LLM calls into one trace (shared `posthog_trace_id`, enclosing span, or shared `$ai_trace_id` — per the gate's branch).
2. Set `$ai_session_id` from the conversation identifier, if the app has one (wrapper: `posthog_properties`; OTel: Resource).
3. Set the distinct id from the user identifier, if the app has one (wrapper: `posthog_distinct_id`; OTel: Resource `posthog.distinct_id`).
4. Emit `$ai_span` events for non-LLM steps worth seeing (retrieval, tool calls, validation).

Keep it minimal: instrument the representative paths you mapped, don't refactor the app. If the app genuinely has no conversation or user concept, say so in the report — omitting a session is a finding, not a failure.

## Do not

- Do not attach `$ai_session_id` or the distinct id only to a hand-authored OTel span — ingest drops spans without provider-prefixed attribute keys (names are never consulted). Put them on the Resource (process-global) or the wrapper's per-call params (per-request).
- Do not rely on omitted `posthog_trace_id` to group wrapper-SDK calls — each call gets its own fresh UUID.
- Do not put a runtime-varying `$ai_session_id` or distinct id on the Resource — the Resource is process-global; per-request identity belongs on the wrapper path.
- Do not ship a code path whose imports failed in the project's environment — switch to the gate's next mechanism instead.
- Do not skip this step because generations already appear in PostHog. Flat generations are the failure mode this step exists to prevent.
