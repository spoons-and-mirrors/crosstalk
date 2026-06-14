# Crosstalk State Maintenance

## Motivation

Crosstalk now persists durable pair and message state on disk. Operators need a quick way to inspect that state without opening `state.json` manually, especially after dogfooding, corruption quarantine events, or long-running paired sessions.

## Proposal

Add crosstalk maintenance/status behavior that reports state health and optionally supports export/compact operations.

Possible UI:

- Extend `/crosstalk` status output with maintenance details.
- Or add a focused command shape like `/crosstalk state`, `/crosstalk export`, and `/crosstalk compact`.
- Or expose these through `crosstalk({"action":"status"})` plus future maintenance actions.

## Acceptance Criteria

- Status output includes the crosstalk state path.
- Status output includes pair count.
- Status output includes message count.
- Status output includes corrupt backup count.
- Status output lists recent corrupt backup filenames or paths when present.
- Maintenance output does not expose full message bodies by default.
- If export is implemented, it writes a readable snapshot of pairs/messages to a chosen or generated path.
- If compact is implemented, it applies the same TTL/cleanup rules safely and reports what changed.
- Behavior is covered by tests using `OPENCODE_CROSSTALK_DIR` temp directories.

## Implementation Notes

- Add read-only state summary helpers in `src/room.ts` near `statePath()`.
- Reuse the existing state directory and corrupt backup naming pattern: `state.corrupt.<timestamp>.<pid>.json`.
- Keep user/model-visible strings in `src/prompts.ts`.
- Avoid returning full message bodies in summary/status output.
- Prefer read-only summary first; export/compact can be follow-up actions if the command surface starts getting too large.

## Testing Notes

- Create a temp crosstalk state directory with multiple pairs/messages and assert summary counts.
- Create fake corrupt backup files and assert they are counted/listed.
- Assert status output includes `statePath()`.
- Assert summary output excludes full message bodies.
- If compact is implemented, seed expired messages and verify they are removed while active messages remain.
- If export is implemented, assert the export file is created and contains the expected schema.
