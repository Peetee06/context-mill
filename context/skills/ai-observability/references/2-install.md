---
next_step: 3-instrument.md
title: AI Observability Setup - Install
description: Declare the packages the installed variant needs - almost always just the PostHog SDK alongside the vendor SDK
---

Declare the packages the variant you installed in `1-begin.md` needs in the project's manifest — and only those. Do not run the package manager here — the base integration's build/verify step (or the user) installs everything in one pass.

Read the manifest first. If any required package is already declared, leave the existing version alone and say so. Match the style of dependencies already in the file (versions, ordering, dev vs. runtime).

## The default: PostHog's SDK wrapper

Every direct provider (OpenAI, Anthropic, Google, Azure OpenAI, Mistral, Cohere, …) and every OpenAI-compatible gateway (Groq, OpenRouter, Together, Ollama, DeepSeek, xAI, Perplexity, Fireworks, Cerebras, Hugging Face, Dedalus, Portkey, Helicone, Cloudflare AI Gateway) installs the same two things — **AWS Bedrock is the one exception, and it is still OTel-based; see below**:

```
posthog                # Python — ships the posthog.ai.<provider> wrapper clients
```

```
@posthog/ai            # Node — the wrapper clients
posthog-node           # Node — the PostHog client the wrapper takes
```

**No OpenTelemetry packages.** There is no `opentelemetry-sdk`, no `posthog[otel]`, and no `opentelemetry-instrumentation-<provider>` on this path. If you find yourself reaching for one, you're on the wrong mechanism — go back to `3-instrument.md`.

The vendor SDK itself (`openai`, `anthropic`, `@anthropic-ai/sdk`, …) is a prerequisite and should already be declared. Do not add or upgrade it.

Portkey is the one gateway needing an extra package: `portkey-ai`.

## Framework variants

Agent and orchestration frameworks (LangChain, LangGraph, CrewAI, DSPy, LiteLLM, OpenAI Agents, Claude Agent SDK, Vercel AI, Mirascope, Instructor, …) ship their tracing hook inside `posthog` / `@posthog/ai` or the framework itself. Take the package list from the variant's install doc; don't assume the shape of another family.

## The OpenTelemetry variants

Three cases still use the OTel packages: the `opentelemetry-{python,node}` variants, LlamaIndex, and **AWS Bedrock** — Bedrock has no wrapper client and instruments the AWS SDK instead (`opentelemetry-instrumentation-botocore` in Python, `@opentelemetry/instrumentation-aws-sdk` in Node). Take its exact list from its install doc; it differs from the generic pair below.

```
posthog[otel]                                   # Python — PostHog SDK + span processor
opentelemetry-sdk
```

```
@posthog/ai                                     # Node — PostHog span processor
@opentelemetry/sdk-node
@opentelemetry/resources
```

## Manual-capture path

Just PostHog core:

```
posthog                # Python
posthog-node           # Node
```

## Do not do

- Do not run `npm install` / `pip install` here.
- Do not edit the lockfile.
- Do not upgrade the vendor SDK.
- Do not add OpenTelemetry packages to a wrapper-path run. That is the most common wrong turn in this step, and it is wrong for every provider and gateway variant.
