# Scratch Markdown Mode

PatchPilot's API runtime uses the Postgres repository layer from `@patchpilot/db` and defaults to local PGlite when no external Postgres URL is configured. The local `.scratch` Markdown mode is a separate prototype/import-export surface for agents and CLI experiments, not an automatic second source of truth.

## Files

- Work items live under `.scratch/work-items/<id>.md`.
- Run reports live under `.scratch/run-reports/<id>.md`.
- Each Markdown file contains a fenced JSON metadata block, followed by human-readable Markdown body content.

## Locking

`@patchpilot/scratch-store` claims a work item while holding `.scratch/.patchpilot/locks/work-items/<id>.lock`.

- Locks are acquired with atomic directory creation.
- The claimant rereads the Markdown file while holding the lock.
- Active leases are fenced by `claimToken`.
- Expired leases can be reclaimed.
- Stale lock directories are reaped after the configured timeout.

This means multiple local workers can race to claim the same `.scratch` work item and only one will write the claimed state.

## Boundary

The Postgres repository is authoritative for the current Web/API/worker MVP. Markdown mode is explicit import/export through `@patchpilot/scratch-store`; it does not silently sync with API state. JSON snapshots remain a compatibility fixture import/export format, but they are not the live runtime store.
