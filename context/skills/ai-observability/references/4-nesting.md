---
next_step: 5-verify.md
title: AI Observability Setup - Nesting
description: Build the session → trace → span → generation tree on top of the bootstrap — this step is mandatory, not optional polish
---

The bootstrap from `3-otel-setup.md` captures each LLM call in isolation. It has no concept of what constitutes a *request* (a trace), a *conversation* (a session), or a *non-LLM step* (a span) — those are application semantics only the code can tell you. Without this step, a request that makes two model calls with a lookup in between lands as two disconnected single-generation traces, no session, no user attribution, and the lookup invisible. The product is built around the tree; flat generations degrade it to a per-call cost log.

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

## Three ways to express it — branch by variant

The model is constant; only the API changes. Pick the branch matching the mechanism you installed.

### OTel auto-instrumentation (most variants)

Wrap each logical operation in an **enclosing span**. Auto-instrumented generations nest under it automatically because they share the OTel trace context — spans in one OTel trace share `$ai_trace_id`, and a child's `parent_span_id` becomes `$ai_parent_id`. Nothing else is needed for trace grouping.

```python
def ask(self, question: str) -> str:
    with tracer.start_as_current_span(
        "ai.support_request",                     # ai.* prefix — required, see below
        attributes={
            "$ai_session_id": self.thread_id,     # groups this thread's traces
            "posthog.distinct_id": self.user_id,  # attributes to the person
        },
    ):
        category = self._classify(question)       # generation, nests automatically
        order = self._lookup_order(category)      # span, see below
        return self._answer(question, category, order)

def _lookup_order(self, category: str) -> dict | None:
    if category != "order_status":
        return None
    with tracer.start_as_current_span("ai.lookup_order"):   # non-LLM step
        return lookup_order(self.user_id)
```

**The `ai.*` naming rule — silent-failure trap.** PostHog keeps a span only if its name *or an attribute key* begins with `gen_ai.`, `llm.`, `ai.`, or `traceloop.`. Everything else is dropped without error. An enclosing span named `handle_request` or a `lookup_order` span **vanishes** — taking its session and distinct-id attributes with it. Every manual span on the OTel path must be named `ai.*` (e.g. `ai.support_request`, `ai.lookup_order`). This is the single most likely way a well-intentioned run still produces a broken tree.

**Session and distinct-id propagation.** OTel does not inherit attributes parent→child, and PostHog's processor adds no baggage propagation. A **Resource** attribute is process-global — fine only when one process equals one session/user. A **runtime-varying** session or user must be set as an attribute on every span you want grouped (in practice: the enclosing span of each request, as above). If per-request attribution matters and the variant has a wrapper SDK, prefer the wrapper — its per-call params sidestep this.

### Wrapper SDK (`openai`, `anthropic`, `gemini`, `langchain`, `vercel`, `openai-agents` wrapper clients)

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

### `manual-capture`

Emit `$ai_trace` / `$ai_span` / `$ai_generation` events explicitly and wire the tree yourself: every event in a request shares `$ai_trace_id`; child events set `$ai_parent_id` to the parent's `trace_id` or `span_id`; `$ai_session_id` goes in properties. The manual-capture install page carries the full property tables.

## What to actually edit

For each request-shaped code path you mapped in `1-begin.md`:

1. Group its LLM calls into one trace (enclosing span, shared `posthog_trace_id`, or shared `$ai_trace_id` — per the branch above).
2. Set `$ai_session_id` from the conversation identifier, if the app has one.
3. Set the distinct id from the user identifier, if the app has one.
4. Wrap non-LLM steps worth seeing (retrieval, tool calls, validation) as spans — `ai.*`-named on the OTel path.

Keep it minimal: instrument the representative paths you mapped, don't refactor the app. If the app genuinely has no conversation or user concept, say so in the report — omitting a session is a finding, not a failure.

## Do not

- Do not name a manual OTel span anything that doesn't start with `ai.` — it will be silently dropped.
- Do not rely on omitted `posthog_trace_id` to group wrapper-SDK calls — each call gets its own fresh UUID.
- Do not put a runtime-varying `$ai_session_id` or distinct id only on the Resource — the Resource is process-global.
- Do not skip this step because generations already appear in PostHog. Flat generations are the failure mode this step exists to prevent.
