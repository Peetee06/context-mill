# PostHog AI Observability for {display_name}

Wire up PostHog's AI Observability so calls made through {display_name} land in LLM Analytics as a full **session → trace → span → generation** tree — not just isolated `$ai_generation` events.

## Prerequisite — vendor LLM SDK

This skill instruments the LLM calls the project *already makes*. It does **not** install the vendor SDK for you.

Check the project's manifest for an LLM package. The catalog is far wider than the obvious providers — 68 variants covering agent frameworks (`openai-agents`, `claude-agent-sdk`, LangGraph, CrewAI, Mastra, …) and OpenAI-compatible gateways (Groq, OpenRouter, Together, Ollama, …), which an app reaches through the `openai` package plus a `baseURL` override. `1-begin.md` carries the ordered decision rules; follow them rather than matching on the first familiar package name. If no LLM SDK is present, switch to the `manual-capture` variant — it posts `$ai_generation` events directly and works standalone.

Everything else this skill needs — PostHog credentials, instrumentation packages, env vars — the skill installs and configures itself. It does **not** require a pre-existing `posthog.init(...)`. If one is already there, reuse its env-var names in `3-instrument.md`; if not, that step sets fresh values via `set_env_values`.

## Steps

Read every referenced file **before editing**. Then work through them in order:

1. **Begin** — see `references/1-begin.md`. Pick the right variant using the ordered rules (framework before provider, gateway `baseURL` before the SDK it borrows), locate the LLM call sites, and answer the two questions that drive everything after: does the app register tools, and what identifies one conversation?
2. **Install** — see `references/2-install.md`. Declare the variant's packages in the manifest — and only those.
3. **Instrument** — see `references/3-instrument.md`. Wire the bootstrap the variant's install doc describes: OTel `TracerProvider` + `PostHogSpanProcessor`, a PostHog wrapper client, a framework tracing hook, or manual capture. Route the project token / host through environment variables.
4. **Attach the session** — see `references/4-nesting.md`. Give the traces that belong to one conversation a shared `$ai_session_id`. Mandatory. Spans are *not* your job — they come from the app's own tool registration.
5. **Verify** — see `references/5-verify.md`. Describe a request the user can trigger, and grade what lands in PostHog — one session, grouped traces, right attribution — rather than what the diff contains.

## Reference files

{references}

The linked install page carries the exact code blocks for this variant's language. Prefer copying from there over reconstructing from memory — package names and initialization shapes change between AIO releases.

## Key principles

- **Environment variables.** Read `<ph_project_token>` and `<ph_client_api_host>` from env, using the framework's env-var convention. Never hardcode either value.
- **One mechanism, and the variant chooses it.** The install doc for the variant you picked names the mechanism; wire that one and no other. Never swap a framework's own tracing hook for an OTel instrumentor.
- **Minimal changes.** The wrapper swaps a client import; OTel init is a single call at process start, placed alongside any existing PostHog init. Don't restructure the app either way.
- **Match the docs.** Package names, instrumentor imports, and processor names change between AIO releases. The install page for this variant is the source of truth.
- **Sessions always, spans never.** Every run attaches an `$ai_session_id`, inferring the conversation boundary when the app has no explicit field — one id shared by the traces that belong together. Spans are the opposite: they come from the app's registered tools, and an app with no tools correctly has none. Never hand-author a span to make a trace look fuller.
- **Don't touch what isn't yours.** This skill instruments LLM observability only — generations, traces, sessions, spans. Identify calls, event tracking, error tracking, and dashboards belong to the base `integration` skill — do not add or edit them here.

## Emit a run record

When you finish, write `.posthog-wizard-cache/.posthog-ai.json` at the project root:

```json
{ "provider": "openai", "package": "@posthog/ai", "otel_init_file": "src/instrumentation.ts" }
```

On the wrapper or manual-capture path there is no OTel init — set `otel_init_file` to the file where the wrapper client (or capture helper) was wired instead.

The `report/` step reads this file to render an AI Observability section in the setup report. If the cache directory does not exist, create it.

## Framework guidelines

{commandments}
