---
next_step: 2-install.md
title: AI Observability Setup - Begin
description: Pick the right variant from the full catalog, locate the LLM call sites, and answer the two questions that drive the whole integration
---

Before touching any code, decide which variant of this skill to install, confirm the prerequisites, and get a read on where in the project LLM calls actually happen. AI Observability instruments an existing setup — if the setup isn't there, this skill can't do its job.

## Pick the variant

This skill ships **68 variants** — one per (provider × language), plus agent frameworks, gateways, and a manual fallback. You are running the group-level entry. Call `load_skill_menu` with `category: "ai-observability"` and treat that list as the source of truth; the families below tell you what to look for in the project.

Apply these rules **in order**. The first match wins — the order matters, because frameworks wrap providers and gateways impersonate them.

### 1. An agent or orchestration framework → use its variant, not the provider's

These wrap the provider SDK. Instrumenting the provider underneath captures the model calls but loses the framework's own structure (tool spans, handoffs, agent steps), and on some of them the provider instrumentor captures nothing at all.

| Package in the manifest | Variant |
|---|---|
| `openai-agents` | `openai-agents` |
| `claude-agent-sdk` | `claude-agent-sdk` |
| `langchain`, `@langchain/core` | `langchain-{python,node}` |
| `langgraph`, `@langchain/langgraph` | `langgraph-{python,node}` |
| `ai` (Vercel AI SDK) | `vercel-ai` |
| `llama-index`, `llamaindex` | `llamaindex` |
| `crewai` | `crewai` |
| `pyautogen`, `autogen-agentchat` | `autogen` |
| `dspy` / `dspy-ai` | `dspy` |
| `pydantic-ai` | `pydantic-ai` |
| `semantic-kernel` | `semantic-kernel` |
| `smolagents` | `smolagents` |
| `mirascope` | `mirascope` |
| `instructor` | `instructor-{python,node}` |
| `litellm` | `litellm` |
| `mastra`, `@mastra/core` | `mastra` |
| `convex` | `convex` |

### 2. A provider SDK with a `baseURL` / `base_url` override → prefer the gateway's variant

Most OpenAI-compatible providers ship no SDK of their own; apps reach them with the `openai` package pointed at another host — `api.groq.com`, `openrouter.ai`, `localhost:11434`, `api.together.xyz`, and so on. Check the `openai` client's construction and `OPENAI_BASE_URL` in env files, then pick the variant naming that provider from the menu.

Keep the stakes straight: these variants instrument **identically** — same packages, same `OpenAIInstrumentor`, same bootstrap. Choosing the matching one gets the provider named correctly in the report and the run record; it does not generate different code. If the host matches no variant you can find, `openai-*` produces the same result. One real exception: **Portkey** additionally needs the `portkey-ai` package.

### 3. A direct provider SDK, no override → that provider's variant

`openai` → `openai-*`; `anthropic` / `@anthropic-ai/sdk` → `anthropic-*`; `google-genai` / `@google/genai` → `google-*`; `mistralai` → `mistral-*`; `cohere` → `cohere-*`; `boto3` + `bedrock-runtime` → `aws-bedrock-*`.

### 4. Everything else

- **Several candidates and no framework** → prefer the higher-level abstraction; if still ambiguous, `wizard_ask` the user with the candidates as options.
- **The app already emits OTel spans for its LLM calls itself** → `opentelemetry-{python,node}`.
- **No LLM SDK at all** → `ai-observability-manual-capture`, which posts events explicitly.
- **Genuinely unsure** → `wizard_ask` with a multi-choice picker. Do not guess when there's real ambiguity.

Language follows the manifest (`package.json` → Node, `pyproject.toml`/`requirements.txt` → Python); framework-only variants have no language suffix. Tell the user which variant you picked **and why** in a `[STATUS]` line, then call `install_skill` with the full id (e.g. `ai-observability-groq-node`).

## Check for an existing PostHog setup (informational — not a blocker)

Grep for `posthog.init(`, `PostHog(`, or `AddPostHog(`.

**This is not a prerequisite.** The OTel-based variants use `PostHogSpanProcessor`, a self-contained exporter taking an API key + host — it does not depend on a `posthog.init(...)` anywhere. If one **is** present, note the env-var names it reads (`POSTHOG_API_KEY`, `NEXT_PUBLIC_POSTHOG_KEY`, …) and reuse them in `3-instrument.md`; don't invent parallel names.

## Locate the LLM call sites

Grep for where the chosen SDK is imported and called — one or two representative sites is enough to reason about where init has to run. Note the app's **entry point** (server startup file, `main.py`, `index.ts`, `instrumentation.ts` in Next.js): on the OTel path, init must run there *before* the vendor SDK is imported.

## Answer the two questions

Instrumentation captures individual LLM calls. The structure that makes them useful comes from application semantics only the code can tell you — and it reduces to two questions. Write the answers down; `4-nesting.md` consumes them and nothing else.

**1. Does the app register tools with its LLM calls?** Look for a `tools=` / `tools:` argument, a tool registry, or a framework's tool decorator. This decides whether the trace should contain spans at all — you never author them by hand, so the answer is "which spans should already be there", not "which should I add".

**2. What identifies the conversation and the user, and do they vary within the process?** For the conversation: a `thread_id` / `conversationId` field, a session row, a request parameter — or nothing explicit, in which case the process run *is* the conversation. For the user: a `user_id` or equivalent in scope at the call sites — or none, in which case events are anonymous. Note that rather than inventing an identifier.

Both answers share one consequence, which is why they're one question: whether they vary per request decides **where** they have to live. A server handling many users' threads sets both per call; a CLI or worker sets them once at startup.

Do not edit yet. Once you have the variant, the entry point, the call sites, and those two answers, move on to `2-install.md`.
