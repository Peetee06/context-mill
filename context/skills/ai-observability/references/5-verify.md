---
next_step: null
title: AI Observability Setup - Verify
description: Give the user a concrete way to trigger a request, and grade what lands in PostHog rather than what the diff contains
---

You've installed packages, wired the bootstrap, and attached the session id. The last thing this skill produces is a **verification path** the user can run themselves. Don't call the LLM from here — you don't have credentials, and the user should be the one to see the trace show up.

**Grade what lands in PostHog, not what the diff contains.** A correct-looking diff that produces ungrouped traces or a per-call session id is a failed run.

## What "correct" looks like for this app

Derive the expectation from the two answers in `1-begin.md` before you look at anything:

- **One session** containing the traces that belong together — the cardinality you decided on. Two turns of one conversation means two traces under *one* `$ai_session_id`, not two ids.
- **Each trace** holding the generations that request made, grouped rather than one trace per call.
- **Spans only if the app registers tools** *and* the mechanism emits them (agent frameworks, Vercel AI, manual dispatch). On a raw provider SDK with an OTel instrumentor, a generations-only trace is the correct result even when the app uses tools — the instrumentor never sees the app's tool loop.
- **Attribution** to the right person, if the app has a user identifier.

## What to tell the user

Point them at the smallest existing code path that exercises one of the instrumented paths — ideally one that makes more than one model call, so grouping is visible. Pick from what you noted in `1-begin.md`:

- A script (`scripts/`, `bin/`, a `package.json` script) → name it: "Run `npm run <script>`."
- An API route → name it: "Hit `POST /api/chat` with a test message."
- A test that exercises the call → point at that test.
- Nothing existing → sketch a minimal script, but do not add it to the project unless the user asks. Include it in the report as suggested code.

Then, in PostHog: open **Product → LLM Analytics → Traces** (not Generations), open the newest trace, and check it against the expectation above. Triggering a second turn in the same conversation is what proves the session id groups rather than splits. Generation properties worth spot-checking: `$ai_provider`, `$ai_model`, `$ai_input_tokens`, `$ai_output_tokens`, `$ai_latency`.

**Before handing over: prove the imports run.** In the project's environment, import what the instrumentation uses (e.g. `python -c "from posthog.ai.otel import PostHogSpanProcessor"`). If it fails — wrong package version, module not shipped in the installed release — go back to `1-begin.md` and switch variants. Do not ship non-running code with a caveat.

## Failure modes

- **Each generation is its own trace** → the calls aren't sharing a trace: no enclosing call structure on the OTel path, or no shared `posthog_trace_id` on the wrapper path.
- **Every trace has a different `$ai_session_id`** → the id is being minted per call or per request instead of per conversation. This is the most common silent failure; it looks instrumented and groups nothing.
- **No `$ai_session_id` at all** → OTel path: missing from the Resource. Wrapper path: not passed per call.
- **`$ai_provider` names the wrong provider** → the app uses an OpenAI-compatible gateway and the run picked `openai-*`. Back to the `baseURL` rule in `1-begin.md`.
- **Anonymous person** → no distinct id wired.
- **Tool spans missing** → check the mechanism first. On a raw SDK + instrumentor this is expected and correct; do not "fix" it by hand-authoring spans, which ingest drops anyway.

If nothing shows up at all within a minute:

- Confirm the init actually runs — a `print` / `console.log` right after it proves the entry point loaded it.
- Confirm the vendor SDK was imported *after* the init in the process's load order.
- Confirm `POSTHOG_API_KEY` and `POSTHOG_HOST` are set in the env the process actually runs under, not just `.env.example`.

## Do not

- Do not run the vendor SDK yourself.
- Do not embed API keys anywhere to enable a smoke test.
- Do not report a run as done while an instrumentation import fails in the project's environment — switching variants is part of this skill, shipping the caveat is not.
- Do not claim the integration works until the user has confirmed what actually landed. A confirmed flat generation is "bootstrap verified, structure unverified", not done.
- Do not report "wired" as "working" — if you never got confirmation, say "wired, unverified" and let the report surface it.
