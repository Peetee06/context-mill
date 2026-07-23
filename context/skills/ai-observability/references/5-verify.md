---
next_step: null
title: AI Observability Setup - Verify
description: Give the user a concrete way to trigger a request and confirm the full trace tree — not just a lone generation — lands in PostHog
---

You've installed packages, wired OTel init, and built the nesting from `4-nesting.md`. The last thing this skill produces is a **verification path** the user can run themselves. Don't call the LLM from here — you don't have credentials, and the user should be the one to see the trace show up in their project.

**The bar is the tree, not a single event.** A lone `$ai_generation` appearing proves the bootstrap works; it does not prove the integration is done. If only flat generations show up, the run is **incomplete** — go back to `4-nesting.md`.

## What to tell the user

Point them at the smallest existing code path that exercises one of the request paths you instrumented in `4-nesting.md` — ideally one that makes more than one model call, so trace grouping is actually visible. Pick from what you noted in `1-begin.md`:

- If the project has a script (`scripts/`, `bin/`, a `package.json` script) that calls the LLM, name it: "Run `npm run <script>` (or `python scripts/<file>.py`) to trigger one request."
- If the LLM is called from an API route, name the route: "Hit `POST /api/chat` with a test message."
- If the LLM lives inside a test, point at that test.
- If there is no existing call path, sketch a minimal one — a short script that exercises one instrumented request path — but do not add it to the project unless the user asks. Include it in the report as suggested code.

## What they should see

After triggering one request:

1. In PostHog, open **Product → LLM Analytics → Traces** (not just Generations).
2. Open the newest trace. **One trace** should contain all the generations that request made — plus any spans you added — as children, not one trace per call.
3. If the app has a conversation concept, trigger a second request in the same conversation: both traces should share the same `$ai_session_id`.
4. If a distinct id was wired, the trace should be attributed to that person in Persons, not anonymous.
5. Generation properties worth spot-checking: `$ai_provider`, `$ai_model`, `$ai_input_tokens`, `$ai_output_tokens`, `$ai_latency`.

Failure modes and what they mean:

- **Each generation is its own trace** → the enclosing span isn't wrapping the calls (OTel path), or calls aren't sharing a `posthog_trace_id` (wrapper path). Back to `4-nesting.md`.
- **Generations appear but your manual spans don't** → the spans aren't `ai.*`-named; they're being silently dropped. Rename them.
- **No `$ai_session_id` / anonymous person** → the attributes were set on the Resource (process-global) instead of per-request, or not at all.

If nothing shows up at all within a minute:

- Confirm the OTel init actually runs — a `console.log` / `print` immediately after `sdk.start()` (or `.instrument()`) proves the entry point loaded it.
- Confirm the vendor SDK was imported *after* the OTel init in the process's load order.
- Confirm `POSTHOG_API_KEY` and `POSTHOG_HOST` were set in the env the process is actually running under, not just `.env.example`.

## Do not

- Do not run the vendor SDK yourself.
- Do not embed API keys anywhere to enable a smoke test.
- Do not claim the integration works until the user has confirmed the **tree** — grouped trace, session (if applicable), attribution (if applicable). A confirmed flat generation is "bootstrap verified, nesting unverified", not done.
- Do not claim the integration works until the user has confirmed anything at all. Report it as "wired, unverified" if you never got confirmation — the report step will surface that.
