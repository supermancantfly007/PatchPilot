import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";

import { patchPilotTableNames } from ".";

const expectedTableNames = [
  "agent_runs",
  "agents",
  "approvals",
  "artifacts",
  "audit_events",
  "budgets",
  "capability_manifests",
  "defects",
  "interface_contracts",
  "organizations",
  "prd_versions",
  "projects",
  "pull_requests",
  "repositories",
  "requirements",
  "test_cases",
  "test_runs",
  "work_items",
  "workspace_runs"
] as const;

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function readInitialMigration(): Promise<string> {
  const migrationDir = resolve(packageRoot, "drizzle");
  const migrationFiles = (await readdir(migrationDir)).filter((file) => file.endsWith(".sql"));
  expect(migrationFiles).toHaveLength(1);

  const migrationPath = resolve(migrationDir, migrationFiles[0] ?? "");
  return readFile(migrationPath, "utf8");
}

async function applyInitialMigration(db: PGlite): Promise<string> {
  const migrationSql = await readInitialMigration();
  await db.exec(migrationSql);
  return migrationSql;
}

describe("PatchPilot Drizzle schema", () => {
  let db: PGlite | undefined;

  afterEach(async () => {
    await db?.close();
    db = undefined;
  });

  it("exports the TD-201 table set", () => {
    expect([...patchPilotTableNames].sort()).toEqual([...expectedTableNames].sort());
  });

  it("ships a migration artifact that creates Postgres tables, constraints, and indexes", async () => {
    db = new PGlite();
    const migrationSql = await applyInitialMigration(db);

    for (const tableName of expectedTableNames) {
      expect(migrationSql).toContain(`CREATE TABLE "${tableName}"`);
    }
    expect(migrationSql).toContain("FOREIGN KEY");
    expect(migrationSql).toContain("CREATE INDEX");
    expect(migrationSql).toContain("CREATE UNIQUE INDEX");
    expect(migrationSql).toContain("CHECK");

    const tables = await db.query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname = 'public' order by tablename"
    );
    expect(tables.rows.map((row) => row.tablename)).toEqual([...expectedTableNames].sort());

    const indexes = await db.query<{ indexname: string }>(
      "select indexname from pg_indexes where schemaname = 'public'"
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual(
      expect.arrayContaining([
        "organizations_slug_unique",
        "projects_organization_slug_unique",
        "requirements_project_id_idx",
        "work_items_status_idx",
        "agent_runs_work_item_id_idx",
        "audit_events_trace_id_idx",
        "pull_requests_provider_url_unique",
        "budgets_scope_unique"
      ])
    );

    const constraints = await db.query<{ contype: string }>(
      [
        "select contype",
        "from pg_constraint c",
        "join pg_namespace n on n.oid = c.connamespace",
        "where n.nspname = 'public'"
      ].join(" ")
    );
    const constraintTypes = new Set(constraints.rows.map((row) => row.contype));
    expect(constraintTypes.has("p")).toBe(true);
    expect(constraintTypes.has("f")).toBe(true);
    expect(constraintTypes.has("c")).toBe(true);
  });

  it("accepts a minimal valid product-state graph across every table", async () => {
    db = new PGlite();
    await applyInitialMigration(db);

    await db.exec(`
      insert into organizations (id, slug, name) values ('org_1', 'patchpilot', 'PatchPilot');
      insert into projects (id, organization_id, slug, name) values ('proj_1', 'org_1', 'platform', 'Agent Platform');
      insert into repositories (id, project_id, provider, owner, name, remote_url)
        values ('repo_1', 'proj_1', 'github', 'patchpilot', 'patchpilot', 'https://example.test/patchpilot.git');
      insert into requirements (id, project_id, title, raw_input, input_type, status, simple_summary, created_by)
        values ('req_1', 'proj_1', 'Ship database schema', 'Create schema', 'feature', 'submitted', 'DB schema', 'user_1');
      insert into prd_versions (id, project_id, requirement_id, version, status, title, body_markdown)
        values ('prd_1_v1', 'proj_1', 'req_1', 1, 'draft', 'DB schema PRD', '# DB schema');
      insert into agents (id, project_id, name, role, status)
        values ('agent_backend', 'proj_1', 'Backend Agent', 'backend', 'idle');
      insert into work_items (id, project_id, requirement_id, prd_version_id, title, status, role, scope, assigned_agent_id)
        values ('wi_1', 'proj_1', 'req_1', 'prd_1_v1', 'Create schema', 'ready', 'backend', 'Schema only', 'agent_backend');
      insert into interface_contracts (
        id, project_id, requirement_id, prd_version_id, name, kind, status, version, summary, provider_role, spec_markdown
      ) values (
        'contract_1', 'proj_1', 'req_1', 'prd_1_v1', 'HTTP API', 'http', 'draft', 1, 'API', 'backend', '# API'
      );
      insert into agent_runs (id, project_id, requirement_id, prd_version_id, work_item_id, agent_id, runner, status)
        values ('run_1', 'proj_1', 'req_1', 'prd_1_v1', 'wi_1', 'agent_backend', 'simulated', 'queued');
      insert into workspace_runs (
        id, project_id, requirement_id, prd_version_id, work_item_id, agent_run_id, runner, status, isolation, path
      ) values (
        'workspace_1', 'proj_1', 'req_1', 'prd_1_v1', 'wi_1', 'run_1', 'simulated', 'preparing', 'simulated', '/tmp/patchpilot'
      );
      insert into pull_requests (
        id, project_id, provider, status, title, requirement_id, prd_version_id, work_item_id, agent_run_id,
        branch_name, base_branch, url, body_markdown, reviewer_summary, test_summary
      ) values (
        'pr_1', 'proj_1', 'local', 'draft', 'Create schema', 'req_1', 'prd_1_v1', 'wi_1', 'run_1',
        'agent/schema', 'main', 'local://pull-requests/pr_1', '# PR', 'Looks ok', 'Tests pending'
      );
      insert into test_cases (
        id, project_id, requirement_id, prd_version_id, work_item_id, title, kind, status, priority, expected_result
      ) values (
        'tc_1', 'proj_1', 'req_1', 'prd_1_v1', 'wi_1', 'Migration applies', 'acceptance', 'ready', 'high', 'SQL applies'
      );
      insert into test_runs (
        id, project_id, requirement_id, prd_version_id, work_item_id, test_case_id, agent_run_id, pull_request_id,
        status, command, summary, duration_ms
      ) values (
        'tr_1', 'proj_1', 'req_1', 'prd_1_v1', 'wi_1', 'tc_1', 'run_1', 'pr_1', 'passed', 'pnpm test', 'passed', 42
      );
      insert into defects (
        id, project_id, requirement_id, prd_version_id, work_item_id, source_agent_run_id, source_test_run_id,
        title, description, reproduction_steps, expected_behavior, actual_behavior, severity, status, reporter
      ) values (
        'defect_1', 'proj_1', 'req_1', 'prd_1_v1', 'wi_1', 'run_1', 'tr_1',
        'Failure', 'A failure', 'Run test', 'Pass', 'Failed', 'medium', 'reported', 'tester'
      );
      insert into approvals (
        id, project_id, kind, status, target_type, target_id, requested_by, requested_reason, risk_level, expires_at,
        requirement_id, prd_version_id, work_item_id, agent_run_id
      ) values (
        'approval_1', 'proj_1', 'prd_approval', 'pending', 'prd', 'prd_1_v1', 'user_1', 'Approve PRD', 'low',
        now() + interval '1 day', 'req_1', 'prd_1_v1', 'wi_1', 'run_1'
      );
      insert into audit_events (
        id, project_id, trace_id, actor_type, actor_id, action, target_type, target_id, message, hash,
        requirement_id, prd_version_id, work_item_id, agent_run_id
      ) values (
        'audit_1', 'proj_1', 'trace_1', 'user', 'user_1', 'created', 'requirement', 'req_1', 'created', 'hash_1',
        'req_1', 'prd_1_v1', 'wi_1', 'run_1'
      );
      insert into artifacts (
        id, project_id, kind, storage, uri, content_type, size_bytes, checksum_sha256,
        requirement_id, prd_version_id, work_item_id, agent_run_id, test_run_id
      ) values (
        'artifact_1', 'proj_1', 'log', 'local_fs', 'file:///tmp/log.txt', 'text/plain', 12, 'sha256',
        'req_1', 'prd_1_v1', 'wi_1', 'run_1', 'tr_1'
      );
      insert into capability_manifests (id, project_id, agent_run_id, status, manifest_json, created_by)
        values ('manifest_1', 'proj_1', 'run_1', 'active', '{}'::jsonb, 'scheduler');
      insert into budgets (id, project_id, scope_type, scope_id, limit_usd, spent_usd, approval_id, created_by)
        values ('budget_1', 'proj_1', 'work_item', 'wi_1', 5.00, 1.25, 'approval_1', 'planner');
    `);

    for (const tableName of expectedTableNames) {
      const result = await db.query<{ count: number }>(`select count(*) from ${tableName}`);
      expect(result.rows[0]?.count).toBe(1);
    }
  });

  it("enforces generated foreign key, enum, check, and unique constraints", async () => {
    db = new PGlite();
    await applyInitialMigration(db);

    await db.exec(`
      insert into organizations (id, slug, name) values ('org_1', 'patchpilot', 'PatchPilot');
      insert into projects (id, organization_id, slug, name) values ('proj_1', 'org_1', 'platform', 'Agent Platform');
    `);

    await expect(
      db.query("insert into projects (id, organization_id, slug, name) values ('proj_bad', 'missing', 'bad', 'Bad')")
    ).rejects.toThrow();

    await expect(
      db.query("insert into organizations (id, slug, name) values ('org_2', 'patchpilot', 'Duplicate')")
    ).rejects.toThrow();

    await expect(
      db.query(`
        insert into requirements (id, project_id, title, raw_input, input_type, status, simple_summary, created_by)
        values ('req_bad', 'proj_1', 'Bad', 'Bad', 'feature', 'not_real', 'Bad', 'user_1')
      `)
    ).rejects.toThrow();

    await expect(
      db.query(`
        insert into budgets (id, project_id, scope_type, scope_id, limit_usd, created_by)
        values ('budget_bad', 'proj_1', 'project', 'proj_1', -1, 'planner')
      `)
    ).rejects.toThrow();
  });
});
