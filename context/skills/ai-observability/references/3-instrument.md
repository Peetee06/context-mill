---
next_step: 4-nesting.md
title: AI Observability Setup - Instrument
description: Wire the mechanism chosen at the gate - wrapper client swap, OTel bootstrap, or manual capture
---

**The variant you installed determines the mechanism, and its installation doc is the source of truth** — copy the bootstrap from there rather than adapting a different variant's shape. The doc will describe one of four families:

| Family | Who uses it | Shape |
|---|---|---|
| **OTel bootstrap** | most provider variants, and the gateway variants | `TracerProvider` + `PostHogSpanProcessor` + a provider instrumentor |
| **PostHog wrapper client** | variants where `posthog.ai.*` / `@posthog/ai` ships a drop-in | swap the client constructor, no entry-point work |
| **Framework hook** | agent frameworks and Vercel AI | the framework's own tracing processor, callback, or `experimental_telemetry` |
| **Manual capture** | `manual-capture` | explicit `capture()` calls at the call site |

Wire exactly one. Whatever the family, this step captures individual generations only — attaching the session id is `4-nesting.md`'s job, and it is a mandatory part of this skill, not optional polish.

## Environment variables (all mechanisms)

Route the PostHog credentials through env vars, using the wizard's `set_env_values` tool (never hardcode). Reuse whatever names the base PostHog integration already set — typically:

- the public project token (e.g. `POSTHOG_API_KEY`, `NEXT_PUBLIC_POSTHOG_KEY`, or the framework's convention)
- the PostHog host (e.g. `POSTHOG_HOST`, `NEXT_PUBLIC_POSTHOG_HOST`)

If the project has an `.env.example` file, add the names there with empty placeholder values so collaborators know what to set. Create `.env.example` if it doesn't exist. Never write real secrets to any file.

## The wrapper path

No OTel, no entry-point work. Swap the vendor client for PostHog's drop-in wrapper at the module where the client is constructed, and hand it a PostHog client:

```python
from posthog import Posthog
from posthog.ai.anthropic import Anthropic          # swap per provider: posthog.ai.openai, .gemini, …

posthog = Posthog(os.environ["POSTHOG_API_KEY"], host=os.environ["POSTHOG_HOST"])
client = Anthropic(posthog_client=posthog)          # same constructor args as the vendor client otherwise
```

```typescript
import { PostHog } from 'posthog-node'
import { Anthropic } from '@posthog/ai/anthropic'   // swap per provider: @posthog/ai/openai, /gemini, /vercel

const posthog = new PostHog(process.env.POSTHOG_API_KEY!, { host: process.env.POSTHOG_HOST! })
const client = new Anthropic({ posthog })
```

The wrapper is call-compatible with the vendor client — existing `client.messages.create(...)` / `client.chat.completions.create(...)` calls keep working unchanged and now emit `$ai_generation` events. The per-call `posthog_*` params (trace id, distinct id, session) are `4-nesting.md`'s job. The linked install page carries the exact import for this variant.

## The OTel path

One initialization call per app. It runs once, at startup, before any vendor SDK call. The linked install page carries the exact code for this variant's language — copy from there.

### Python — the standard OTel path

Wire a `TracerProvider` with `PostHogSpanProcessor`, then call `.instrument()` on the provider-specific instrumentor:

```python
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.resources import Resource, SERVICE_NAME
from posthog.ai.otel import PostHogSpanProcessor
from opentelemetry.instrumentation.openai_v2 import OpenAIInstrumentor   # swap per provider

provider = TracerProvider(resource=Resource(attributes={SERVICE_NAME: "my-app"}))
provider.add_span_processor(PostHogSpanProcessor(
    api_key=os.environ["POSTHOG_API_KEY"],
    host=os.environ["POSTHOG_HOST"],
))
trace.set_tracer_provider(provider)

OpenAIInstrumentor().instrument()
```

### Node — the standard OTel path

Use `NodeSDK` with `PostHogSpanProcessor` and the provider instrumentation. Start it before importing the vendor SDK in the app's entry point:

```typescript
import { NodeSDK } from '@opentelemetry/sdk-node'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { PostHogSpanProcessor } from '@posthog/ai/otel'
import { OpenAIInstrumentation } from '@opentelemetry/instrumentation-openai'   // swap per provider

const sdk = new NodeSDK({
  resource: resourceFromAttributes({ 'service.name': 'my-app' }),
  spanProcessors: [new PostHogSpanProcessor({
    apiKey: process.env.POSTHOG_API_KEY!,
    host: process.env.POSTHOG_HOST!,
  })],
  instrumentations: [new OpenAIInstrumentation()],
})
sdk.start()
```

For Next.js / Nuxt / other frameworks that expose a dedicated startup hook (`instrumentation.ts`, `nuxt.config`'s server plugin, etc.), put the SDK init there. It must run once per process, not per request.

### Agent frameworks — a tracing processor, not OTel

Agent SDKs carry their own tracing layer, and the PostHog integration plugs into *that*. `openai-agents` and `claude-agent-sdk` register a processor rather than a `TracerProvider`; LangChain-family variants use a callback handler. Take the exact registration from the variant's install doc — wiring an OTel instrumentor underneath one of these captures the model calls but loses the agent, tool, and handoff structure that makes the framework worth instrumenting.

### Vercel AI SDK

No instrumentor package. Initialize `NodeSDK` with just `PostHogSpanProcessor` (no `instrumentations` array), then pass `experimental_telemetry` per call:

```typescript
const result = await generateText({
  model: openai('gpt-5-mini'),
  prompt: '...',
  experimental_telemetry: { isEnabled: true, functionId: 'my-ai-function' },
})
```

If the project has many call sites, wrap the config into a shared helper rather than repeating it inline.

## The PostHog client (wrapper + manual paths)

The wrapper and manual-capture paths need a PostHog client instance. Look for a reusable one before creating anything:

- Search the project for an existing client: a `posthog-js` init on the frontend, a `PostHog` instance from `posthog` / `posthog-node` on the backend.
- Frontend: the client is a singleton — always reuse it, never instantiate a second one.
- Backend: reuse a shared instance if the project has one; if none exists, create one where the instrumentation lives — once, at module level, reused across call sites — and use it when initializing the wrappers.

## The manual-capture path

No OTel, no wrapper. Capture each generation explicitly at the call site:

```python
posthog.capture(
    distinct_id="user_123",
    event="$ai_generation",
    properties={
        "$ai_provider": "openai",
        "$ai_model": "gpt-4",
        "$ai_input": [{"role": "user", "content": prompt}],
        "$ai_output_choices": [{"role": "assistant", "content": response}],
        "$ai_input_tokens": usage.prompt_tokens,
        "$ai_output_tokens": usage.completion_tokens,
        "$ai_latency": latency_seconds,
    },
)
```

Refer to `/docs/ai-observability/manual-capture` for the full property list.

## Do not

- Do not wire more than one mechanism — the variant's install doc describes exactly one.
- Do not substitute an OTel instrumentor for a framework's own tracing hook. If the variant is an agent framework, its processor is the integration.
- Do not create a PostHog client where one already exists — search first and reuse it (the frontend client is a singleton). Only a backend with no client creates one, once, at module level. Either way, reuse the project token / host already in the app's env — this is a separate exporter, not a separate PostHog install.
- Do not put client or SDK init inside a request handler. Once per process, at module level or startup.
- OTel path: do not import the vendor SDK above the OTel init in the same file — the instrumentor patches the SDK when it loads, so the order matters.
