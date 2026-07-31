---
next_step: null
title: AI Observability Setup - Verify
description: Give the user a concrete way to trigger a turn, and grade the tree that lands in PostHog rather than the diff
---

You've installed the SDK, swapped in the wrapper, and attached identity. The last thing this skill produces is a **verification path** the user can run themselves. Don't call the LLM from here — you don't have credentials, and the user should be the one to see the trace show up.

**Grade what lands in PostHog, not what the diff contains.** A correct-looking diff that produces ungrouped traces or a per-call session id is a failed run.

## What "correct" looks like for this app

Derive the expectation from the answers in `1-begin.md` before you look at anything:

- **One session** containing the turns that belong together. Two questions in one conversation means two traces under *one* `$ai_session_id`, not two ids.
- **One trace per turn**, containing every generation that turn made — not one trace per model call.
- **A span per tool execution**, if the app registers tools: `$ai_span` events sharing the turn's trace id. On framework variants these arrive on their own; on the wrapper path they're the ones you captured.
- **Attribution** to the right person, if the app has a user identifier.
- **The right provider** on gateway variants — `$ai_provider` should name Groq, DeepSeek, or whichever, never `openai`.

## What to tell the user

Point them at the smallest existing code path that exercises one instrumented turn — ideally one that makes more than one model call, or uses a tool, so the tree has depth. Pick from what you noted in `1-begin.md`:

- A script (`scripts/`, `bin/`, a `package.json` script) → name it: "Run `npm run <script>`."
- An API route → name it: "Hit `POST /api/chat` with a test message."
- A test that exercises the call → point at that test.
- Nothing existing → sketch a minimal script, but do not add it to the project unless the user asks. Include it in the report as suggested code.

Then, in PostHog: open **Product → LLM Analytics → Traces** (not Generations), open the newest trace, and check it against the expectation above. Triggering a second turn in the same conversation is what proves the session id groups rather than splits. Generation properties worth spot-checking: `$ai_provider`, `$ai_model`, `$ai_input_tokens`, `$ai_output_tokens`, `$ai_latency`.

**Before handing over: prove the imports run.** In the project's environment, import what the instrumentation uses (e.g. `python -c "from posthog.ai.openai import OpenAI"`). If it fails — wrong package version, module not shipped in the installed release — go back to `1-begin.md` and switch variants. Do not ship non-running code with a caveat.

## Failure modes

- **Each generation is its own trace** → `posthog_trace_id` wasn't passed, or a fresh one was generated per call instead of per turn.
- **Every trace has a different `$ai_session_id`** → the id is minted per call or per turn instead of per conversation. The most common silent failure: it looks instrumented and groups nothing.
- **No `$ai_session_id` at all** → not passed in `posthog_properties`.
- **`$ai_provider` says `openai` on a gateway app** → the per-call override is missing, and token costs will be wrong.
- **Anonymous person** → `posthog_distinct_id` not passed.
- **Tool calls invisible** → on the wrapper path, the `$ai_span` captures are missing or aren't sharing the turn's `$ai_trace_id`.

If nothing shows up at all within a minute:

- Confirm the wrapper is actually the client being called — an unswapped vendor client silently emits nothing.
- Confirm the PostHog client has the project token and host, from the env the process actually runs under, not just `.env.example`.
- In short-lived scripts, confirm events flush before exit.

## Do not

- Do not run the vendor SDK yourself.
- Do not embed API keys anywhere to enable a smoke test.
- Do not report a run as done while an instrumentation import fails in the project's environment.
- Do not claim the integration works until the user has confirmed what actually landed. A confirmed flat generation is "generations verified, tree unverified", not done.
- Do not report "wired" as "working" — if you never got confirmation, say "wired, unverified" and let the report surface it.
