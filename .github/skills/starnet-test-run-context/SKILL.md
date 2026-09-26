---
name: starnet-test-run-context
description: "Use when a user describes a StarNet test scenario they already ran, reports observed behavior, asks what happened in a session, or wants the exact sequence from a test. Inspect persisted run, transcript, and background-worker records before diagnosing from memory or prompt text."
user-invocable: false
---

# StarNet Test Run Context

Use local StarNet records to reconstruct scenarios that have already run. Treat persisted evidence as authoritative for what the harness recorded, and distinguish it from interpretation.

## Procedure

1. Find the workspace root used by the sidecar that ran the test. Honor any configured workspace override or isolated test workspace. On Windows, the default is `%LOCALAPPDATA%\StarNet\workspaces`; `sidecar/index.js` documents the legacy `%LOCALAPPDATA%\Skynet\workspaces` fallback. Do not assume the default when the test launch set another root.
2. Search `runs.jsonl` (and its rotated sibling, if present) by approximate timestamp, title, agent, or known `runId`. Run rows provide outcome, `runId`, `parentRunId`, `streamId`, `agentId`, failure stage/code, and ordered `toolTrace` entries. Use trace timestamps when available; the run row timestamp is the completion time.
3. Correlate child runs using `parentRunId` and the worker records in `subagents.json`. Inspect the worker prompt, status, result, run ID, and persisted lifecycle/error events. A queued/running label alone does not prove the worker reached `agent.run.start`.
4. Read `transcript-history-v2/` for the matching `streamId` and `sourceRunId`. It can provide chronological user, assistant, and tool messages, tool results, and tool-call fields when persisted. Use it to add detail to the compact run trace, not to replace run outcome evidence.
5. For active or unsettled runs, inspect `.run-journal/` or the authenticated `/api/run-recoveries` route if the sidecar is available. The journal can contain checkpoints and tool intent/dispatch/result boundaries. Finished journals are normally retired after the transcript is durably acknowledged, so a missing journal does not prove a run never happened.
6. Build a concise timeline across lead and worker runs. Include UTC timestamps, run IDs, ordered tool names/outcomes, and relevant error text. State which parts are directly recorded and which are inferred from correlation.
7. Compare the recorded behavior with the current checkout and the sidecar process that handled the test. Source edits do not hot-reload an already-running sidecar. Old prompt wording, tool summaries, or behavior can indicate the test used a stale process; say this is evidence of a stale run, not proof, unless the process/version is known.

## Record Limits

- `toolTrace` records names, outcomes, durations, and summaries; it does not generally retain raw tool arguments or full results. Transcript entries may contain `toolCalls` and `toolCallId`, but do not assume every run persisted them.
- Transcript and tool output can contain private task data or untrusted external content. Read only the relevant run, quote only necessary excerpts, and never expose credentials or tokens.
- Background-worker event history is bounded. A missing event or record may reflect retention, a different workspace, or a failed persistence path; do not turn absence into proof of non-execution.
- `/api/runs` and `/api/transcript` are read-only inspection routes when the local sidecar is running and the caller is already authenticated. Do not ask the user to paste an API token; prefer the local files when the route is unavailable.

## Source Map

- `sidecar/index.js`: workspace selection, run/transcript/journal locations, and inspection routes.
- `sidecar/runstore.js`: durable run outcome and compact tool-trace fields.
- `sidecar/transcriptstore.js`: transcript fields and `streamId`/`sourceRunId` correlation.
- `sidecar/run-journal.js`: active-run checkpoint and tool-boundary evidence.
- `sidecar/subagents.js`: durable background-worker status, prompt, result, and event tail.
