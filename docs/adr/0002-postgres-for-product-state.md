# ADR-0002: Postgres for Product State

Status: accepted

Date: 2026-06-11

## Context

PatchPilot has several state surfaces that solve different problems today.

This repo uses local `.scratch/` Markdown files as its agent issue tracker and planning record. The agent-platform PRD, technical design, and TODO list live there. Separately, `docs/scratch-markdown-mode.md` describes a prototype/import-export Markdown mode for work items and run reports, backed by `@patchpilot/scratch-store` and file locks.

The current runnable Web/API/worker MVP does not use that Markdown mode as a live store. It uses `PatchPilotStore` in `services/api/src/store.ts`, which persists a normalized `PatchPilotSnapshot` to `patchpilot-store.json` for local iteration and CI-friendly tests. That JSON snapshot currently exposes Requirements, PRDs, Work Items, Interface Contracts, Agent Runs, Workspace Runs, Test Cases, Test Runs, Pull Request records, Review records, Approvals, Audit Events, Defects, budgets, and artifacts through `/api/snapshot`.

`TD-201` has already added `packages/db` with a Drizzle/Postgres schema and migration covering the production product-state tables: organizations, projects, repositories, requirements, prd_versions, work_items, interface_contracts, test_cases, test_runs, defects, agents, agent_runs, workspace_runs, pull_requests, approvals, audit_events, artifacts, capability_manifests, and budgets. `TD-202` is the planned migration from the JSON store to a Postgres repository layer.

ADR-0001 decides that Temporal owns durable workflow execution state. It deliberately leaves product state and query projections to the repository layer chosen here.

## Decision Drivers

- PatchPilot product state needs transactional updates across related records such as Work Item claim fencing, Agent Run status changes, TestRun evidence, Pull Request records, Approvals, and Audit Events.
- Professional Mode needs queryable, filterable product facts without scanning Markdown files or a monolithic JSON document.
- Production scheduling needs indexes, leases, unique constraints, foreign keys, and row-level concurrency controls.
- Audit Events must be append-only and tamper-evident, but they still need to join back to Requirements, PRDs, Work Items, Agent Runs, Test Runs, Approvals, and artifacts.
- Local agents still need human-readable planning files and import/export surfaces for lightweight workflows.
- The current JSON-backed MVP should remain usable until `TD-202` replaces it; this ADR should not require a flag day before the repository migration exists.

## Decision

Use PostgreSQL, accessed through the Drizzle repository layer, as PatchPilot's production source of truth for product state.

Product state includes Requirements, PRD versions, Work Items, Interface Contracts, Test Cases, Test Runs, Defects, Agents, Agent Runs, Workspace Runs, Pull Request records, Review records when represented in the repository layer, Approvals, Audit Events, Artifact metadata, Capability Manifests, budgets, repository/project/organization records, and query projections served by the Control Plane API.

The current JSON-backed `PatchPilotStore` remains the authoritative runtime store only for the local MVP until `TD-202` lands. During that transition, code that needs product state should keep using the existing store boundary rather than introducing another persistence mechanism. `TD-202` must replace that boundary with a Postgres repository while preserving JSON import/export for fixtures, local demos, and migration support.

The local `.scratch/` Markdown tracker remains the source of truth for this repo's agent planning artifacts, such as `.scratch/agent-platform/PRD.md`, `.scratch/agent-platform/TECHNICAL_DESIGN.md`, `.scratch/agent-platform/TODO.md`, and local issue files. Markdown mode can also remain an explicit import/export surface for work items and run reports. It must not silently sync with the runtime repository, and it must not become a second live source of truth for Web/API/worker product state.

Audit Events are stored as append-only product-state records in Postgres with hash-chain fields. They are not the only source of current state, and PatchPilot will not use a separate event-sourced store as the canonical product database in the MVP or near-term production path. Event streams, SSE payloads, workflow histories, and future external integrations are derived from product-state writes and audit records.

Temporal owns workflow execution history only. Object storage owns large artifacts such as logs, traces, screenshots, diffs, test reports, and previews; Postgres owns their metadata, relationships, checksums, and retention-relevant facts.

## Alternatives Considered

### `.scratch` Markdown As Runtime Source Of Truth

Markdown is excellent for local planning, reviewable PRDs, agent-readable TODOs, and lightweight import/export. It is already the repo's local issue tracker and has a small scratch-store prototype with lock-based claims.

Rejected as the runtime source of truth because production PatchPilot needs transactional multi-record updates, indexed queries, foreign-key integrity, lease/fencing semantics, audit joins, and concurrent scheduler behavior. Implementing those guarantees over Markdown files would recreate database behavior with weaker tooling and worse operational visibility.

### Keep The JSON Snapshot Store

The JSON-backed `PatchPilotStore` is fast, simple, deterministic in tests, and good enough for the current local MVP. It also makes the whole product-state shape easy to inspect while the domain is still moving.

Rejected for production because a single JSON snapshot cannot provide reliable row-level concurrency, incremental queries, database constraints, large audit history handling, or safe multi-process writes. It remains a transitional local store until `TD-202`.

### Postgres Product-State Repository

Postgres matches the product-state requirements already described in the technical design and implemented in `TD-201`: transactions, JSONB where useful, indexes, row locks, constraints, migrations, audit tables, and mature operational tooling.

Accepted as the production product-state source of truth. The Drizzle schema and migrations provide the current contract for this repository layer; `TD-202` should connect the API and worker behavior to it.

### Hybrid Event Storage As Canonical State

A hybrid event store could keep immutable event history and rebuild projections for current state. It may be useful later for analytics, external integrations, long-term audit export, or replaying selected derived views.

Rejected as the canonical product store for now because PatchPilot first needs dependable transactional state transitions and operationally simple queries. A separate event-sourced authority would add projection lag, replay semantics, schema evolution, and dual-write risks before the core repository migration is complete. Audit Events remain append-only records, not the only product-state authority.

### External Issue Trackers As Source Of Truth

GitHub Issues, Linear, Jira, and similar systems are valuable integration surfaces.

Rejected as the product-state source because PatchPilot must own agent-specific delivery facts: Agent Runs, Workspace Runs, Test Runs, Approvals, Audit Events, cost, capability manifests, artifacts, workflow links, and acceptance decisions. External trackers can mirror or trigger work, but they must not be the only authority for execution state.

## Consequences

- `TD-202` should migrate the API store boundary from `patchpilot-store.json` to a Postgres repository backed by the `packages/db` schema and migrations.
- The repository layer must preserve JSON fixture import/export so existing local demos, CI fixtures, and migration tests can keep working.
- Runtime code should not add new direct `.scratch` Markdown reads or writes for Web/API/worker product state; Markdown remains planning plus explicit import/export.
- State transitions that touch multiple product facts must be implemented as transactions in the Postgres repository.
- Work Item claim, heartbeat, release, and completion paths should use Postgres constraints, indexes, row locks or optimistic version checks, and claim-token fencing.
- Audit Event writes must happen in the same repository transaction as the corresponding product-state mutation when feasible.
- `/api/snapshot` may remain a projection API, but after `TD-202` it should be assembled from Postgres rather than loaded from one JSON document.
- Temporal activities must read and write product facts through the repository layer, not through Temporal workflow history or direct table access from workflow code.
- Large artifacts remain outside Postgres; repository records should hold stable artifact ids, storage URIs, checksums, metadata, and relationships.
- Future external tracker adapters should sync through explicit import/export or integration jobs while keeping PatchPilot's repository as the authority for agent execution state.

## Migration Boundary For TD-202

`TD-202` should be considered complete when:

1. The Control Plane API and worker use a repository abstraction whose production implementation is Postgres.
2. API tests run against an isolated test database or equivalent Postgres-compatible test engine.
3. JSON snapshot fixture import/export exists for local demos, regression fixtures, and migration support.
4. Existing `/api/snapshot`, SSE, CLI, worker, acceptance, budget, approval, audit verification, and defect flows keep their current product behavior.
5. Work Item claims and state transitions are fenced by repository-level concurrency controls.
6. Audit Events are written transactionally with the state changes they describe where practical.
7. Documentation clearly marks `patchpilot-store.json` as legacy/local compatibility rather than the runtime authority.

## Non-Goals

- This ADR does not implement `TD-202` or change the current JSON-backed runtime store.
- This ADR does not change `.scratch/` local issue-tracker conventions for this repo.
- This ADR does not decide the Codex integration path; see `ADR-0003`.
- This ADR does not decide detailed WorkItem claim/lease mechanics; see `ADR-0005`.
- This ADR does not decide long-term audit log retention, export, or redaction strategy; see `ADR-0008`.
