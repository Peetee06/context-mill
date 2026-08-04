---
next_step: 4-nesting.md
title: AI Observability Setup - Instrument
description: Swap the vendor client for PostHog's wrapper - the default path for every provider and gateway
---

**The PostHog SDK wrapper is the default mechanism.** OpenTelemetry is no longer the recommended path for provider or gateway variants: it makes the full session tree awkward to build and maintain, which is exactly what this skill exists to produce. Use OTel only where the variant's install doc actually calls for it.

| Family | Who uses it | Shape |
|---|---|---|
| **Wrapper client** | every direct provider and OpenAI-compatible gateway, except AWS Bedrock | swap the client constructor, hand it a PostHog client |
| **Framework hook** | agent frameworks and Vercel AI | the framework's own callback, tracing processor, or `experimental_telemetry` |
| **OTel bootstrap** | the `opentelemetry-*` variants, LlamaIndex, and AWS Bedrock | `TracerProvider` + `PostHogSpanProcessor` |
| **Manual capture** | `manual-capture` | explicit `capture()` calls at the call site |

Wire exactly one. This step makes generations land; attaching identity and capturing tool calls is `4-nesting.md`'s job, and it is mandatory, not optional polish.

## Match the doc's shape

**Copy the install doc's code block and change only the values.** The setup belongs at module level where the client is constructed — typically under ten lines. Adding structure around it is the most common way this step goes wrong:

- **No init function.** Don't wrap it in `init_observability(...)` or similar.
- **No module-level globals** held "for later". Nothing needs to reach them afterwards.
- **No extra env-var scaffolding.** `os.environ["POSTHOG_API_KEY"]` already fails loudly and idiomatically when unset — a separate presence check that raises is duplicated ceremony around a short snippet.

## Environment variables (all mechanisms)

Route the PostHog credentials through env vars using the wizard's `set_env_values` tool (never hardcode). Reuse whatever names the base PostHog integration already set — typically the project token (`POSTHOG_API_KEY`, `NEXT_PUBLIC_POSTHOG_KEY`, or the framework's convention) and the host (`POSTHOG_HOST`).

If the project has an `.env.example`, add the names there with empty placeholders. Create it if absent. Never write real secrets to any file.

## The wrapper path

Create a PostHog client, then swap the vendor client for PostHog's drop-in wrapper:

```python
from posthog import Posthog
from posthog.ai.anthropic import Anthropic      # swap per provider: posthog.ai.openai, .gemini, …

posthog = Posthog(os.environ["POSTHOG_API_KEY"], host=os.environ["POSTHOG_HOST"])
client = Anthropic(posthog_client=posthog)      # otherwise the vendor client's constructor args
```

```typescript
import { PostHog } from 'posthog-node'
import { Anthropic } from '@posthog/ai/anthropic'

const posthog = new PostHog(process.env.POSTHOG_API_KEY!, { host: process.env.POSTHOG_HOST! })
const client = new Anthropic({ posthog })
```

The wrapper is call-compatible with the vendor client — existing `client.messages.create(...)` / `client.chat.completions.create(...)` calls keep working and now emit `$ai_generation` events. The per-call `posthog_*` params are `4-nesting.md`'s job.

### Gateways — the same wrapper, pointed elsewhere

An OpenAI-compatible gateway uses `posthog.ai.openai` with the provider's `base_url`. No entry-point work, no instrumentor:

```python
from posthog.ai.openai import OpenAI

client = OpenAI(
    base_url="https://api.groq.com/openai/v1",   # the provider's host
    api_key=os.environ["GROQ_API_KEY"],
    posthog_client=posthog,
)
```

Because the wrapper reports `openai` as the provider by default, gateway calls must override it per call — see `4-nesting.md`.

## Framework hooks

Agent SDKs carry their own tracing layer and the PostHog integration plugs into *that*: `openai-agents` and `claude-agent-sdk` register a processor, LangChain-family variants use a callback handler, Vercel AI uses `experimental_telemetry`. Take the exact registration from the variant's install doc. Do not substitute an OTel instrumentor — it captures the model calls but loses the agent, tool, and handoff structure that makes the framework worth instrumenting.

## The PostHog client

Every path above needs a PostHog client instance. Look for a reusable one before creating anything:

- Search for an existing client: `posthog-js` on the frontend, `PostHog` from `posthog` / `posthog-node` on the backend.
- Frontend: the client is a singleton — always reuse it.
- Backend: reuse a shared instance if one exists; otherwise create one where the instrumentation lives, once, at module level.

## The OTel bootstrap (only where the doc calls for it)

```python
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.resources import Resource, SERVICE_NAME
from posthog.ai.otel import PostHogSpanProcessor

provider = TracerProvider(resource=Resource(attributes={SERVICE_NAME: "my-app"}))
provider.add_span_processor(PostHogSpanProcessor(
    api_key=os.environ["POSTHOG_API_KEY"],
    host=os.environ["POSTHOG_HOST"],
))
trace.set_tracer_provider(provider)
```

It must run once per process, at startup, before the vendor SDK is imported.

## The manual-capture path

Capture each generation explicitly at the call site with `$ai_generation` and the properties from the install page (`$ai_provider`, `$ai_model`, `$ai_input`, `$ai_output_choices`, token counts, `$ai_latency`), carrying the `$ai_trace_id` from `4-nesting.md`.

## Do not

- Do not wire more than one mechanism — the variant's install doc describes exactly one.
- Do not reach for OpenTelemetry on a provider or gateway variant. The wrapper is the path.
- Do not substitute an OTel instrumentor for a framework's own tracing hook.
- Do not create a PostHog client where one already exists — search first and reuse it. Reuse the project token / host already in the app's env.
- Do not put client or SDK init inside a request handler. Once per process, at module level.
