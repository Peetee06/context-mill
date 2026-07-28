# Mirror the report into a PostHog notebook

Once `posthog-setup-report.md` exists, mirror it into a shareable PostHog notebook
so the user has an in-app copy to link and comment on. The notebook is an extra
copy, not a replacement — keep the local report file in place.

First `Read` the finished `posthog-setup-report.md` (don't reconstruct it from
memory, and don't read it before the report step has written it). Then create the
notebook in a single `notebooks-create` call through `posthog_exec` — that exact
tool name, no tool search — with a `title` and `content` that wraps the report in
one `ph-markdown-notebook` node:

```json
{
  "title": "PostHog setup (wizard) – <repo name>",
  "content": { "type": "doc", "content": [
    { "type": "ph-markdown-notebook", "attrs": { "nodeId": "markdown-notebook-v2", "markdown": "<report contents>" } }
  ]}
}
```

The report goes in verbatim, but `markdown` is a JSON string field: build the
whole argument as one valid JSON value so the report's newlines and quotes are
escaped as normal JSON string encoding (`\n`, `\"`, `\\`). Never paste raw
multi-line text into the JSON — a literal newline inside the string fails with
"Bad control character". And `exec` is not a shell: pass the JSON bare, never
wrapped in quotes — `call notebooks-create '{...}'` fails with "Unexpected
token" because the quotes reach the JSON parser.

A rejected call is one of those two mistakes far more often than it is size —
a full multi-page report goes through in one call when encoded correctly, so
fix the encoding first and never trim the report just to make it parse. Only
when correctly-encoded content still fails, split the transport: create the
notebook with the first sections, then send the rest with
`notebooks-partial-update` (same `posthog_exec`), passing the `short_id` **and
the `version` from the create response** (`0` on a fresh notebook) plus the
full `content` doc with the remaining `ph-markdown-notebook` nodes appended.
Content updates without a matching `version` are rejected with a 409 "Someone
else edited the Notebook" — that error means your `version` is missing or
stale, not that the payload is malformed; `notebooks-retrieve` the current one
(each successful update increments it) and resend.
The reader still gets the whole report; only the transport is split. Either way
the file at the project root stays complete.

Take the `short_id` from the response, build the URL as
`<host>/project/<project_id>/notebooks/<short_id>`, and emit it on its own line in
your final message with this exact marker so the wizard surfaces it:
`[NOTEBOOK_URL] <url>`. A URL only in prose, without the marker, is dropped.
