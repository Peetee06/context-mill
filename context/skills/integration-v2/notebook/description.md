# Mirror the report into a PostHog notebook

Once the setup report markdown is composed, mirror it into a shareable PostHog
notebook so the user has an in-app copy to link and comment on. No report file
is written to the project — the notebook and the `publish_handoff` call are how
the report reaches the user.

Use the exact report markdown you composed — the same content you pass to
`publish_handoff`, verbatim, not a summary of it. Create the notebook in a
single `notebooks-create` call through `posthog_exec` — that exact tool name,
no tool search — with a `title` and `content` that wraps the report in one
`ph-markdown-notebook` node.

The exec command is `call notebooks-create` followed by the bare JSON argument —
no quotes around it, and the whole argument on one line with the report's
newlines and quotes escaped as normal JSON string encoding (`\n`, `\"`, `\\`):

```
call notebooks-create {"title": "PostHog setup (wizard) – acme-shop", "content": {"type": "doc", "content": [{"type": "ph-markdown-notebook", "attrs": {"nodeId": "markdown-notebook-v2", "markdown": "# PostHog setup report\n\n## Events captured\n\n| Event | Where |\n|---|---|\n| `user_signed_up` | `src/auth.ts` |\n\nInitialized with \"capture_exceptions: true\" in `src/posthog.ts`.\n"}}]}}
```

Wrong, and their exact errors:

```
call notebooks-create '{"title": ...}'      → "Unexpected token" (quotes reach the JSON parser)
call notebooks-create {"...": "line one
line two"}                                  → "Bad control character" (literal newline in a JSON string)
```

A full multi-page report goes through in one call when encoded this way — never
trim the report just to make it parse. If a correctly-encoded payload still
fails, split the transport: create the notebook with the first sections, then
append the rest with `notebooks-partial-update`, passing the `short_id` and
`version` from the create response (`0` on a fresh notebook; each successful
update increments it) and the full `content` doc with the remaining
`ph-markdown-notebook` nodes appended:

```
call notebooks-partial-update {"short_id": "AbCdEfGh", "version": 0, "content": {"type": "doc", "content": [{"type": "ph-markdown-notebook", "attrs": {"nodeId": "markdown-notebook-v2", "markdown": "<sections already sent>"}}, {"type": "ph-markdown-notebook", "attrs": {"nodeId": "markdown-notebook-v2-part2", "markdown": "<remaining sections>"}}]}}
```

`version` is required on every content update — a 409 "Someone else edited the
Notebook" means it is missing or stale (fetch the current one with
`notebooks-retrieve` and resend), not that the payload is malformed.
The reader still gets the whole report; only the transport is split.

Take the `short_id` from the response, build the URL as
`<host>/project/<project_id>/notebooks/<short_id>`, and emit it on its own line in
your final message with this exact marker so the wizard surfaces it:
`[NOTEBOOK_URL] <url>`. A URL only in prose, without the marker, is dropped.
