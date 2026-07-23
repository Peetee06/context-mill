# PostHog AI Observability for {display_name}

Wire up PostHog's AI Observability so calls made through {display_name} land in LLM Analytics as a full **session → trace → span → generation** tree — not just isolated `$ai_generation` events.

## Prerequisite — vendor LLM SDK

This skill instruments the LLM calls the project *already makes*. It does **not** install the vendor SDK for you.

Check the project's manifest for the provider's package (e.g. `openai`, `@anthropic-ai/sdk`, `langchain`, `ai`, `@google/genai`). If a vendor SDK is present, pick the matching variant. If none is present, switch to the `manual-capture` variant — it posts `$ai_generation` events directly and works standalone.

Everything else this skill needs — PostHog credentials, instrumentation packages, env vars — the skill installs and configures itself. It does **not** require a pre-existing `posthog.init(...)`. If one is already there, reuse its env-var names in `3-instrument.md`; if not, that step sets fresh values via `set_env_values`.

## Steps

Read every referenced file **before editing**. Then work through them in order:

1. **Begin** — see `references/1-begin.md`. Pick the right variant from the vendor SDK the project declares, locate the LLM call sites, map the app's logical structure (what a session, trace, span, and user are in this codebase), and choose the instrumentation mechanism at the gate — wrapper client, OTel, or manual capture. Do not default to OTel.
2. **Install** — see `references/2-install.md`. Declare the chosen mechanism's packages in the manifest — and only those.
3. **Instrument** — see `references/3-instrument.md`. Wire the chosen mechanism: swap in the PostHog wrapper client, or initialize the OTel TracerProvider with `PostHogSpanProcessor`, or set up manual capture. Route the project token / host through environment variables.
4. **Build the nesting** — see `references/4-nesting.md`. Group each request's calls into one trace, attach session and distinct id, and wrap non-LLM steps as spans. Mandatory — the bootstrap alone produces flat, disconnected generations.
5. **Verify** — see `references/5-verify.md`. Describe a request the user can trigger and how to confirm the tree — grouped trace, session, attribution — lands in PostHog, not just a lone `$ai_generation`.

## Reference files

{references}

The linked install page carries the exact code blocks for this variant's language. Prefer copying from there over reconstructing from memory — package names and initialization shapes change between AIO releases.

## Key principles

- **Environment variables.** Read `<ph_project_token>` and `<ph_client_api_host>` from env, using the framework's env-var convention. Never hardcode either value.
- **One mechanism, chosen deliberately.** Wrapper client, OTel, or manual capture — the gate in `1-begin.md` picks exactly one; don't default to OTel or wire two.
- **Minimal changes.** The wrapper swaps a client import; OTel init is a single call at process start, placed alongside any existing PostHog init. Don't restructure the app either way.
- **Match the docs.** Package names, instrumentor imports, and processor names change between AIO releases. The install page for this variant is the source of truth.
- **The tree is the deliverable.** A run that only produces flat `$ai_generation` events is incomplete. Nesting (`4-nesting.md`) is part of setup, not a follow-up.
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
