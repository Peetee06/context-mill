---
next_step: 3-instrument.md
title: AI Observability Setup - Install
description: Declare the packages the installed variant needs - OTel, wrapper, framework hook, or manual capture
---

Declare the packages the variant you installed in `1-begin.md` needs in the project's manifest — and only those. Do not run the package manager here — the base integration's build/verify step (or the user) installs everything in one pass.

Read the manifest first. If any of the required packages is already declared, leave the existing version alone and say so. Match the style of dependencies already in the file (versions, ordering, dev vs. runtime).

## What to add

The linked install page for this variant carries the authoritative command. The shapes below reflect the current defaults across Tier-1 providers.

### Wrapper path

No OTel packages at all:

```
posthog                # Python — ships the posthog.ai.<provider> wrapper clients
```

```
@posthog/ai            # Node — ships the wrapper clients
posthog-node           # Node — the PostHog client the wrapper takes
```

### Python — the OTel path

Three packages:

```
posthog[otel]                                   # PostHog SDK + span processor
opentelemetry-sdk                               # OTel core
opentelemetry-instrumentation-<provider>        # provider auto-instrumentation
```

Examples:

- OpenAI → `opentelemetry-instrumentation-openai-v2`
- Anthropic → `opentelemetry-instrumentation-anthropic`
- LangChain → `opentelemetry-instrumentation-langchain`
- Google Gemini → `opentelemetry-instrumentation-google-generativeai`

The vendor SDK itself (`openai`, `anthropic`, `langchain`, …) is a prerequisite — it should already be declared. Do not add or upgrade it.

### Node — the OTel path

```
@posthog/ai                                     # PostHog span processor
@opentelemetry/sdk-node                         # OTel core (Node)
@opentelemetry/resources                        # resource attributes
@opentelemetry/instrumentation-<provider>       # provider auto-instrumentation
```

Provider instrumentation packages:

- OpenAI → `@opentelemetry/instrumentation-openai`
- Anthropic → `@traceloop/instrumentation-anthropic`
- LangChain → `@traceloop/instrumentation-langchain`
- Google Gemini → `@traceloop/instrumentation-google-generativeai`

### Vercel AI SDK (Node)

No provider instrumentation package — Vercel AI emits OTel spans natively when `experimental_telemetry` is enabled. Just add:

```
@posthog/ai
@opentelemetry/sdk-node
@opentelemetry/resources
```

### Gateway variants (Groq, OpenRouter, Together, Ollama, …)

These use the `openai` SDK against a different host, so the packages are the OpenAI ones — `opentelemetry-instrumentation-openai-v2` (Python) or `@opentelemetry/instrumentation-openai` (Node). There is no per-gateway instrumentation package. The one exception is Portkey, which also needs `portkey-ai`.

### Agent framework variants

Framework variants generally need no OTel instrumentation package at all — the tracing hook ships in the framework or in `posthog` / `@posthog/ai`. Take the package list from the variant's install doc; do not assume the three-package OTel shape above applies.

### Manual-capture path

No OTel packages. Just PostHog core:

```
posthog                # Python
posthog-node           # Node
```

If PostHog core is already installed (it should be — see `1-begin.md`), this file has nothing to add. Skip to `3-instrument.md`, which describes the manual `capture(...)` call shape.

## Do not do

- Do not run `npm install` / `pip install` here.
- Do not edit the lockfile.
- Do not upgrade the vendor SDK.
- Do not add packages for more than one mechanism — no OTel instrumentation packages on a wrapper-path run, and vice versa. The variant's install doc describes exactly one.
