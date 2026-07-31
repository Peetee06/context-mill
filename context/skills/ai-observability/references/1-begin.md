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

These variants share one install shape — PostHog's OpenAI wrapper pointed at the provider's `base_url` — but **identifying the provider still matters**. PostHog prices tokens by `$ai_model` + `$ai_provider`, and the wrapper reports `openai` whatever host it targets, so a gateway call has to send the real provider explicitly (`4-nesting.md` covers how). Getting the variant right is what tells you which slug to send. Portkey additionally needs the `portkey-ai` package.

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

**This is not a prerequisite.** The wrapper takes its own PostHog client built from a project token and host — it does not depend on a `posthog.init(...)` anywhere, and `2-install.md` adds the SDK if it isn't there. If one **is** present, note the env-var names it reads (`POSTHOG_API_KEY`, `NEXT_PUBLIC_POSTHOG_KEY`, …) and reuse them in `3-instrument.md`; don't invent parallel names. Reuse the client instance too rather than creating a second one.

## Locate the LLM call sites

Grep for where the chosen SDK is imported and called. On the wrapper path you need **two** things: the module where the vendor client is **constructed** (that constructor gets swapped in `3-instrument.md`), and the **call sites** themselves, since identity is attached per call in `4-nesting.md`. Note the tool-dispatch loop too if the app has one — its executions become spans.

## Answer the following question

Instrumentation captures individual LLM calls. The structure that makes them useful comes from application semantics only the code can tell you. Write the answers down; `4-nesting.md` consumes them and nothing else.

**What identifies the conversation and the user, and where does one turn begin and end?**

- **Conversation** — a `thread_id` / `conversationId` field, a session row, a request parameter, or nothing explicit, in which case the process run *is* the conversation. This becomes `$ai_session_id`.
- **User** — a `user_id` or equivalent in scope at the call sites, or none, in which case events are anonymous. Note that rather than inventing an identifier.
- **Turn** — the function or handler that takes one question and produces one answer, however many model calls it makes inside. This becomes one trace, and every call inside it shares one trace id.

All three are attached per call, so you don't need to know whether they vary within the process — you just need to know where to read them at the call site.

Note as well **whether the app registers tools** with its LLM calls (a `tools=` argument, a tool registry, a framework decorator). If it does, their executions need capturing as spans in `4-nesting.md`.

Do not edit yet. Once you have the variant, the entry point, the call sites, and those answers, move on to `2-install.md`.
