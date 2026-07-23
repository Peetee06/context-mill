---
next_step: 2-install.md
title: AI Observability Setup - Begin
description: Pick the right variant, locate the LLM call sites, map the app's session/trace/span structure, and choose the instrumentation mechanism before editing
---

Before touching any code, decide which variant of this skill to install, confirm the two prerequisites, and get a read on where in the project LLM calls actually happen. AI Observability instruments an existing setup — if the setup isn't there, this skill can't do its job.

## Pick the variant

The `ai-observability` skill has one variant per LLM provider × language (e.g. `ai-observability-openai-python`, `ai-observability-anthropic-node`, …). You are running the group-level entry; before installing, pick the specific variant that matches this project.

Scan the manifest (`package.json`, `pyproject.toml`, `requirements.txt`, `Gemfile`) for a vendor LLM package. Typical package names:

- OpenAI — `openai`
- Anthropic — `@anthropic-ai/sdk` (Node) or `anthropic` (Python)
- LangChain — `langchain` / `@langchain/core` (plus a provider adapter like `langchain-openai` / `@langchain/openai`)
- Vercel AI SDK — `ai` (plus a provider like `@ai-sdk/openai`)
- Google Gemini — `google-genai` (Python) or `@google/genai` (Node)

Decision rules — apply in order:

1. **Exactly one vendor SDK found** → pick the corresponding variant. Language follows the manifest (`package.json` → Node, `pyproject.toml`/`requirements.txt` → Python). Tell the user which variant you picked and why in a `[STATUS]` line, then call `install_skill` with the full variant id (e.g. `ai-observability-openai-python`).
2. **Multiple vendor SDKs found** (e.g. LangChain wraps OpenAI, so both may be declared) → prefer the higher-level abstraction: LangChain > direct provider SDK. If still ambiguous, use `wizard_ask` to have the user pick, listing the candidates as options.
3. **No vendor SDK found** → install `ai-observability-manual-capture`. This variant posts `$ai_generation` events explicitly and works without any auto-instrumentation.
4. **You're not sure** → `wizard_ask` the user with a multi-choice picker listing every provider you have a variant for. Do not guess when there's real ambiguity.

## Check for an existing PostHog setup (informational — not a blocker)

Grep the project for one of:

- `posthog.init(` — most JS/TS SDKs
- `PostHog(` — Python, Ruby, Go SDK constructors
- `AddPostHog(` — .NET DI registration

**This is not a prerequisite.** The OTel-based variants use `PostHogSpanProcessor`, a self-contained exporter that just takes an API key + host — it does not depend on a `posthog.init(...)` call anywhere. The `manual-capture` variant uses `posthog.capture(...)`, which needs the traditional SDK, but the install step will add it if it isn't there.

If a `posthog.init(...)` (or equivalent) **is** already present, note the env-var names it reads (`POSTHOG_API_KEY`, `NEXT_PUBLIC_POSTHOG_KEY`, etc.) and reuse them in `3-instrument.md` — don't invent parallel names. If nothing is there, `3-instrument.md` will set fresh values via `set_env_values`.

## Locate the LLM call sites

Grep for where the vendor SDK is imported and called. This is not a full analysis — one or two representative sites is enough for you to reason about where OTel initialization has to run before those calls execute:

- OpenAI: `import OpenAI`, `openai.OpenAI(`, `new OpenAI(`
- Anthropic: `Anthropic(`, `new Anthropic(`
- LangChain: `ChatOpenAI(`, `from langchain`, `import { ChatOpenAI } from '@langchain/openai'`
- Vercel AI: `generateText(`, `streamText(`, `import ... from 'ai'`
- Google Gemini: `genai.Client(`, `new GoogleGenerativeAI(`

Note the app's entry point (server startup file, `main.py`, `index.ts`, `instrumentation.ts` in Next.js, etc.) — on the OTel path, init must run there *before* the vendor SDK is imported; the wrapper path edits the call sites instead.

## Map the logical structure

Instrumentation captures individual LLM calls; the *tree* that makes them useful — session → trace → span → generation — comes from application semantics only the code can tell you. Answer these four questions now, from the code, and write the answers down; `4-nesting.md` consumes them:

- **What is one session here?** The unit of conversation — a conversation object, a thread id, a workflow run. Some apps have none; that's a valid answer.
- **What is one trace?** The unit of request — typically a request handler or the top-level function that may make several model calls to produce one result.
- **Which non-LLM steps deserve spans?** Retrieval, tool calls, validation — steps between model calls worth seeing in the trace.
- **What is the distinct-id source?** A `user_id` in scope at the call sites? None → events will be anonymous; note that too.

## Choose the mechanism

There are three ways to instrument: a **PostHog wrapper client** (per-call params), **OTel auto-instrumentation** (bootstrap + enclosing spans), and **manual capture** (explicit events). Do not default to OTel — pick from this gate, in order, using the variant and the structure map above:

1. **App already runs OpenTelemetry**, or its spans must also fan out to non-PostHog backends → **OTel**.
2. **Variant has a PostHog wrapper client** — Python `posthog` ships `posthog.ai.{openai,anthropic,gemini,langchain,openai_agents,claude_agent_sdk}`; Node `@posthog/ai` ships `{openai,anthropic,gemini,vercel}` — → **wrapper**. Simplest path, and the only one that handles per-request user/conversation identity without extra machinery.
3. **Anything else** (most provider variants have no wrapper) → **OTel**.
4. **No vendor SDK at all** → you already picked the `manual-capture` variant above → **manual capture**.

Record the choice — `2-install.md` and `3-instrument.md` branch on it. If the chosen mechanism's imports fail in the project's environment at verification time, come back to this gate and take the next viable path; do not ship non-running code.

Do not edit yet. Once you have the entry point, the call sites, the structure map, and the mechanism, move on to `2-install.md`.
