---
next_step: 5-verify.md
title: AI Observability Setup - Nesting
description: Attach per-call identity and capture tool calls as spans so the session tree is complete
---

`3-instrument.md` wired the client, so individual LLM calls now land. This step builds the tree they belong to: **session → trace → span → generation**. It is the reason this skill exists, and a run that stops at the previous step is incomplete.

Use the answer you wrote down in `1-begin.md`.

## Identity goes on the call

The wrapper takes three per-call parameters. Node uses camelCase (`posthogDistinctId`, `posthogTraceId`, `posthogProperties`).

| What | Where | Cardinality |
|---|---|---|
| **Session** | `posthog_properties={"$ai_session_id": …}` | one id shared by every turn of the conversation |
| **Trace** | `posthog_trace_id` | **a new id per turn** — one request in, one answer out |
| **User** | `posthog_distinct_id` | the person the conversation belongs to |

```python
import uuid

session_id = "conversation-abc"      # same across every turn of this conversation
trace_id = str(uuid.uuid4())         # one per turn
distinct_id = "user_123"

response = client.chat.completions.create(
    model=MODEL,
    messages=[...],
    tools=tools,
    posthog_distinct_id=distinct_id,
    posthog_trace_id=trace_id,
    posthog_properties={"$ai_session_id": session_id},
)
```

Every call that belongs to one turn must be handed **the same** `posthog_trace_id`. Omitting it does not group them — the wrapper mints a fresh UUID per call, which produces one lonely trace per generation.

To capture events anonymously, omit `posthog_distinct_id` rather than inventing an id.

### Gateways must also send `$ai_provider`

`posthog.ai.openai` reports `openai` as the provider whatever host it points at. PostHog prices tokens by `$ai_model` + `$ai_provider`, so a Groq or DeepSeek call left at the default is mispriced or fails to match. Override it per call:

```python
posthog_properties={"$ai_session_id": session_id, "$ai_provider": "groq"},
```

Use the provider slug matching the variant you installed. This applies to every OpenAI-compatible gateway and to nothing else.

## Capture tool calls as spans

**When the app registers tools, you capture their executions as `$ai_span` events.** The wrapper captures the model call as a generation; it does not see your tool-dispatch loop, so nothing else will record it. Emit one event per tool call, sharing the turn's `$ai_trace_id`:

```python
import time, json, uuid

for call in response.choices[0].message.tool_calls:
    start = time.time()
    result = get_weather(**json.loads(call.function.arguments))

    posthog.capture(
        distinct_id=distinct_id,
        event="$ai_span",
        properties={
            "$ai_trace_id": trace_id,                  # ties the span to the generation
            "$ai_session_id": session_id,
            "$ai_span_id": str(uuid.uuid4()),
            "$ai_span_name": call.function.name,
            "$ai_input_state": call.function.arguments,
            "$ai_output_state": result,
            "$ai_latency": time.time() - start,
        },
    )
```

The span joins the tree through `$ai_trace_id` — the same id the generation carried. Keep the capture next to the existing dispatch; do not restructure the tool loop to accommodate it.

**Framework variants are the exception.** Agent SDKs and the Vercel AI SDK emit tool spans through their own tracing (`ai.toolCall` and friends), so on those paths you add nothing. An app that registers no tools has no spans, and that is a complete outcome — never invent one to make a trace look fuller.

## Always set a session — the graded property is cardinality

Every instrumented app gets an `$ai_session_id`, including one-shot and single-trace apps. Tagging costs nothing, keeps aggregation consistent across the project, and is already right the day the app grows a second turn.

When the app has no conversation field, **identify the boundary rather than skipping the step**: a CLI or worker run is a session; a server request carrying a thread id uses that; an agent framework run is a session even when it produces exactly one trace.

What must be right is the **cardinality** — one id shared by the traces that belong together, and one trace per turn beneath it. An id minted per call is worse than none: it looks instrumented and groups nothing.

Two details that bite: the key is the literal `$ai_session_id` (there is no `posthog.session_id` alias), and its value may contain only letters, numbers, and `- _ ~ . @ ( ) ! ' : |`. A thread id carrying a `/` or `#` is rejected, so check before passing one straight through.

## Manual capture

The manual path wires the same tree by hand: every event in a turn shares `$ai_trace_id`, spans carry their own `$ai_span_id`, and `$ai_session_id` goes in properties. The manual-capture install page carries the full property tables.

## Do not

- Do not omit `posthog_trace_id` and expect calls to group — each one gets a fresh UUID.
- Do not mint a fresh session id per call or per turn. One conversation, one id.
- Do not leave a gateway call reporting `$ai_provider: "openai"` — token pricing depends on it.
- Do not restructure the app's tool loop to add span capture; the capture sits alongside the existing dispatch.
- Do not create spans when the app registers no tools, and do not add them on framework paths that already emit their own.
- Do not hand-author OpenTelemetry spans for any of this. These are `capture()` events, not OTel spans.
- Do not ship a code path whose imports failed in the project's environment — go back to `1-begin.md` and take the next viable variant instead of shipping the caveat.
