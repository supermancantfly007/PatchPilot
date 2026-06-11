import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CodexRunError, type CodexRunner } from "@patchpilot/codex-runner";
import { executeCommand } from "@patchpilot/command-executor";
import { contractVersion, hashNormalizedContent } from "@patchpilot/contracts";
import type { PullRequestAdapter, UpsertPullRequestInput, WriteReviewerCommentInput } from "@patchpilot/pull-request-adapter";
import { createInMemoryTelemetry, prometheusMetricNames } from "@patchpilot/telemetry";
import {
  emptySnapshot,
  verifyAuditChain,
  type AgentRunResult,
  type AgentRun,
  type ArtifactRecord,
  type EgressPolicyEvidence,
  type PatchPilotSnapshot,
  type TestRun
} from "@patchpilot/domain";
import { buildServer } from "./server";
import { PatchPilotStore } from "./store";

process.env.PATCHPILOT_SIMULATION_DELAY_FACTOR = "0";
delete process.env.PATCHPILOT_RUNNER;

describe("PatchPilot API", () => {
  it("creates a requirement and PRD draft", async () => {
    const app = await buildServer();
    const create = await app.inject({
      method: "POST",
      url: "/api/requirements",
      payload: { rawInput: "做一个白色底的 agent 平台首页", template: "ui" }
    });
    expect(create.statusCode).toBe(201);
    const requirement = create.json();

    const answer = await app.inject({
      method: "POST",
      url: `/api/requirements/${requirement.id}/clarification-answer`,
      payload: { answers: {} }
    });
    expect(answer.statusCode).toBe(200);
    expect(answer.json().prd.bodyMarkdown).toContain("## 如何验收");
    expect(answer.json().interfaceContracts).toHaveLength(3);
    expect(answer.json().interfaceContracts.every((contract: { status: string }) => contract.status === "draft")).toBe(
      true
    );
    expect(
      answer.json().interfaceContracts.every((contract: { specMarkdown: string }) =>
        contract.specMarkdown.includes(`Contract version: \`${contractVersion}\``)
      )
    ).toBe(true);

    await app.close();
  });

  it("records intake artifact references for requirements and bugs", async () => {
    const app = await buildServer({ store: new PatchPilotStore() });
    const artifactReferences = [
      {
        kind: "file",
        label: "需求说明.pdf",
        contentType: "application/pdf",
        sizeBytes: 128_000,
        metadata: { source: "api-test" }
      },
      {
        kind: "screenshot",
        label: "首页空白截图",
        contentType: "image/png",
        sizeBytes: 4096
      },
      {
        kind: "recording",
        label: "复现录屏",
        contentType: "video/mp4",
        sizeBytes: 512_000
      },
      {
        kind: "link",
        label: "客户反馈链接",
        uri: "https://example.com/feedback/123"
      }
    ];

    const create = await app.inject({
      method: "POST",
      url: "/api/requirements",
      payload: {
        rawInput: "根据附件和客户反馈改进首页",
        template: "ui",
        artifactReferences
      }
    });
    expect(create.statusCode).toBe(201);
    expect(create.json().artifactReferences).toHaveLength(4);
    expect(create.json().artifactReferences.map((reference: { kind: string }) => reference.kind)).toEqual([
      "file",
      "screenshot",
      "recording",
      "link"
    ]);
    expect(create.json().artifactReferences.every((reference: { artifactId?: string }) => reference.artifactId)).toBe(true);

    const prdResponse = await app.inject({ method: "POST", url: `/api/requirements/${create.json().id}/prd` });
    expect(prdResponse.statusCode).toBe(200);
    const prdMarkdown = prdResponse.json().prd.bodyMarkdown as string;
    expect(prdMarkdown).toContain("## 关联资料");
    expect(prdMarkdown).toContain("需求说明.pdf");
    expect(prdMarkdown).toContain("首页空白截图");
    expect(prdMarkdown).toContain("复现录屏");
    expect(prdMarkdown).toContain("[客户反馈链接](https://example.com/feedback/123)");

    const bugResponse = await app.inject({
      method: "POST",
      url: "/api/bugs",
      payload: {
        title: "附件提交后页面没有显示",
        description: "用户提交带附件的 bug 后看不到证据。",
        reproductionSteps: "提交带截图和链接的 bug 表单。",
        expectedBehavior: "需求说明和证据页显示附件引用。",
        actualBehavior: "附件引用丢失。",
        severity: "high",
        reporter: "qa",
        artifactReferences: [artifactReferences[1], artifactReferences[3]]
      }
    });
    expect(bugResponse.statusCode).toBe(201);
    expect(bugResponse.json().bug.artifactReferences).toHaveLength(2);
    expect(bugResponse.json().prd.bodyMarkdown).toContain("首页空白截图");
    expect(bugResponse.json().prd.bodyMarkdown).toContain("客户反馈链接");

    const snapshot = await app.inject({ method: "GET", url: "/api/snapshot" });
    const intakeArtifacts = snapshot
      .json()
      .artifacts.filter((artifact: ArtifactRecord) => artifact.kind === "intake_attachment");
    expect(intakeArtifacts).toHaveLength(6);
    expect(intakeArtifacts.every((artifact: ArtifactRecord) => artifact.requirementId)).toBe(true);

    const firstArtifactContent = JSON.parse(await readFile(fileURLToPath(intakeArtifacts[0].uri), "utf8"));
    expect(firstArtifactContent).toMatchObject({
      kind: expect.any(String),
      label: expect.any(String)
    });

    await app.close();
  });

  it("rejects link artifact references without valid URLs", async () => {
    const app = await buildServer({ store: new PatchPilotStore() });

    const missingUrl = await app.inject({
      method: "POST",
      url: "/api/requirements",
      payload: {
        rawInput: "根据客户链接整理需求",
        template: "feature",
        artifactReferences: [{ kind: "link", label: "客户反馈链接" }]
      }
    });
    expect(missingUrl.statusCode).toBe(400);

    const invalidUrl = await app.inject({
      method: "POST",
      url: "/api/requirements",
      payload: {
        rawInput: "根据客户链接整理需求",
        template: "feature",
        artifactReferences: [{ kind: "link", label: "客户反馈链接", uri: "not a url" }]
      }
    });
    expect(invalidUrl.statusCode).toBe(400);

    await app.close();
  });

  it("rejects blank requirement input", async () => {
    const app = await buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/api/requirements",
      payload: { rawInput: "   ", template: "feature" }
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("runs API state through the Postgres repository and imports JSON fixtures", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "patchpilot-json-import-"));
    const dataFilePath = join(dataDir, "patchpilot-store.json");
    const fixture = emptySnapshot();
    fixture.agents = [];
    fixture.requirements = [
      {
        id: "req_json_fixture",
        title: "JSON fixture requirement",
        rawInput: "Import this JSON fixture into the repository",
        template: "feature",
        status: "clarifying",
        simpleSummary: "Feature: JSON fixture requirement",
        clarificationQuestions: [],
        clarificationTurns: [],
        createdAt: "2026-06-10T00:00:00.000Z",
        updatedAt: "2026-06-10T00:00:00.000Z"
      }
    ];
    await writeFile(dataFilePath, JSON.stringify(fixture, null, 2));
    const store = new PatchPilotStore({ dataFilePath });
    const app = await buildServer({ store });

    try {
      await expect(store.getPersistenceInfo()).resolves.toMatchObject({ kind: "postgres", engine: "pglite" });
      const imported = await app.inject({ method: "GET", url: "/api/snapshot" });
      expect(imported.statusCode).toBe(200);
      expect(imported.json().requirements.map((requirement: { id: string }) => requirement.id)).toContain(
        "req_json_fixture"
      );

      const created = await app.inject({
        method: "POST",
        url: "/api/requirements",
        payload: { rawInput: "Persist a new requirement after JSON import", template: "feature" }
      });
      expect(created.statusCode).toBe(201);

      const exported = JSON.parse(await readFile(dataFilePath, "utf8")) as PatchPilotSnapshot;
      expect(exported.requirements.map((requirement) => requirement.id)).toEqual(
        expect.arrayContaining(["req_json_fixture", created.json().id])
      );
    } finally {
      await app.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("returns 404 for unknown resources", async () => {
    const app = await buildServer();
    const response = await app.inject({ method: "GET", url: "/api/runs/missing" });

    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("returns runtime configuration for the workbench", async () => {
    const app = await buildServer();
    const response = await app.inject({ method: "GET", url: "/api/config" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      configuredRunner: "auto",
      activeRunner: "simulated",
      testCommand: expect.any(String),
      workspaceRoot: expect.any(String)
    });
    expect(typeof response.json().codexAvailable).toBe("boolean");
    expect(typeof response.json().gitWorkspaceAvailable).toBe("boolean");
    await app.close();
  });

  it("serves Prometheus metrics for a simulated run", async () => {
    const app = await buildServer({ store: new PatchPilotStore() });
    const startedRun = await startSimulatedRun(app, "验证 /metrics 暴露稳定的运行、队列、成本、测试和验收指标");
    const completedRun = await pollRun(app, startedRun.id);
    expect(completedRun.status).toBe("succeeded");

    const acceptance = await app.inject({
      method: "POST",
      url: `/api/acceptance/${completedRun.id}`,
      payload: { status: "accepted" }
    });
    expect(acceptance.statusCode).toBe(200);

    const metrics = await app.inject({ method: "GET", url: "/metrics" });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.headers["content-type"]).toContain("text/plain");
    expect(metrics.body).toContain(`# TYPE ${prometheusMetricNames.runDurationSeconds} histogram`);
    expect(metrics.body).toContain('patchpilot_agent_run_duration_seconds_count{runner="simulated",status="succeeded"} 1');
    expect(metrics.body).toContain('patchpilot_agent_run_failures_total{runner="simulated",failure_type="test_failed"} 0');
    expect(metrics.body).toContain('patchpilot_work_item_queue_depth{role="backend",status="done"} 1');
    expect(metrics.body).toContain('patchpilot_agent_run_cost_actual_usd{runner="simulated",status="succeeded"} 0.38');
    expect(metrics.body).toContain("patchpilot_test_pass_rate_ratio 1");
    expect(metrics.body).toContain('patchpilot_acceptance_decisions_total{status="accepted"} 1');
    expect(metrics.body).toContain("patchpilot_acceptance_rate_ratio 1");
    await app.close();
  });

  it("creates, approves, denies, and expires approval records", async () => {
    const app = await buildServer();
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const past = new Date(Date.now() - 1000).toISOString();
    const kinds = [
      "budget_exceeded",
      "dangerous_operation",
      "breaking_contract",
      "secret_grant",
      "network_allowlist_change"
    ];
    const approvals: Array<{ id: string }> = [];

    for (const kind of kinds) {
      const response = await app.inject({
        method: "POST",
        url: "/api/approvals",
        payload: {
          kind,
          targetType: kind === "secret_grant" ? "secret" : kind === "network_allowlist_change" ? "network" : "policy",
          targetId: `target_${kind}`,
          requestedBy: "policy-engine",
          requestedReason: `${kind} needs a human decision`,
          riskLevel: kind === "dangerous_operation" ? "critical" : "high",
          expiresAt: future
        }
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({
        kind,
        status: "pending",
        requestedBy: "policy-engine",
        requestedReason: `${kind} needs a human decision`
      });
      approvals.push(response.json());
    }
    const approvalToApprove = approvals[0];
    const approvalToDeny = approvals[1];
    expect(approvalToApprove).toBeDefined();
    expect(approvalToDeny).toBeDefined();
    if (!approvalToApprove || !approvalToDeny) throw new Error("Approval fixtures were not created");

    const approved = await app.inject({
      method: "POST",
      url: `/api/approvals/${approvalToApprove.id}/approve`,
      payload: { decidedBy: "maintainer", decisionReason: "Budget increase is acceptable for this PRD" }
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({
      status: "approved",
      approvedBy: "maintainer",
      decisionReason: "Budget increase is acceptable for this PRD"
    });

    const denied = await app.inject({
      method: "POST",
      url: `/api/approvals/${approvalToDeny.id}/deny`,
      payload: { decidedBy: "security-reviewer", decisionReason: "Operation is too risky for the current sandbox" }
    });
    expect(denied.statusCode).toBe(200);
    expect(denied.json()).toMatchObject({
      status: "denied",
      deniedBy: "security-reviewer",
      decisionReason: "Operation is too risky for the current sandbox"
    });

    const expired = await app.inject({
      method: "POST",
      url: "/api/approvals",
      payload: {
        kind: "network_allowlist_change",
        targetType: "network",
        targetId: "expired-network-change",
        requestedBy: "policy-engine",
        requestedReason: "Temporary network exception expired before review",
        riskLevel: "medium",
        expiresAt: past
      }
    });
    expect(expired.statusCode).toBe(201);
    expect(expired.json()).toMatchObject({
      status: "expired",
      decisionReason: "Approval expired before a decision was recorded."
    });

    const approveExpired = await app.inject({
      method: "POST",
      url: `/api/approvals/${expired.json().id}/approve`,
      payload: { decidedBy: "maintainer", decisionReason: "Too late" }
    });
    expect(approveExpired.statusCode).toBe(409);

    const snapshot = await app.inject({ method: "GET", url: "/api/snapshot" });
    const approvalStatuses = new Map(
      snapshot.json().approvals.map((approval: { id: string; status: string }) => [approval.id, approval.status])
    );
    expect(approvalStatuses.get(approvalToApprove.id)).toBe("approved");
    expect(approvalStatuses.get(approvalToDeny.id)).toBe("denied");
    expect(approvalStatuses.get(expired.json().id)).toBe("expired");
    expect(snapshot.json().auditEvents.map((event: { action: string }) => event.action)).toEqual(
      expect.arrayContaining(["approval.requested", "approval.approved", "approval.denied", "approval.expired"])
    );

    await app.close();
  });

  it("routes breaking contract registry diffs through Approval before promotion", async () => {
    const store = new PatchPilotStore();
    const app = await buildServer({ store });

    try {
      const baselinePrd = await createApprovedPrd(app, "建立一个旧版 API 契约基线");
      const mutableSnapshot = (store as unknown as { snapshot: PatchPilotSnapshot }).snapshot;
      const baselineHttpContract = mutableSnapshot.interfaceContracts.find(
        (contract) => contract.prdId === baselinePrd.id && contract.registry?.artifactId === "control-api"
      );
      if (!baselineHttpContract?.registry) throw new Error("Expected approved HTTP baseline registry metadata");
      const baselineContent = baselineHttpContract.registry.normalizedContent as {
        paths: Record<string, Record<string, unknown>>;
      };
      baselineContent.paths["/api/legacy-contract"] = {
        get: {
          operationId: "legacyContract",
          responses: {
            "200": {
              description: "Legacy contract response",
              content: {
                "application/json": {
                  schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] }
                }
              }
            }
          }
        }
      };
      baselineHttpContract.registry.contentHash = hashNormalizedContent(baselineHttpContract.registry.normalizedContent);

      const candidateCreate = await app.inject({
        method: "POST",
        url: "/api/requirements",
        payload: { rawInput: "审批一个移除旧版 API route 的契约变更", template: "feature" }
      });
      const candidatePrd = (await app.inject({
        method: "POST",
        url: `/api/requirements/${candidateCreate.json().id}/prd`
      })).json().prd;
      const approveCandidate = await app.inject({ method: "POST", url: `/api/prds/${candidatePrd.id}/approve` });
      expect(approveCandidate.statusCode).toBe(200);

      const pendingHttpContract = approveCandidate
        .json()
        .interfaceContracts.find((contract: { registry?: { artifactId?: string } }) =>
          contract.registry?.artifactId === "control-api"
        );
      expect(pendingHttpContract).toMatchObject({
        status: "breaking_change_pending",
        registry: {
          artifactId: "control-api",
          diff: {
            status: "breaking",
            hasBreakingChanges: true
          },
          approvalId: expect.any(String)
        }
      });
      expect(pendingHttpContract.registry.diff.changes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            severity: "breaking",
            changeType: "http.operation_removed",
            path: "paths./api/legacy-contract.get"
          })
        ])
      );

      const snapshotWithApproval = await app.inject({ method: "GET", url: "/api/snapshot" });
      const approval = snapshotWithApproval
        .json()
        .approvals.find((item: { id: string }) => item.id === pendingHttpContract.registry.approvalId);
      const blockedTestRun = snapshotWithApproval
        .json()
        .testRuns.find((test: { id: string }) => test.id === pendingHttpContract.registry.testRunIds[0]);
      const pendingContractTestRuns = pendingHttpContract.registry.testRunIds.map((testRunId: string) =>
        snapshotWithApproval.json().testRuns.find((test: { id: string }) => test.id === testRunId)
      );
      const auditActions = snapshotWithApproval.json().auditEvents.map((event: { action: string }) => event.action);
      expect(approval).toMatchObject({
        kind: "breaking_contract",
        status: "pending",
        targetType: "interface_contract",
        targetId: pendingHttpContract.id,
        riskLevel: "critical"
      });
      expect(blockedTestRun).toMatchObject({
        status: "blocked",
        command: "patchpilot contract-registry diff --artifact control-api",
        runner: "patchpilot-contract-registry"
      });
      expect(pendingContractTestRuns).toHaveLength(5);
      expect(pendingContractTestRuns.filter((test: { runner?: string }) => test.runner === "patchpilot-contract-tests")).toHaveLength(4);
      expect(pendingContractTestRuns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: "passed",
            command: "pnpm openapi:check && pnpm --filter @patchpilot/api test -- server.test.ts"
          }),
          expect.objectContaining({
            status: "passed",
            summary: expect.stringContaining("frontend consumer")
          }),
          expect.objectContaining({
            status: "passed",
            summary: expect.stringContaining("worker consumer")
          })
        ])
      );
      expect(auditActions).toEqual(
        expect.arrayContaining([
          "contract.revision_proposed",
          "contract.diff_completed",
          "contract.breaking_approval_requested",
          "approval.requested"
        ])
      );

      const approved = await app.inject({
        method: "POST",
        url: `/api/approvals/${approval.id}/approve`,
        payload: { decidedBy: "contract-owner", decisionReason: "Migration plan accepted for legacy route removal." }
      });
      expect(approved.statusCode).toBe(200);

      const promotedSnapshot = await app.inject({ method: "GET", url: "/api/snapshot" });
      const promotedContract = promotedSnapshot
        .json()
        .interfaceContracts.find((contract: { id: string }) => contract.id === pendingHttpContract.id);
      const promotedTestRun = promotedSnapshot
        .json()
        .testRuns.find((test: { id: string }) => test.id === blockedTestRun.id);
      expect(promotedContract).toMatchObject({
        status: "approved",
        registry: {
          status: "approved",
          approvalId: approval.id,
          approvedRevisionId: pendingHttpContract.registry.revisionId
        }
      });
      expect(promotedTestRun).toMatchObject({ status: "passed", exitCode: 0 });
      expect(promotedSnapshot.json().auditEvents.map((event: { action: string }) => event.action)).toEqual(
        expect.arrayContaining(["approval.approved", "contract.baseline_promoted"])
      );
    } finally {
      await app.close();
    }
  });

  it("upgrades approved PRDs from registry-only contract evidence to provider and consumer TestRuns", async () => {
    const store = new PatchPilotStore();
    const app = await buildServer({ store });

    try {
      const prd = await createApprovedPrd(app, "升级已有 PRD 的契约测试证据");
      const previousSnapshot = await store.exportJsonSnapshot();
      const downgradedSnapshot: PatchPilotSnapshot = structuredClone(previousSnapshot);
      const prdContracts = downgradedSnapshot.interfaceContracts.filter((contract) => contract.prdId === prd.id);

      for (const contract of prdContracts) {
        const registryRunId = (contract.registry?.testRunIds ?? []).find((testRunId) =>
          downgradedSnapshot.testRuns.find((testRun) =>
            testRun.id === testRunId && testRun.runner === "patchpilot-contract-registry"
          )
        );
        if (!contract.registry || !registryRunId) throw new Error(`Expected registry TestRun for ${contract.name}`);
        contract.registry.testRunIds = [registryRunId];
      }
      downgradedSnapshot.testRuns = downgradedSnapshot.testRuns.filter(
        (testRun) => testRun.prdId !== prd.id || testRun.runner !== "patchpilot-contract-tests"
      );
      downgradedSnapshot.testCases = downgradedSnapshot.testCases.filter(
        (testCase) => testCase.prdId !== prd.id || !testCase.id.startsWith("tc_contract_")
      );
      await store.importJsonSnapshot(downgradedSnapshot);

      const upgraded = await app.inject({ method: "POST", url: `/api/prds/${prd.id}/approve` });
      expect(upgraded.statusCode).toBe(200);
      const upgradedContractTestRunIds = upgraded
        .json()
        .interfaceContracts.flatMap((contract: { registry?: { testRunIds?: string[] } }) =>
          contract.registry?.testRunIds ?? []
        );
      expect(upgradedContractTestRunIds).toHaveLength(16);

      const upgradedSnapshot = await app.inject({ method: "GET", url: "/api/snapshot" });
      const upgradedContractTestRuns = upgradedContractTestRunIds.map((testRunId: string) =>
        upgradedSnapshot.json().testRuns.find((testRun: { id: string }) => testRun.id === testRunId)
      );
      const generatedContractTestCases = upgradedSnapshot
        .json()
        .testCases.filter((testCase: { id: string; prdId: string }) =>
          testCase.prdId === prd.id && testCase.id.startsWith("tc_contract_")
        );
      expect(upgradedContractTestRuns.filter((testRun: { runner?: string }) =>
        testRun.runner === "patchpilot-contract-tests"
      )).toHaveLength(13);
      expect(upgradedContractTestRuns.every((testRun: { status: string }) => testRun.status === "passed")).toBe(true);
      expect(generatedContractTestCases).toHaveLength(16);
    } finally {
      await app.close();
    }
  });

  it("writes formal audit events and verifies the hash chain", async () => {
    const app = await buildServer({ store: new PatchPilotStore() });
    await createApprovedWorkItem(app, "验证正式审计事件包含 before/after/hash chain 字段");

    const snapshot = await app.inject({ method: "GET", url: "/api/snapshot" });
    const auditEvents = snapshot.json().auditEvents;
    const prdApproved = auditEvents.find((event: { action: string }) => event.action === "prd.approved");
    expect(prdApproved).toMatchObject({
      actorType: "agent",
      actorId: "product_agent",
      targetType: "prd",
      beforeJson: expect.objectContaining({
        prd: expect.objectContaining({ status: "draft" })
      }),
      afterJson: expect.objectContaining({
        prd: expect.objectContaining({ status: "approved" })
      }),
      metadataJson: {},
      hash: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
    expect(verifyAuditChain(auditEvents)).toMatchObject({
      valid: true,
      checkedEvents: auditEvents.length,
      headHash: auditEvents[0].hash
    });

    const verification = await app.inject({ method: "GET", url: "/api/audit/verify" });
    expect(verification.statusCode).toBe(200);
    expect(verification.json()).toMatchObject({
      valid: true,
      checkedEvents: auditEvents.length,
      headHash: auditEvents[0].hash,
      errors: []
    });

    await app.close();
  });

  it("exports a redacted PRD audit package with linked evidence, retention, and WORM metadata", async () => {
    const app = await buildServer({ store: new PatchPilotStore() });
    const rawEmail = "alice.audit@example.com";
    const rawPhone = "+1 415-555-0134";
    const rawAccount = "customer_AUDIT123456";
    const startedRun = await startSimulatedRun(
      app,
      `管理员需要导出 ${rawEmail} ${rawPhone} ${rawAccount} 的 PRD 审计证据。`
    );
    const completedRun = await pollRun(app, startedRun.id);
    expect(completedRun.status).toBe("succeeded");

    const exported = await app.inject({
      method: "GET",
      url: `/api/prds/${completedRun.prdId}/audit-export`,
      headers: { "x-patchpilot-admin-actor": "admin_security" }
    });
    expect(exported.statusCode).toBe(200);
    const auditPackage = exported.json();
    const packageText = JSON.stringify(auditPackage);

    expect(packageText).not.toContain(rawEmail);
    expect(packageText).not.toContain(rawPhone);
    expect(packageText).not.toContain(rawAccount);
    expect(packageText).toContain("[REDACTED:email]");
    expect(packageText).toContain("[REDACTED:phone]");
    expect(packageText).toContain("[REDACTED:account-id]");
    expect(auditPackage.manifest).toMatchObject({
      formatVersion: "patchpilot.audit.prd.v1",
      createdBy: {
        actorType: "admin",
        actorId: "admin_security",
        adminIntent: true,
        authEnforcement: "pending_td_222_rbac"
      },
      scope: {
        type: "prd",
        prdId: completedRun.prdId
      },
      redaction: {
        redacted: true,
        finalPass: true
      },
      retention: {
        policyVersion: "td-308-retention-v1",
        worm: {
          enabled: false,
          mode: "metadata_only"
        }
      }
    });
    expect(auditPackage.manifest.exportAuditEventId).toMatch(/^audit_/u);
    expect(auditPackage.manifest.integrity.payloadSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(auditPackage.records.agentRuns.map((run: { id: string }) => run.id)).toContain(completedRun.id);
    expect(auditPackage.records.workspaceRuns.some((workspace: { runId: string }) => workspace.runId === completedRun.id)).toBe(true);
    expect(auditPackage.records.testRuns.some((testRun: { runId?: string }) => testRun.runId === completedRun.id)).toBe(true);
    expect(auditPackage.records.pullRequests.some((pullRequest: { runId: string }) => pullRequest.runId === completedRun.id)).toBe(true);
    expect(auditPackage.records.reviewRecords.some((review: { runId: string }) => review.runId === completedRun.id)).toBe(true);
    expect(auditPackage.artifactManifest.length).toBeGreaterThanOrEqual(5);
    expect(
      auditPackage.artifactManifest.every((artifact: { checksumSha256: string; includedBytes: boolean; retentionTier: string }) =>
        /^[a-f0-9]{64}$/u.test(artifact.checksumSha256) &&
        artifact.includedBytes === false &&
        artifact.retentionTier.startsWith("tier_")
      )
    ).toBe(true);

    const auditEvents = auditPackage.auditEventsJsonl.trim().split("\n").map((line: string) => JSON.parse(line));
    const auditActions = auditEvents.map((event: { action: string }) => event.action);
    expect(auditActions).toEqual(
      expect.arrayContaining([
        "prd.approved",
        "agent_run.succeeded",
        "test_run.passed",
        "pull_request.ready_for_review",
        "review.approved",
        "audit.exported"
      ])
    );
    expect(auditPackage.verification).toMatchObject({
      valid: true,
      checkedEvents: auditEvents.length,
      headHash: auditEvents.at(-1).hash
    });
    expect(auditPackage.verification.scopeEventIds).toContain(auditPackage.manifest.exportAuditEventId);
    expect(verifyAuditChain([...auditEvents].reverse())).toMatchObject({
      valid: true,
      checkedEvents: auditEvents.length,
      headHash: auditPackage.verification.headHash
    });

    const verification = await app.inject({ method: "GET", url: "/api/audit/verify" });
    expect(verification.json()).toMatchObject({ valid: true, headHash: auditPackage.verification.headHash });

    await app.close();
  });

  it("migrates legacy audit events into a verifiable hash chain", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "patchpilot-audit-migration-"));
    const dataFilePath = join(dataDir, "patchpilot-store.json");
    const legacySnapshot = emptySnapshot() as unknown as {
      auditEvents: Array<Record<string, unknown>>;
      agents: unknown[];
    };
    legacySnapshot.agents = [];
    legacySnapshot.auditEvents = [
      {
        id: "audit_legacy_newer",
        traceId: "trace_legacy",
        actor: "runner",
        action: "agent_run.succeeded",
        targetType: "agent_run",
        targetId: "run_1",
        message: "Legacy run succeeded.",
        runId: "run_1",
        createdAt: "2026-06-10T00:00:02.000Z"
      },
      {
        id: "audit_legacy_older",
        traceId: "trace_legacy",
        actor: "agent_backend",
        action: "work_item.started",
        targetType: "work_item",
        targetId: "wi_1",
        message: "Legacy work item started.",
        workItemId: "wi_1",
        createdAt: "2026-06-10T00:00:01.000Z"
      }
    ];
    await writeFile(dataFilePath, JSON.stringify(legacySnapshot, null, 2));
    const app = await buildServer({ store: new PatchPilotStore({ dataFilePath }) });

    try {
      const snapshot = await app.inject({ method: "GET", url: "/api/snapshot" });
      const events = snapshot.json().auditEvents;
      expect(events).toHaveLength(2);
      expect(events[1]).toMatchObject({
        id: "audit_legacy_older",
        actorType: "agent",
        actorId: "agent_backend",
        previousHash: null,
        metadataJson: expect.objectContaining({ migratedFromLegacy: true }),
        hash: expect.stringMatching(/^[a-f0-9]{64}$/)
      });
      expect(events[0]).toMatchObject({
        id: "audit_legacy_newer",
        actorType: "runner",
        actorId: "runner",
        previousHash: events[1].hash,
        hash: expect.stringMatching(/^[a-f0-9]{64}$/)
      });
      expect(verifyAuditChain(events)).toMatchObject({ valid: true, checkedEvents: 2 });

      const verification = await app.inject({ method: "GET", url: "/api/audit/verify" });
      expect(verification.json()).toMatchObject({ valid: true, checkedEvents: 2, headHash: events[0].hash });
    } finally {
      await app.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("pauses over-budget runs and records budget approval evidence", async () => {
    const restoreBudgetEnv = setBudgetEnv({
      PATCHPILOT_BUDGET_RUN_USD: "0.2"
    });
    const app = await buildServer({ store: new PatchPilotStore() });

    try {
      const workItem = await createApprovedWorkItem(app, "验证超预算 agent run 会暂停等待审批");
      const start = await app.inject({
        method: "POST",
        url: `/api/work-items/${workItem.id}/start`,
        payload: { runner: "simulated" }
      });
      expect(start.statusCode).toBe(201);
      const run = start.json();
      expect(run).toMatchObject({
        status: "needs_approval",
        budgetUsd: 0.2,
        budgetApprovalId: expect.any(String),
        costEstimateUsd: 0.42
      });

      const snapshot = await app.inject({ method: "GET", url: "/api/snapshot" });
      const pausedWorkItem = snapshot.json().workItems.find((item: { id: string }) => item.id === workItem.id);
      const approval = snapshot.json().approvals.find((item: { id: string }) => item.id === run.budgetApprovalId);
      const auditActions = snapshot.json().auditEvents.map((event: { action: string }) => event.action);
      expect(pausedWorkItem).toMatchObject({ status: "blocked" });
      expect(pausedWorkItem.assignedAgentId).toBeUndefined();
      expect(approval).toMatchObject({
        kind: "budget_exceeded",
        status: "pending",
        targetType: "agent_run",
        targetId: run.id,
        runId: run.id
      });
      expect(auditActions).toEqual(
        expect.arrayContaining(["budget.hard_threshold_exceeded", "approval.requested"])
      );
    } finally {
      restoreBudgetEnv();
      await app.close();
    }
  });

  it("resumes a budget-gated run after approval", async () => {
    const restoreBudgetEnv = setBudgetEnv({
      PATCHPILOT_BUDGET_RUN_USD: "0.2"
    });
    const app = await buildServer({ store: new PatchPilotStore() });

    try {
      const workItem = await createApprovedWorkItem(app, "验证预算审批通过后继续执行原 run");
      const start = await app.inject({
        method: "POST",
        url: `/api/work-items/${workItem.id}/start`,
        payload: { runner: "simulated" }
      });
      expect(start.statusCode).toBe(201);
      const pausedRun = start.json();
      expect(pausedRun.status).toBe("needs_approval");

      const approved = await app.inject({
        method: "POST",
        url: `/api/approvals/${pausedRun.budgetApprovalId}/approve`,
        payload: { decidedBy: "finance-owner", decisionReason: "Approve this one-off budget overrun" }
      });
      expect(approved.statusCode).toBe(200);
      expect(approved.json()).toMatchObject({ status: "approved", approvedBy: "finance-owner" });

      const completedRun = await pollRun(app, pausedRun.id);
      expect(completedRun.status).toBe("succeeded");
      expect(completedRun.id).toBe(pausedRun.id);
      const snapshot = await app.inject({ method: "GET", url: "/api/snapshot" });
      const resumedWorkItem = snapshot.json().workItems.find((item: { id: string }) => item.id === workItem.id);
      const auditActions = snapshot.json().auditEvents.map((event: { action: string }) => event.action);
      expect(resumedWorkItem.status).toBe("review");
      expect(auditActions).toEqual(
        expect.arrayContaining(["approval.approved", "agent_run.resumed", "agent_run.succeeded"])
      );
    } finally {
      restoreBudgetEnv();
      await app.close();
    }
  });

  it("warns at the budget soft threshold without pausing the run", async () => {
    const restoreBudgetEnv = setBudgetEnv({
      PATCHPILOT_BUDGET_RUN_USD: "0.5",
      PATCHPILOT_BUDGET_SOFT_THRESHOLD_RATIO: "0.8"
    });
    const app = await buildServer({ store: new PatchPilotStore() });

    try {
      const workItem = await createApprovedWorkItem(app, "验证预算软阈值只告警不暂停");
      const start = await app.inject({
        method: "POST",
        url: `/api/work-items/${workItem.id}/start`,
        payload: { runner: "simulated" }
      });
      expect(start.statusCode).toBe(201);
      expect(start.json()).toMatchObject({
        status: "running",
        budgetUsd: 0.5,
        budgetSoftThresholdUsd: 0.4
      });

      const completedRun = await pollRun(app, start.json().id);
      expect(completedRun.status).toBe("succeeded");
      const snapshot = await app.inject({ method: "GET", url: "/api/snapshot" });
      const auditActions = snapshot.json().auditEvents.map((event: { action: string }) => event.action);
      expect(snapshot.json().approvals).toHaveLength(0);
      expect(auditActions).toContain("budget.soft_threshold_exceeded");
    } finally {
      restoreBudgetEnv();
      await app.close();
    }
  });

  it("returns test command and preview URL overrides from .patchpilot/config.yaml", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "patchpilot-api-config-"));
    const configDir = join(fixtureRoot, ".patchpilot");
    const configPath = join(configDir, "config.yaml");
    const previousConfigPath = process.env.PATCHPILOT_CONFIG_PATH;
    const previousTestCommand = process.env.PATCHPILOT_TEST_COMMAND;
    const previousPreviewUrl = process.env.PATCHPILOT_PREVIEW_URL;
    const previousWorkspaceRoot = process.env.PATCHPILOT_WORKSPACE_ROOT;
    const restoreArtifactEnv = setArtifactEnv({});
    await mkdir(configDir, { recursive: true });
    await writeFile(
      configPath,
      `
test:
  command: pnpm test:fixture-api
dev:
  previewUrl: http://fixture-preview.local
  workspaceRoot: .patchpilot/worktrees-from-config
artifacts:
  provider: s3
  localRoot: .patchpilot/artifacts-from-config
  s3:
    endpoint: http://minio.config:9000
    region: us-east-2
    bucket: patchpilot-config
    accessKeyId: config-access
    secretAccessKey: config-secret
    forcePathStyle: false
    prefix: config-prefix
`.trimStart(),
      "utf8"
    );

    const app = await buildServer();

    try {
      process.env.PATCHPILOT_CONFIG_PATH = configPath;
      delete process.env.PATCHPILOT_TEST_COMMAND;
      delete process.env.PATCHPILOT_PREVIEW_URL;
      delete process.env.PATCHPILOT_WORKSPACE_ROOT;

      const response = await app.inject({ method: "GET", url: "/api/config" });
      const config = response.json();

      expect(response.statusCode).toBe(200);
      expect(config.configSource).toBe("file");
      expect(config.configPath).toBe(configPath);
      expect(config.testCommand).toBe("pnpm test:fixture-api");
      expect(config.test.command).toBe("pnpm test:fixture-api");
      expect(config.previewUrl).toBe("http://fixture-preview.local");
      expect(config.dev.previewUrl).toBe("http://fixture-preview.local");
      expect(config.workspaceRoot).toBe(join(fixtureRoot, ".patchpilot", "worktrees-from-config"));
      expect(config.artifacts).toEqual({
        provider: "s3",
        s3: {
          endpoint: "http://minio.config:9000",
          region: "us-east-2",
          bucket: "patchpilot-config",
          forcePathStyle: false,
          prefix: "config-prefix"
        }
      });
    } finally {
      if (previousConfigPath === undefined) delete process.env.PATCHPILOT_CONFIG_PATH;
      else process.env.PATCHPILOT_CONFIG_PATH = previousConfigPath;
      if (previousTestCommand === undefined) delete process.env.PATCHPILOT_TEST_COMMAND;
      else process.env.PATCHPILOT_TEST_COMMAND = previousTestCommand;
      if (previousPreviewUrl === undefined) delete process.env.PATCHPILOT_PREVIEW_URL;
      else process.env.PATCHPILOT_PREVIEW_URL = previousPreviewUrl;
      if (previousWorkspaceRoot === undefined) delete process.env.PATCHPILOT_WORKSPACE_ROOT;
      else process.env.PATCHPILOT_WORKSPACE_ROOT = previousWorkspaceRoot;
      restoreArtifactEnv();
      await app.close();
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("streams the current run, incremental updates, and closes after a terminal status", async () => {
    const app = await buildServer();
    const previousDelayFactor = process.env.PATCHPILOT_SIMULATION_DELAY_FACTOR;
    process.env.PATCHPILOT_SIMULATION_DELAY_FACTOR = "0.5";

    try {
      const baseUrl = await listenOnRandomPort(app);
      const run = await startSimulatedRun(app, "验证 SSE 首包、增量更新和终态关闭");

      const frames = await collectSseFrames(`${baseUrl}/api/runs/${run.id}/events`, 7000);
      const runFrames = frames.filter((frame) => frame.event === "message");
      const payloads = runFrames.map((frame) => JSON.parse(frame.data) as AgentRun);
      const firstPayload = payloads[0];
      const terminalPayload = payloads.at(-1);

      expect(firstPayload).toMatchObject({
        id: run.id,
        status: "running",
        currentStep: "understanding"
      });
      expect(firstPayload?.events).toHaveLength(1);
      expect(firstPayload?.events[0]?.type).toBe("requirement.understood");
      expect(payloads.length).toBeGreaterThanOrEqual(2);
      expect(Math.max(...payloads.map((payload) => payload.events.length))).toBeGreaterThan(1);
      expect(terminalPayload?.status).toBe("succeeded");
      expect(terminalPayload?.events.at(-1)?.type).toBe("acceptance.waiting");
    } finally {
      if (previousDelayFactor === undefined) delete process.env.PATCHPILOT_SIMULATION_DELAY_FACTOR;
      else process.env.PATCHPILOT_SIMULATION_DELAY_FACTOR = previousDelayFactor;
      await app.close();
    }
  });

  it("streams an SSE error envelope for a missing run and then closes", async () => {
    const app = await buildServer();

    try {
      const baseUrl = await listenOnRandomPort(app);
      const frames = await collectSseFrames(`${baseUrl}/api/runs/missing-run/events`, 2000);
      const errorFrame = frames[0];
      const payload = JSON.parse(errorFrame?.data ?? "{}") as { message?: string };

      expect(frames).toHaveLength(1);
      expect(errorFrame?.event).toBe("error");
      expect(payload.message).toContain("AgentRun not found: missing-run");
    } finally {
      await app.close();
    }
  });

  it("makes starting the same work item idempotent", async () => {
    const app = await buildServer();
    const create = await app.inject({
      method: "POST",
      url: "/api/requirements",
      payload: { rawInput: "做一个端到端可用的 agent 平台", template: "feature" }
    });
    const requirement = create.json();
    const answer = await app.inject({
      method: "POST",
      url: `/api/requirements/${requirement.id}/clarification-answer`,
      payload: { answers: {} }
    });
    const prd = answer.json().prd;
    const approval = await app.inject({
      method: "POST",
      url: `/api/prds/${prd.id}/approve`
    });
    const workItem = approval.json().workItems[0];

    const firstStart = await app.inject({ method: "POST", url: `/api/work-items/${workItem.id}/start` });
    const secondStart = await app.inject({ method: "POST", url: `/api/work-items/${workItem.id}/start` });

    expect(firstStart.statusCode).toBe(201);
    expect(secondStart.statusCode).toBe(201);
    expect(secondStart.json().id).toBe(firstStart.json().id);
    const snapshot = await app.inject({ method: "GET", url: "/api/snapshot" });
    const runsForWorkItem = snapshot.json().agentRuns.filter((run: { workItemId: string }) => run.workItemId === workItem.id);
    expect(runsForWorkItem).toHaveLength(1);
    await pollRun(app, firstStart.json().id);
    await app.close();
  });

  it("runs the full requirement to acceptance lifecycle", async () => {
    const app = await buildServer();
    const create = await app.inject({
      method: "POST",
      url: "/api/requirements",
      payload: { rawInput: "开发一个端到端可用的 agent 平台", template: "feature" }
    });
    const requirement = create.json();

    const answer = await app.inject({
      method: "POST",
      url: `/api/requirements/${requirement.id}/clarification-answer`,
      payload: {
        answers: {
          goal: "用户可以提交需求、确认 PRD、启动 agent、查看测试证据并验收",
          scope: "先不自动合并或发布",
          acceptance: "API 生命周期完整通过"
        }
      }
    });
    const prd = answer.json().prd;

    const approval = await app.inject({ method: "POST", url: `/api/prds/${prd.id}/approve` });
    expect(approval.statusCode).toBe(200);
    const workItem = approval.json().workItems[0];
    expect(approval.json().interfaceContracts).toHaveLength(3);
    expect(
      approval.json().interfaceContracts.every((contract: { status: string }) => contract.status === "approved")
    ).toBe(true);
    expect(
      approval.json().interfaceContracts.every((contract: { specMarkdown: string }) =>
        contract.specMarkdown.includes(`Contract version: \`${contractVersion}\``)
      )
    ).toBe(true);

    const start = await app.inject({
      method: "POST",
      url: `/api/work-items/${workItem.id}/start`,
      payload: { runner: "simulated" }
    });
    expect(start.statusCode).toBe(201);
    const run = start.json();
    expect(run.runner).toBe("simulated");
    const snapshotWhileRunning = await app.inject({ method: "GET", url: "/api/snapshot" });
    const runningWorkItem = snapshotWhileRunning.json().workItems.find((item: { id: string }) => item.id === workItem.id);
    expect(runningWorkItem.status).toBe("running");
    expect(runningWorkItem.assignedAgentId).toBeTruthy();
    expect(runningWorkItem.claimToken).toEqual(expect.any(String));
    expect(runningWorkItem.leaseExpiresAt).toEqual(expect.any(String));
    expect(runningWorkItem.heartbeatAt).toEqual(expect.any(String));
    expect(runningWorkItem.version).toBeGreaterThan(1);

    const completedRun = await pollRun(app, run.id);
    expect(completedRun.status).toBe("succeeded");
    expect(completedRun.result.runner).toBe("simulated");
    expect(completedRun.result.tests[0].status).toBe("passed");
    const snapshotAfterRun = await app.inject({ method: "GET", url: "/api/snapshot" });
    const completedTestCase = snapshotAfterRun
      .json()
      .testCases.find((item: { id: string; workItemId: string }) =>
        item.workItemId === workItem.id && !item.id.startsWith("tc_contract_")
      );
    expect(completedTestCase.status).toBe("passed");
    expect(completedTestCase.lastRunId).toBe(run.id);
    expect(completedTestCase.lastTestRunId).toBe(completedRun.result.tests[0].id);
    expect(completedTestCase.flaky).toBe(false);

    const acceptance = await app.inject({
      method: "POST",
      url: `/api/acceptance/${run.id}`,
      payload: { status: "accepted" }
    });
    expect(acceptance.statusCode).toBe(200);
    expect(acceptance.json().status).toBe("accepted");
    const snapshotAfterAcceptance = await app.inject({ method: "GET", url: "/api/snapshot" });
    const doneWorkItem = snapshotAfterAcceptance.json().workItems.find((item: { id: string }) => item.id === workItem.id);
    expect(doneWorkItem.status).toBe("done");

    await app.close();
  });

  it("emits correlated OpenTelemetry signals for a completed run", async () => {
    const telemetry = createInMemoryTelemetry("patchpilot-api-test");
    const app = await buildServer({ telemetry });

    try {
      const run = await startSimulatedRun(app, "验证一次 run 会写入可关联的 OpenTelemetry trace");
      const completedRun = await pollRun(app, run.id);
      await telemetry.forceFlush();

      const runSpan = telemetry.getFinishedSpans().find((span) => span.name === "patchpilot.agent_run");
      const testSpan = telemetry.getFinishedSpans().find((span) => span.name === "patchpilot.test_run");
      expect(runSpan?.attributes).toMatchObject({
        "patchpilot.requirement.id": completedRun.requirementId,
        "patchpilot.prd.id": completedRun.prdId,
        "patchpilot.workflow.id": completedRun.prdId,
        "patchpilot.workflow.proxy": "prd",
        "patchpilot.work_item.id": completedRun.workItemId,
        "patchpilot.agent_run.id": completedRun.id,
        "patchpilot.agent_run.status": "succeeded"
      });
      expect(runSpan?.events.map((event) => event.name)).toEqual(
        expect.arrayContaining(["requirement.understood", "acceptance.waiting", "audit.agent_run.succeeded"])
      );
      expect(testSpan?.attributes).toMatchObject({
        "patchpilot.agent_run.id": completedRun.id,
        "patchpilot.test_run.id": completedRun.result.tests[0].id,
        "patchpilot.test_run.status": "passed"
      });
      expect(telemetry.getFinishedLogRecords().map((record) => record.eventName)).toEqual(
        expect.arrayContaining([
          "requirement.understood",
          "patchpilot.test_run.passed",
          "audit.agent_run.succeeded",
          "patchpilot.agent_run.succeeded"
        ])
      );
    } finally {
      await app.close();
    }
  });

  it("blocks accepted decisions when the acceptance quality gate is unmet", async () => {
    const store = new PatchPilotStore();
    const app = await buildServer({ store });
    const workItem = await createApprovedWorkItem(app, "验证验收质量门会阻止失败证据被接受");

    const start = await app.inject({
      method: "POST",
      url: `/api/work-items/${workItem.id}/start`,
      payload: { runner: "simulated" }
    });
    expect(start.statusCode).toBe(201);
    const run = await pollRun(app, start.json().id);
    expect(run.status).toBe("succeeded");

    const mutableSnapshot = (store as unknown as { snapshot: PatchPilotSnapshot }).snapshot;
    const testCase = mutableSnapshot.testCases.find((item) => item.workItemId === workItem.id);
    if (!testCase) throw new Error("Expected simulated run to create TestCase evidence");
    testCase.status = "failed";

    const acceptance = await app.inject({
      method: "POST",
      url: `/api/acceptance/${run.id}`,
      payload: { status: "accepted" }
    });
    expect(acceptance.statusCode).toBe(409);
    expect(acceptance.json().message).toContain("Acceptance quality gate failed");
    expect(acceptance.json().message).toContain("TestCase");

    const rejection = await app.inject({
      method: "POST",
      url: `/api/acceptance/${run.id}`,
      payload: { status: "rejected", reason: "TestCase 证据没有通过，要求返工。" }
    });
    expect(rejection.statusCode).toBe(200);
    const snapshotAfterRejection = await app.inject({ method: "GET", url: "/api/snapshot" });
    const reworkItem = snapshotAfterRejection.json().workItems.find((item: { id: string }) => item.id === workItem.id);
    expect(reworkItem.status).toBe("ready");

    await app.close();
  });

  it("fences concurrent work item claims and requires the current claim token to start", async () => {
    const app = await buildServer({ store: new PatchPilotStore() });
    const workItem = await createApprovedWorkItem(app, "验证并发领取同一工作项不会双重成功");

    const [backendClaim, reviewerClaim] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/work-items/${workItem.id}/claim`,
        payload: { agentId: "agent_backend" }
      }),
      app.inject({
        method: "POST",
        url: `/api/work-items/${workItem.id}/claim`,
        payload: { agentId: "agent_reviewer" }
      })
    ]);

    expect([backendClaim.statusCode, reviewerClaim.statusCode].sort()).toEqual([200, 409]);
    const winningClaim = backendClaim.statusCode === 200 ? backendClaim : reviewerClaim;
    const claimToken = winningClaim.json().claimToken as string;
    expect(claimToken).toEqual(expect.any(String));
    expect(winningClaim.json().workItem).toMatchObject({
      status: "claimed",
      claimToken,
      leaseExpiresAt: expect.any(String),
      heartbeatAt: expect.any(String)
    });

    const rejectedStart = await app.inject({
      method: "POST",
      url: `/api/work-items/${workItem.id}/start`,
      payload: { runner: "simulated", claimToken: "stale-token" }
    });
    expect(rejectedStart.statusCode).toBe(409);

    const start = await app.inject({
      method: "POST",
      url: `/api/work-items/${workItem.id}/start`,
      payload: { runner: "simulated", claimToken }
    });
    expect(start.statusCode).toBe(201);

    await app.close();
  });

  it("allows an expired claim lease to be recovered by another agent", async () => {
    const app = await buildServer({ store: new PatchPilotStore() });
    const workItem = await createApprovedWorkItem(app, "验证过期 lease 可以回收");

    const firstClaim = await app.inject({
      method: "POST",
      url: `/api/work-items/${workItem.id}/claim`,
      payload: { agentId: "agent_backend", leaseDurationMs: 1 }
    });
    expect(firstClaim.statusCode).toBe(200);
    await delay(10);

    const secondClaim = await app.inject({
      method: "POST",
      url: `/api/work-items/${workItem.id}/claim`,
      payload: { agentId: "agent_reviewer" }
    });
    expect(secondClaim.statusCode).toBe(200);
    expect(secondClaim.json().claimToken).not.toBe(firstClaim.json().claimToken);
    expect(secondClaim.json().workItem).toMatchObject({
      status: "claimed",
      assignedAgentId: "agent_reviewer"
    });
    expect(secondClaim.json().workItem.version).toBeGreaterThan(firstClaim.json().workItem.version);

    const snapshot = await app.inject({ method: "GET", url: "/api/snapshot" });
    const backendAgent = snapshot.json().agents.find((agent: { id: string }) => agent.id === "agent_backend");
    expect(backendAgent.status).toBe("idle");
    expect(backendAgent.currentWorkItemId).toBeUndefined();

    await app.close();
  });

  it("uses an injected CodexRunner implementation for codex runs", async () => {
    let capturedRunId = "";
    const fakeCodexRunner: CodexRunner = {
      isAvailable: async () => true,
      isGitWorkspaceAvailable: async () => true,
      run: async (context, emit) => {
        capturedRunId = context.runId;
        await emit({
          step: "developing",
          type: "codex.output",
          message: "Fake Codex runner produced a change"
        });
        return {
          summary: "Fake Codex runner completed the injected task.",
          previewUrl: "http://fake-preview.local",
          riskLevel: "low",
          changedFiles: ["packages/codex-runner/src/index.ts"],
          tests: [
            {
              id: "test_fake_codex",
              status: "passed",
              command: "fake test",
              summary: "fake test passed",
              durationMs: 12
            }
          ],
          reviewerSummary: "Fake reviewer approved the injected runner result.",
          runner: "codex",
          agentMessages: ["Fake Codex agent reported completion."],
          reasoningSummaries: ["Fake Codex inspected the capture path."],
          toolCalls: [
            {
              id: "tool_fake_test",
              name: "exec_command",
              status: "completed",
              summary: "Ran the fake test command",
              command: "fake test",
              exitCode: 0,
              durationMs: 12
            }
          ],
          diffSummary: {
            changedFileCount: 1,
            changedFiles: ["packages/codex-runner/src/index.ts"],
            hasChanges: true,
            branchName: "patchpilot/wi_fake-codex-runner",
            baseBranch: "main",
            baseCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            headCommit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
          },
          testOutputSummary: "passed: fake test (12ms). fake test passed",
          workspacePath: "fake://workspace",
          branchName: "patchpilot/wi_fake-codex-runner",
          baseBranch: "main",
          baseCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          headCommit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          codexSessionId: "fake-session"
        };
      }
    };
    const app = await buildServer({ store: new PatchPilotStore({ codexRunner: fakeCodexRunner }) });
    const create = await app.inject({
      method: "POST",
      url: "/api/requirements",
      payload: { rawInput: "验证 CodexRunner 可以被 API 注入替换", template: "feature" }
    });
    const requirement = create.json();
    const prdResponse = await app.inject({ method: "POST", url: `/api/requirements/${requirement.id}/prd` });
    const prd = prdResponse.json().prd;
    const approval = await app.inject({ method: "POST", url: `/api/prds/${prd.id}/approve` });
    const workItem = approval.json().workItems[0];

    const start = await app.inject({
      method: "POST",
      url: `/api/work-items/${workItem.id}/start`,
      payload: { runner: "codex" }
    });

    expect(start.statusCode).toBe(201);
    expect(start.json().runner).toBe("codex");
    const completedRun = await pollRun(app, start.json().id);
    expect(capturedRunId).toBe(start.json().id);
    expect(completedRun.status).toBe("succeeded");
    expect(completedRun.result).toMatchObject({
      runner: "codex",
      workspacePath: "fake://workspace",
      branchName: "patchpilot/wi_fake-codex-runner",
      baseBranch: "main",
      baseCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      headCommit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      codexSessionId: "fake-session",
      changedFiles: ["packages/codex-runner/src/index.ts"],
      toolCalls: [
        {
          id: "tool_fake_test",
          name: "exec_command",
          status: "completed",
          command: "fake test"
        }
      ],
      diffSummary: {
        changedFileCount: 1,
        hasChanges: true
      },
      testOutputSummary: "passed: fake test (12ms). fake test passed"
    });
    expect(completedRun.events.some((event: { message: string }) => event.message.includes("Fake Codex runner"))).toBe(true);

    const snapshot = await app.inject({ method: "GET", url: "/api/snapshot" });
    const testRun = snapshot.json().testRuns.find((test: { id: string }) => test.id === "test_fake_codex");
    expect(testRun).toMatchObject({
      status: "passed",
      runId: start.json().id,
      workspacePath: "fake://workspace",
      branch: "patchpilot/wi_fake-codex-runner",
      commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    });
    const pullRequest = snapshot.json().pullRequests.find((item: { runId: string }) => item.runId === start.json().id);
    expect(pullRequest).toMatchObject({
      branchName: "patchpilot/wi_fake-codex-runner",
      baseBranch: "main",
      baseCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      headCommit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    });
    expect(pullRequest.bodyMarkdown).toContain("## Git");
    expect(pullRequest.bodyMarkdown).toContain("## Diff 摘要");
    expect(pullRequest.bodyMarkdown).toContain("## 工具调用");
    expect(pullRequest.bodyMarkdown).toContain("exec_command (fake test)");
    expect(pullRequest.bodyMarkdown).toContain("Branch: patchpilot/wi_fake-codex-runner");
    expect(pullRequest.bodyMarkdown).toContain("Commit: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");

    const traceArtifact = snapshot.json().artifacts.find((artifact: ArtifactRecord) => artifact.id === `artifact_trace_${start.json().id}`);
    const diffArtifact = snapshot.json().artifacts.find((artifact: ArtifactRecord) => artifact.id === `artifact_diff_${start.json().id}`);
    const traceContent = JSON.parse(await readFile(fileURLToPath(traceArtifact.uri), "utf8"));
    const diffContent = JSON.parse(await readFile(fileURLToPath(diffArtifact.uri), "utf8"));
    expect(traceContent.capture).toMatchObject({
      codexSessionId: "fake-session",
      agentMessages: ["Fake Codex agent reported completion."],
      reasoningSummaries: ["Fake Codex inspected the capture path."],
      toolCalls: [
        {
          id: "tool_fake_test",
          command: "fake test",
          status: "completed"
        }
      ],
      testOutputSummary: "passed: fake test (12ms). fake test passed"
    });
    expect(diffContent.diffSummary).toMatchObject({
      changedFileCount: 1,
      changedFiles: ["packages/codex-runner/src/index.ts"],
      hasChanges: true
    });
    await app.close();
  });

  it("uses an injected GitHub PullRequest adapter while keeping PullRequestRecord compatibility", async () => {
    const upserts: UpsertPullRequestInput[] = [];
    const comments: WriteReviewerCommentInput[] = [];
    const fakePullRequestAdapter: PullRequestAdapter = {
      provider: "github",
      upsertPullRequest: async (input) => {
        upserts.push(input);
        return {
          ...input.draft,
          id: "github://patchpilot-fixtures/delivery/pull/42",
          provider: "github",
          status: "ready_for_review",
          url: "https://github.com/patchpilot-fixtures/delivery/pull/42",
          createdAt: input.existing?.createdAt ?? input.draft.createdAt
        };
      },
      readChecks: async () => ({
        status: "passed",
        totalCount: 1,
        runs: [
          {
            name: "ci/test",
            status: "completed",
            conclusion: "success",
            url: "https://github.com/patchpilot-fixtures/delivery/actions/runs/1"
          }
        ]
      }),
      writeReviewerComment: async (input) => {
        comments.push(input);
        return {
          id: "9001",
          url: "https://github.com/patchpilot-fixtures/delivery/pull/42#issuecomment-9001"
        };
      }
    };
    const fakeCodexRunner: CodexRunner = {
      isAvailable: async () => true,
      isGitWorkspaceAvailable: async () => true,
      run: async () => ({
        summary: "Fake Codex runner completed the GitHub PR task.",
        previewUrl: "http://fake-preview.local",
        riskLevel: "low",
        changedFiles: ["services/api/src/store.ts"],
        tests: [
          {
            id: "test_fake_github_pr_adapter",
            status: "passed",
            command: "fake adapter e2e",
            summary: "fake adapter e2e passed",
            durationMs: 8
          }
        ],
        reviewerSummary: "Fake reviewer approved the GitHub PR adapter result.",
        runner: "codex",
        agentMessages: ["Fake Codex agent reported GitHub PR readiness."],
        reasoningSummaries: ["Fake Codex inspected PR adapter evidence."],
        toolCalls: [
          {
            id: "tool_fake_adapter_test",
            name: "exec_command",
            status: "completed",
            summary: "Ran fake adapter e2e",
            command: "fake adapter e2e",
            exitCode: 0,
            durationMs: 8
          }
        ],
        diffSummary: {
          changedFileCount: 1,
          changedFiles: ["services/api/src/store.ts"],
          hasChanges: true,
          branchName: "patchpilot/wi_fake-github-pr-adapter",
          baseBranch: "main",
          baseCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          headCommit: "cccccccccccccccccccccccccccccccccccccccc"
        },
        testOutputSummary: "passed: fake adapter e2e (8ms). fake adapter e2e passed",
        workspacePath: "/tmp/patchpilot/fake-github-worktree",
        branchName: "patchpilot/wi_fake-github-pr-adapter",
        baseBranch: "main",
        baseCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        headCommit: "cccccccccccccccccccccccccccccccccccccccc",
        codexSessionId: "fake-github-session"
      })
    };
    const app = await buildServer({
      store: new PatchPilotStore({
        codexRunner: fakeCodexRunner,
        pullRequestAdapter: fakePullRequestAdapter
      })
    });
    const create = await app.inject({
      method: "POST",
      url: "/api/requirements",
      payload: { rawInput: "验证 GitHub PR adapter 可以被 API 注入替换", template: "feature" }
    });
    const requirement = create.json();
    const prdResponse = await app.inject({ method: "POST", url: `/api/requirements/${requirement.id}/prd` });
    const prd = prdResponse.json().prd;
    const approval = await app.inject({ method: "POST", url: `/api/prds/${prd.id}/approve` });
    const workItem = approval.json().workItems[0];

    const start = await app.inject({
      method: "POST",
      url: `/api/work-items/${workItem.id}/start`,
      payload: { runner: "codex" }
    });
    const completedRun = await pollRun(app, start.json().id);
    expect(completedRun.status).toBe("succeeded");

    expect(upserts).toHaveLength(1);
    expect(upserts[0]?.workspacePath).toBe("/tmp/patchpilot/fake-github-worktree");
    expect(upserts[0]?.draft).toMatchObject({
      branchName: "patchpilot/wi_fake-github-pr-adapter",
      baseBranch: "main",
      baseCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      headCommit: "cccccccccccccccccccccccccccccccccccccccc"
    });
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("Fake reviewer approved the GitHub PR adapter result.");

    const snapshot = (await app.inject({ method: "GET", url: "/api/snapshot" })).json();
    const pullRequest = snapshot.pullRequests.find((item: { runId: string }) => item.runId === start.json().id);
    expect(pullRequest).toMatchObject({
      id: "github://patchpilot-fixtures/delivery/pull/42",
      provider: "github",
      status: "ready_for_review",
      url: "https://github.com/patchpilot-fixtures/delivery/pull/42",
      branchName: "patchpilot/wi_fake-github-pr-adapter",
      headCommit: "cccccccccccccccccccccccccccccccccccccccc"
    });
    const reviewRecord = snapshot.reviewRecords.find((item: { runId: string }) => item.runId === start.json().id);
    expect(reviewRecord.linkedPullRequestId).toBe(pullRequest.id);
    const auditActions = snapshot.auditEvents
      .filter((event: { runId?: string }) => event.runId === start.json().id)
      .map((event: { action: string }) => event.action);
    expect(auditActions).toContain("pull_request.ready_for_review");
    expect(auditActions).toContain("pull_request.checks_read");
    expect(auditActions).toContain("pull_request.reviewer_comment_written");
    await app.close();
  });

  it("fails unauthorized secret requests before starting the runner and writes audit evidence", async () => {
    const restoreEnv = setSecretBrokerEnv({
      PATCHPILOT_SECRET_BROKER_ENABLED: "true",
      PATCHPILOT_SECRET_BROKER_ALLOWED_SECRETS: undefined,
      PATCHPILOT_CI_GITHUB_TOKEN: undefined
    });
    let runnerCalled = false;
    let app: Awaited<ReturnType<typeof buildServer>> | undefined;
    try {
      const fakeCodexRunner: CodexRunner = {
        isAvailable: async () => true,
        isGitWorkspaceAvailable: async () => true,
        run: async () => {
          runnerCalled = true;
          return fakeCodexRunResult();
        }
      };
      const store = new PatchPilotStore({ codexRunner: fakeCodexRunner });
      app = await buildServer({ store });
      const workItem = await createApprovedWorkItem(app, "验证未授权 secret 请求会失败");
      await setWorkItemCapabilities(store, workItem.id, ["secret:github-ci-token"]);

      const start = await app.inject({
        method: "POST",
        url: `/api/work-items/${workItem.id}/start`,
        payload: { runner: "codex" }
      });
      expect(start.statusCode).toBe(201);

      const failedRun = await pollRun(app, start.json().id);
      expect(runnerCalled).toBe(false);
      expect(failedRun).toMatchObject({
        status: "failed",
        failureType: "policy_denied"
      });

      const snapshot = await app.inject({ method: "GET", url: "/api/snapshot" });
      const deniedAudit = snapshot
        .json()
        .auditEvents.find((event: { action: string; runId?: string }) =>
          event.action === "secret_broker.request_denied" && event.runId === failedRun.id
        );
      expect(deniedAudit).toMatchObject({
        targetType: "agent_run",
        targetId: failedRun.id,
        afterJson: {
          requestedSecretIds: ["github-ci-token"],
          denied: [{ id: "github-ci-token", reason: "not_configured" }],
          injectedCount: 0
        },
        metadataJson: {
          allowProductionSecrets: false,
          secretValuesStored: false
        }
      });
    } finally {
      await app?.close();
      restoreEnv();
    }
  });

  it("injects authorized dev and CI secrets with a redacted audit trail", async () => {
    const restoreEnv = setSecretBrokerEnv({
      PATCHPILOT_SECRET_BROKER_ENABLED: "true",
      PATCHPILOT_SECRET_BROKER_ALLOWED_SECRETS: JSON.stringify([
        {
          id: "github-ci-token",
          envVar: "GITHUB_TOKEN",
          sourceEnv: "PATCHPILOT_CI_GITHUB_TOKEN",
          environment: "ci"
        }
      ]),
      PATCHPILOT_CI_GITHUB_TOKEN: "ci-token-value"
    });
    let capturedSecretEnv: Record<string, string> | undefined;
    let app: Awaited<ReturnType<typeof buildServer>> | undefined;
    try {
      const fakeCodexRunner: CodexRunner = {
        isAvailable: async () => true,
        isGitWorkspaceAvailable: async () => true,
        run: async (_context, _emit, config) => {
          capturedSecretEnv = config.security.secretEnv;
          return fakeCodexRunResult("test_secret_broker_authorized");
        }
      };
      const store = new PatchPilotStore({ codexRunner: fakeCodexRunner });
      app = await buildServer({ store });
      const workItem = await createApprovedWorkItem(app, "验证授权 secret 注入可追踪");
      await setWorkItemCapabilities(store, workItem.id, ["secret:github-ci-token"]);

      const start = await app.inject({
        method: "POST",
        url: `/api/work-items/${workItem.id}/start`,
        payload: { runner: "codex" }
      });
      expect(start.statusCode).toBe(201);

      const completedRun = await pollRun(app, start.json().id);
      expect(completedRun.status).toBe("succeeded");
      expect(capturedSecretEnv).toEqual({ GITHUB_TOKEN: "ci-token-value" });
      expect(completedRun.result.secretBrokerEvidence).toMatchObject({
        requestedSecretIds: ["github-ci-token"],
        injected: [
          {
            id: "github-ci-token",
            envVar: "GITHUB_TOKEN",
            sourceEnv: "PATCHPILOT_CI_GITHUB_TOKEN",
            environment: "ci"
          }
        ],
        denied: []
      });

      const snapshot = await app.inject({ method: "GET", url: "/api/snapshot" });
      const snapshotBody = JSON.stringify(snapshot.json());
      expect(snapshotBody).not.toContain("ci-token-value");
      const injectedAudit = snapshot
        .json()
        .auditEvents.find((event: { action: string; runId?: string }) =>
          event.action === "secret_broker.secrets_injected" && event.runId === completedRun.id
        );
      expect(injectedAudit).toMatchObject({
        targetType: "agent_run",
        targetId: completedRun.id,
        afterJson: {
          requestedSecretIds: ["github-ci-token"],
          injected: [
            {
              id: "github-ci-token",
              envVar: "GITHUB_TOKEN",
              sourceEnv: "PATCHPILOT_CI_GITHUB_TOKEN",
              environment: "ci"
            }
          ]
        },
        metadataJson: {
          allowProductionSecrets: false,
          secretValuesStored: false
        }
      });
    } finally {
      await app?.close();
      restoreEnv();
    }
  });

  it("redacts fixture secrets from Codex run API responses and stored artifacts", async () => {
    const fixtureSecret = "patchpilot_fixture_secret_api_123";
    const brokerSecret = "ci-token-value";
    const restoreEnv = setSecretBrokerEnv({
      PATCHPILOT_SECRET_BROKER_ENABLED: "true",
      PATCHPILOT_SECRET_BROKER_ALLOWED_SECRETS: JSON.stringify([
        {
          id: "github-ci-token",
          envVar: "GITHUB_TOKEN",
          sourceEnv: "PATCHPILOT_CI_GITHUB_TOKEN",
          environment: "ci"
        }
      ]),
      PATCHPILOT_CI_GITHUB_TOKEN: brokerSecret
    });
    let app: Awaited<ReturnType<typeof buildServer>> | undefined;
    try {
      const fakeCodexRunner: CodexRunner = {
        isAvailable: async () => true,
        isGitWorkspaceAvailable: async () => true,
        run: async (_context, emit) => {
          await emit({
            step: "developing",
            type: "codex.output",
            message: `runner saw ${fixtureSecret} and ${brokerSecret}`
          });
          return {
            summary: `summary contains ${fixtureSecret} and ${brokerSecret}`,
            previewUrl: `http://fake-preview.local?token=${fixtureSecret}`,
            riskLevel: "low",
            changedFiles: [`src/${fixtureSecret}.ts`],
            tests: [
              {
                id: "test_secret_redaction",
                status: "passed",
                command: `echo GITHUB_TOKEN=${brokerSecret}`,
                summary: `test output ${fixtureSecret} ${brokerSecret}`,
                durationMs: 10
              }
            ],
            reviewerSummary: `reviewer saw ${fixtureSecret} ${brokerSecret}`,
            runner: "codex",
            agentMessages: [`agent message ${fixtureSecret} ${brokerSecret}`],
            reasoningSummaries: [`reasoning ${fixtureSecret} ${brokerSecret}`],
            toolCalls: [
              {
                id: "tool_secret_redaction",
                name: "exec_command",
                status: "completed",
                summary: `tool output ${fixtureSecret} ${brokerSecret}`,
                command: `curl https://example.com/hook?token=${fixtureSecret}`,
                exitCode: 0,
                durationMs: 3
              }
            ],
            diffSummary: {
              changedFileCount: 1,
              changedFiles: [`src/${fixtureSecret}.ts`],
              hasChanges: true,
              branchName: `patchpilot/${fixtureSecret}`,
              baseBranch: "main",
              baseCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              headCommit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
            },
            testOutputSummary: `passed with ${fixtureSecret} ${brokerSecret}`,
            workspacePath: `fake://${fixtureSecret}`,
            branchName: `patchpilot/${fixtureSecret}`,
            baseBranch: "main",
            baseCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            headCommit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            codexSessionId: "fake-session"
          };
        }
      };
      const store = new PatchPilotStore({ codexRunner: fakeCodexRunner });
      app = await buildServer({ store });
      const workItem = await createApprovedWorkItem(app, "验证 secret redaction acceptance");
      await setWorkItemCapabilities(store, workItem.id, ["secret:github-ci-token"]);

      const start = await app.inject({
        method: "POST",
        url: `/api/work-items/${workItem.id}/start`,
        payload: { runner: "codex" }
      });
      expect(start.statusCode).toBe(201);

      const completedRun = await pollRun(app, start.json().id);
      expect(completedRun.status).toBe("succeeded");
      const runResponse = await app.inject({ method: "GET", url: `/api/runs/${completedRun.id}` });
      const snapshot = await app.inject({ method: "GET", url: "/api/snapshot" });
      const runBody = JSON.stringify(runResponse.json());
      const snapshotBody = JSON.stringify(snapshot.json());

      expect(runBody).not.toContain(fixtureSecret);
      expect(runBody).not.toContain(brokerSecret);
      expect(snapshotBody).not.toContain(fixtureSecret);
      expect(snapshotBody).not.toContain(brokerSecret);
      expect(runBody).toContain("[REDACTED:");

      const runArtifacts = snapshot
        .json()
        .artifacts.filter((artifact: ArtifactRecord) => artifact.runId === completedRun.id);
      expect(runArtifacts).toHaveLength(5);
      for (const artifact of runArtifacts) {
        if (!artifact.uri.startsWith("file://")) continue;
        const content = await readFile(fileURLToPath(artifact.uri), "utf8");
        expect(content).not.toContain(fixtureSecret);
        expect(content).not.toContain(brokerSecret);
      }
    } finally {
      await app?.close();
      restoreEnv();
    }
  });

  it("classifies failed codex test runs and creates defect evidence", async () => {
    const failedTestRun: TestRun = {
      id: "test_fake_codex_failed",
      status: "failed",
      command: "pnpm test -- --run fake failure",
      summary: "1 fake assertion failed",
      durationMs: 91,
      commit: "cccccccccccccccccccccccccccccccccccccccc",
      branch: "patchpilot/fake-failing-branch",
      failureSummary: "expected fake result to pass",
      exitCode: 1,
      retryCount: 0,
      attempt: 1,
      maxAttempts: 1,
      flakySignal: false,
      runner: "patchpilot-test-runner",
      environmentImage: "local",
      workspacePath: "fake://failed-workspace",
      logArtifactId: "artifact_test_log_fake_failure",
      artifactIds: ["artifact_test_log_fake_failure"]
    };
    const fakeCodexRunner: CodexRunner = {
      isAvailable: async () => true,
      isGitWorkspaceAvailable: async () => true,
      run: async (_context, emit) => {
        await emit({
          step: "testing",
          type: "test.failed",
          message: "Fake Codex runner test failed"
        });
        throw new CodexRunError("测试未通过：1 fake assertion failed", "test_failed", failedTestRun);
      }
    };
    const app = await buildServer({ store: new PatchPilotStore({ codexRunner: fakeCodexRunner }) });
    const workItem = await createApprovedWorkItem(app, "验证失败分类和 defect 沉淀");

    const start = await app.inject({
      method: "POST",
      url: `/api/work-items/${workItem.id}/start`,
      payload: { runner: "codex" }
    });
    expect(start.statusCode).toBe(201);

    const failedRun = await pollRun(app, start.json().id);
    expect(failedRun).toMatchObject({
      status: "failed",
      failureType: "test_failed",
      failureSummary: "测试未通过：1 fake assertion failed"
    });

    const snapshot = await app.inject({ method: "GET", url: "/api/snapshot" });
    const testRun = snapshot.json().testRuns.find((test: { id: string }) => test.id === failedTestRun.id);
    const defect = snapshot.json().bugs.find((bug: { sourceRunId?: string }) => bug.sourceRunId === failedRun.id);
    const testCase = snapshot
      .json()
      .testCases.find((candidate: { id: string; workItemId: string }) =>
        candidate.workItemId === workItem.id && !candidate.id.startsWith("tc_contract_")
      );
    const workspace = snapshot
      .json()
      .workspaceRuns.find((candidate: { runId: string }) => candidate.runId === failedRun.id);
    const failedArtifacts = snapshot
      .json()
      .artifacts.filter((artifact: ArtifactRecord) => artifact.runId === failedRun.id);
    const auditActions = snapshot.json().auditEvents.map((event: { action: string }) => event.action);

    expect(testRun).toMatchObject({
      status: "failed",
      runId: failedRun.id,
      workItemId: workItem.id,
      commit: "cccccccccccccccccccccccccccccccccccccccc",
      branch: "patchpilot/fake-failing-branch",
      testCaseId: testCase.id
    });
    expect(testCase).toMatchObject({
      status: "failed",
      lastRunId: failedRun.id,
      lastTestRunId: failedTestRun.id,
      flaky: false
    });
    expect(workspace).toMatchObject({
      status: "failed",
      path: "fake://failed-workspace"
    });
    expect(defect).toMatchObject({
      status: "reported",
      reporter: "system",
      requirementId: failedRun.requirementId,
      prdId: failedRun.prdId,
      workItemId: workItem.id,
      sourceRunId: failedRun.id,
      sourceTestRunId: failedTestRun.id,
      sourceFailureType: "test_failed",
      sourceCommit: "cccccccccccccccccccccccccccccccccccccccc",
      sourceBranch: "patchpilot/fake-failing-branch"
    });
    expect(new Set(failedArtifacts.map((artifact: ArtifactRecord) => artifact.kind))).toEqual(
      new Set(["log", "test_report", "trace", "diff", "preview_metadata"])
    );
    expect(failedArtifacts.every((artifact: ArtifactRecord) => artifact.storage === "local_fs")).toBe(true);
    expect(testRun.artifactIds.every((artifactId: string) =>
      failedArtifacts.some((artifact: ArtifactRecord) => artifact.id === artifactId)
    )).toBe(true);
    expect(failedRun.artifactIds.every((artifactId: string) =>
      failedArtifacts.some((artifact: ArtifactRecord) => artifact.id === artifactId)
    )).toBe(true);
    expect(auditActions).toEqual(
      expect.arrayContaining(["test_run.failed", "defect.created", "agent_run.failed"])
    );

    await app.close();
  });

  it("writes audit evidence when egress policy denies a prohibited endpoint", async () => {
    const egressPolicyEvidence: EgressPolicyEvidence = {
      enabled: true,
      mode: "proxy_sidecar",
      allowedHosts: ["registry.npmjs.org", "api.openai.com"],
      auditLogPath: ".patchpilot/egress-audit.jsonl",
      allowedCount: 1,
      deniedCount: 1,
      denied: [
        {
          at: "2026-06-11T00:00:01.000Z",
          decision: "denied",
          reason: "metadata_endpoint",
          protocol: "http",
          host: "169.254.169.254",
          port: 80,
          target: "http://169.254.169.254/latest/meta-data",
          resolvedIps: ["169.254.169.254"]
        }
      ],
      recent: [
        {
          at: "2026-06-11T00:00:00.000Z",
          decision: "allowed",
          reason: "allowlisted",
          protocol: "https",
          host: "registry.npmjs.org",
          port: 443,
          target: "https://registry.npmjs.org/"
        },
        {
          at: "2026-06-11T00:00:01.000Z",
          decision: "denied",
          reason: "metadata_endpoint",
          protocol: "http",
          host: "169.254.169.254",
          port: 80,
          target: "http://169.254.169.254/latest/meta-data",
          resolvedIps: ["169.254.169.254"]
        }
      ]
    };
    const fakeCodexRunner: CodexRunner = {
      isAvailable: async () => true,
      isGitWorkspaceAvailable: async () => true,
      run: async (_context, emit) => {
        await emit({
          step: "developing",
          type: "codex.output",
          message: "Fake Codex runner attempted prohibited metadata egress"
        });
        throw new CodexRunError(
          "Codex 执行失败：PatchPilot egress policy denied http://169.254.169.254/latest/meta-data",
          "policy_denied",
          undefined,
          egressPolicyEvidence
        );
      }
    };
    const app = await buildServer({ store: new PatchPilotStore({ codexRunner: fakeCodexRunner }) });
    const workItem = await createApprovedWorkItem(app, "验证 egress policy deny audit");

    const start = await app.inject({
      method: "POST",
      url: `/api/work-items/${workItem.id}/start`,
      payload: { runner: "codex" }
    });
    expect(start.statusCode).toBe(201);

    const failedRun = await pollRun(app, start.json().id);
    expect(failedRun).toMatchObject({
      status: "failed",
      failureType: "policy_denied"
    });

    const snapshot = await app.inject({ method: "GET", url: "/api/snapshot" });
    const deniedAudit = snapshot
      .json()
      .auditEvents.find((event: { action: string; runId?: string }) =>
        event.action === "network.egress_denied" && event.runId === failedRun.id
      );
    expect(deniedAudit).toMatchObject({
      targetType: "agent_run",
      targetId: failedRun.id,
      afterJson: {
        deniedCount: 1,
        denied: [
          {
            reason: "metadata_endpoint",
            target: "http://169.254.169.254/latest/meta-data"
          }
        ]
      },
      metadataJson: {
        auditLogPath: ".patchpilot/egress-audit.jsonl"
      }
    });

    await app.close();
  });

  it("writes audit evidence when the command wrapper denies a bypass attempt", async () => {
    let delegatedExecutorCalled = false;
    const fakeCodexRunner: CodexRunner = {
      isAvailable: async () => true,
      isGitWorkspaceAvailable: async () => true,
      run: async (_context, _emit, config) => {
        await executeCommand({
          kind: "test",
          command: "npm test",
          cwd: process.cwd(),
          timeoutMs: 5000,
          capabilityManifest: config.policyManifest,
          executor: async () => {
            delegatedExecutorCalled = true;
            return {
              exitCode: 0,
              output: "bypassed",
              stdout: "bypassed",
              stderr: "",
              timedOut: false,
              durationMs: 1
            };
          }
        });
        return fakeCodexRunResult("test_command_wrapper_denied");
      }
    };
    const app = await buildServer({ store: new PatchPilotStore({ codexRunner: fakeCodexRunner }) });
    const workItem = await createApprovedWorkItem(app, "验证 command wrapper deny audit");

    const start = await app.inject({
      method: "POST",
      url: `/api/work-items/${workItem.id}/start`,
      payload: { runner: "codex" }
    });
    expect(start.statusCode).toBe(201);

    const failedRun = await pollRun(app, start.json().id);
    expect(delegatedExecutorCalled).toBe(false);
    expect(failedRun).toMatchObject({
      status: "failed",
      failureType: "policy_denied"
    });

    const snapshot = await app.inject({ method: "GET", url: "/api/snapshot" });
    const deniedAudit = snapshot
      .json()
      .auditEvents.find((event: { action: string; runId?: string }) =>
        event.action === "command.policy_denied" && event.runId === failedRun.id
      );
    expect(deniedAudit).toMatchObject({
      targetType: "agent_run",
      targetId: failedRun.id,
      afterJson: {
        command: {
          kind: "test",
          command: "npm test",
          policyDecision: {
            decision: "denied",
            reason: "command_not_allowlisted",
            target: "npm test"
          }
        }
      },
      metadataJson: {
        outputCaptured: false,
        outputBytes: 0
      }
    });

    await app.close();
  });

  it("starts the whole agent team for a PRD", async () => {
    const app = await buildServer();
    const create = await app.inject({
      method: "POST",
      url: "/api/requirements",
      payload: { rawInput: "让前端后端测试运维 agent 一起交付一个功能", template: "feature" }
    });
    const requirement = create.json();
    const prdResponse = await app.inject({ method: "POST", url: `/api/requirements/${requirement.id}/prd` });
    const prd = prdResponse.json().prd;

    const startTeam = await app.inject({
      method: "POST",
      url: `/api/prds/${prd.id}/start-team`,
      payload: { runner: "simulated" }
    });
    expect(startTeam.statusCode).toBe(201);
    expect(startTeam.json().runs).toHaveLength(4);
    expect(startTeam.json().interfaceContracts).toHaveLength(3);
    expect(
      startTeam.json().interfaceContracts.every((contract: { status: string }) => contract.status === "approved")
    ).toBe(true);
    expect(startTeam.json().workItems.map((item: { role: string }) => item.role).sort()).toEqual([
      "backend",
      "frontend",
      "ops",
      "test"
    ]);

    const completedRuns = await pollPrdRuns(app, prd.id, 4);
    expect(completedRuns.every((run: { status: string }) => run.status === "succeeded")).toBe(true);
    const evidenceSnapshot = await app.inject({ method: "GET", url: "/api/snapshot" });
    const evidence = evidenceSnapshot.json();
    const prdWorkspaceRuns = evidenceSnapshot
      .json()
      .workspaceRuns.filter((workspace: { prdId: string }) => workspace.prdId === prd.id);
    const prdTestRuns = evidenceSnapshot
      .json()
      .testRuns.filter((test: { prdId: string }) => test.prdId === prd.id);
    const prdContractDiffTestRuns = prdTestRuns.filter((test: { runner?: string }) =>
      test.runner === "patchpilot-contract-registry"
    );
    const prdContractValidationTestRuns = prdTestRuns.filter((test: { runner?: string }) =>
      test.runner === "patchpilot-contract-tests"
    );
    const prdExecutionTestRuns = prdTestRuns.filter((test: { runner?: string }) =>
      test.runner === "simulated-test-runner"
    );
    const prdTestCases = evidenceSnapshot
      .json()
      .testCases.filter((testCase: { prdId: string }) => testCase.prdId === prd.id);
    const prdGeneratedContractTestCases = prdTestCases.filter((testCase: { id: string }) =>
      testCase.id.startsWith("tc_contract_")
    );
    const prdExecutionTestCases = prdTestCases.filter((testCase: { id: string }) =>
      !testCase.id.startsWith("tc_contract_")
    );
    const prdArtifacts = evidence.artifacts.filter((artifact: ArtifactRecord) => artifact.prdId === prd.id);
    const prdArtifactIds = new Set(prdArtifacts.map((artifact: ArtifactRecord) => artifact.id));
    const prdAgentRuns = evidence.agentRuns.filter((run: { prdId: string }) => run.prdId === prd.id);
    const prdPullRequests = evidenceSnapshot
      .json()
      .pullRequests.filter((pullRequest: { prdId: string }) => pullRequest.prdId === prd.id);
    const prdReviewRecords = evidenceSnapshot
      .json()
      .reviewRecords.filter((review: { prdId: string }) => review.prdId === prd.id);
    const prdAuditActions = evidenceSnapshot
      .json()
      .auditEvents.filter((event: { prdId?: string }) => event.prdId === prd.id)
      .map((event: { action: string }) => event.action);
    expect(prdWorkspaceRuns).toHaveLength(4);
    expect(prdWorkspaceRuns.every((workspace: { status: string }) => workspace.status === "archived")).toBe(true);
    expect(prdTestCases).toHaveLength(20);
    expect(prdGeneratedContractTestCases).toHaveLength(16);
    expect(prdExecutionTestCases).toHaveLength(4);
    expect(prdTestCases.every((testCase: { status: string }) => testCase.status === "passed")).toBe(true);
    expect(prdExecutionTestCases.every((testCase: { lastRunId?: string; lastTestRunId?: string }) => testCase.lastRunId && testCase.lastTestRunId)).toBe(true);
    expect(prdGeneratedContractTestCases.every((testCase: { lastRunId?: string; lastTestRunId?: string }) => !testCase.lastRunId && testCase.lastTestRunId)).toBe(true);
    expect(prdTestCases.every((testCase: { flaky?: boolean }) => testCase.flaky === false)).toBe(true);
    expect(prdExecutionTestCases.map((testCase: { workItemId: string }) => testCase.workItemId).sort()).toEqual(
      startTeam.json().workItems.map((item: { id: string }) => item.id).sort()
    );
    expect(prdContractDiffTestRuns).toHaveLength(3);
    expect(prdContractDiffTestRuns.every((test: { status: string }) => test.status === "passed")).toBe(true);
    expect(prdContractValidationTestRuns).toHaveLength(13);
    expect(prdContractValidationTestRuns.every((test: { status: string }) => test.status === "passed")).toBe(true);
    expect(prdContractValidationTestRuns.map((test: { summary: string }) => test.summary)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("frontend consumer"),
        expect.stringContaining("worker consumer")
      ])
    );
    expect(prdExecutionTestRuns).toHaveLength(4);
    expect(prdExecutionTestRuns.every((test: { status: string }) => test.status === "passed")).toBe(true);
    expect(prdTestRuns.every((test: { testCaseId?: string }) => test.testCaseId)).toBe(true);
    expect(
      prdExecutionTestRuns.every((test: {
        runner?: string;
        environmentImage?: string;
        workspacePath?: string;
        exitCode?: number | null;
        logArtifactId?: string;
        artifactIds?: string[];
        retryCount?: number;
        flakySignal?: boolean;
      }) =>
        test.runner === "simulated-test-runner" &&
        test.environmentImage === "simulated" &&
        test.workspacePath?.startsWith("simulated://") &&
        test.exitCode === 0 &&
        Boolean(test.logArtifactId) &&
        test.artifactIds?.includes(test.logArtifactId || "") &&
        test.retryCount === 0 &&
        test.flakySignal === false
      )
    ).toBe(true);
    expect(prdArtifacts.filter((artifact: ArtifactRecord) => artifact.kind === "log")).toHaveLength(4);
    expect(prdArtifacts.filter((artifact: ArtifactRecord) => artifact.kind === "test_report")).toHaveLength(4);
    expect(prdArtifacts.filter((artifact: ArtifactRecord) => artifact.kind === "trace")).toHaveLength(4);
    expect(prdArtifacts.filter((artifact: ArtifactRecord) => artifact.kind === "diff")).toHaveLength(7);
    expect(prdArtifacts.filter((artifact: ArtifactRecord) => artifact.kind === "preview_metadata")).toHaveLength(4);
    expect(
      prdArtifacts.every((artifact: ArtifactRecord) =>
        artifact.storage === "local_fs" &&
        artifact.uri.startsWith("file://") &&
        Boolean(artifact.checksumSha256) &&
        artifact.sizeBytes > 0
      )
    ).toBe(true);
    expect(
      prdExecutionTestRuns.every((test: { id: string; artifactIds?: string[]; logArtifactId?: string }) => {
        const artifactIds = test.artifactIds ?? [];
        const linkedArtifactKinds = prdArtifacts
          .filter((artifact: ArtifactRecord) => artifact.testRunId === test.id)
          .map((artifact: ArtifactRecord) => artifact.kind);
        return (
          artifactIds.length >= 2 &&
          artifactIds.every((artifactId) => prdArtifactIds.has(artifactId)) &&
          artifactIds.includes(test.logArtifactId || "") &&
          linkedArtifactKinds.includes("log") &&
          linkedArtifactKinds.includes("test_report")
        );
      })
    ).toBe(true);
    expect(
      prdAgentRuns.every((run: {
        id: string;
        artifactIds?: string[];
        result?: { artifactIds?: string[] };
      }) => {
        const artifactIds = run.artifactIds ?? [];
        const resultArtifactIds = run.result?.artifactIds ?? [];
        return (
          artifactIds.length >= 3 &&
          resultArtifactIds.length >= artifactIds.length &&
          artifactIds.every((artifactId) => prdArtifactIds.has(artifactId)) &&
          resultArtifactIds.every((artifactId) => prdArtifactIds.has(artifactId)) &&
          artifactIds.includes(`artifact_trace_${run.id}`) &&
          artifactIds.includes(`artifact_diff_${run.id}`) &&
          artifactIds.includes(`artifact_preview_${run.id}`)
        );
      })
    ).toBe(true);
    expect(prdPullRequests).toHaveLength(4);
    expect(
      prdPullRequests.every((pullRequest: { status: string }) => pullRequest.status === "ready_for_review")
    ).toBe(true);
    expect(prdPullRequests[0].bodyMarkdown).toContain("## 需求");
    expect(prdPullRequests[0].bodyMarkdown).toContain("## 工作项");
    expect(prdPullRequests[0].bodyMarkdown).toContain("## Git");
    expect(prdPullRequests[0].bodyMarkdown).toContain("## 测试结果");
    expect(prdPullRequests[0].bodyMarkdown).toContain("## Reviewer Agent 摘要");
    expect(prdReviewRecords).toHaveLength(4);
    expect(prdReviewRecords.every((review: { status: string }) => review.status === "approved")).toBe(true);
    expect(prdReviewRecords[0].summary).toContain("Reviewer agent");
    expect(prdReviewRecords[0].linkedPullRequestId).toEqual(expect.any(String));
    expect(prdReviewRecords[0].testSummary).toContain("passed");
    expect(prdAuditActions).toContain("prd.approved");
    expect(prdAuditActions).toContain("work_item.started");
    expect(prdAuditActions).toContain("test_run.passed");
    expect(prdAuditActions).toContain("review.approved");
    expect(prdAuditActions).toContain("agent_run.succeeded");
    expect(prdAuditActions).toContain("pull_request.ready_for_review");

    const restartTeam = await app.inject({
      method: "POST",
      url: `/api/prds/${prd.id}/start-team`,
      payload: { runner: "simulated" }
    });
    expect(restartTeam.statusCode).toBe(201);
    expect(restartTeam.json().runs.map((run: { id: string }) => run.id).sort()).toEqual(
      completedRuns.map((run: { id: string }) => run.id).sort()
    );

    const teamAcceptance = await app.inject({
      method: "POST",
      url: `/api/prds/${prd.id}/acceptance`,
      payload: { status: "accepted" }
    });
    expect(teamAcceptance.statusCode).toBe(200);
    expect(teamAcceptance.json().decisions).toHaveLength(4);
    expect(teamAcceptance.json().workItems.every((item: { status: string }) => item.status === "done")).toBe(true);

    await app.close();
  });

  it("turns rejected team acceptance into ready rework and starts new runs", async () => {
    const app = await buildServer();
    const create = await app.inject({
      method: "POST",
      url: "/api/requirements",
      payload: { rawInput: "验证验收拒绝后 agent team 会自动返工", template: "feature" }
    });
    const requirement = create.json();
    const prdResponse = await app.inject({ method: "POST", url: `/api/requirements/${requirement.id}/prd` });
    const prd = prdResponse.json().prd;

    const firstStart = await app.inject({
      method: "POST",
      url: `/api/prds/${prd.id}/start-team`,
      payload: { runner: "simulated" }
    });
    expect(firstStart.statusCode).toBe(201);
    const firstRuns = await pollPrdRuns(app, prd.id, 4);
    const firstRunIds = firstRuns.map((run: { id: string }) => run.id).sort();

    const rejection = await app.inject({
      method: "POST",
      url: `/api/prds/${prd.id}/acceptance`,
      payload: { status: "rejected", reason: "前端状态摘要还不够清楚，需要返工。" }
    });
    expect(rejection.statusCode).toBe(200);
    expect(rejection.json().decisions).toHaveLength(4);

    const rejectedSnapshot = await app.inject({ method: "GET", url: "/api/snapshot" });
    const reworkItems = rejectedSnapshot.json().workItems.filter((item: { prdId: string }) => item.prdId === prd.id);
    expect(reworkItems).toHaveLength(4);
    expect(reworkItems.every((item: { status: string }) => item.status === "ready")).toBe(true);
    expect(reworkItems.every((item: { assignedAgentId?: string }) => !item.assignedAgentId)).toBe(true);
    expect(reworkItems.every((item: { reworkCount?: number }) => item.reworkCount === 1)).toBe(true);

    const staleAcceptance = await app.inject({
      method: "POST",
      url: `/api/prds/${prd.id}/acceptance`,
      payload: { status: "accepted", reason: "误点了旧交付结果" }
    });
    expect(staleAcceptance.statusCode).toBe(409);

    const backendReworkItem = reworkItems.find((item: { role: string }) => item.role === "backend");
    if (!backendReworkItem) throw new Error("Backend rework item was not generated");
    const claim = await app.inject({
      method: "POST",
      url: `/api/work-items/${backendReworkItem.id}/claim`,
      payload: { agentId: "agent_backend" }
    });
    expect(claim.statusCode).toBe(200);
    const claimedStart = await app.inject({
      method: "POST",
      url: `/api/work-items/${backendReworkItem.id}/start`,
      payload: { runner: "simulated", claimToken: claim.json().claimToken }
    });
    expect(claimedStart.statusCode).toBe(201);
    expect(firstRunIds).not.toContain(claimedStart.json().id);

    const reworkStart = await app.inject({
      method: "POST",
      url: `/api/prds/${prd.id}/start-team`,
      payload: { runner: "simulated" }
    });
    expect(reworkStart.statusCode).toBe(201);
    expect(reworkStart.json().runs).toHaveLength(4);
    expect(reworkStart.json().runs.map((run: { id: string }) => run.id).sort()).not.toEqual(firstRunIds);
    await Promise.all(reworkStart.json().runs.map((run: { id: string }) => pollRun(app, run.id)));

    const reworkSnapshot = await app.inject({ method: "GET", url: "/api/snapshot" });
    const allRuns = reworkSnapshot.json().agentRuns.filter((run: { prdId: string }) => run.prdId === prd.id);
    const reworkAuditActions = reworkSnapshot
      .json()
      .auditEvents.filter((event: { prdId?: string }) => event.prdId === prd.id)
      .map((event: { action: string }) => event.action);
    expect(allRuns).toHaveLength(8);
    expect(reworkAuditActions).toContain("work_item.rework_requested");

    await app.close();
  });

  it("does not duplicate a run when start-team sees an already running claimed work item", async () => {
    const app = await buildServer();
    const create = await app.inject({
      method: "POST",
      url: "/api/requirements",
      payload: { rawInput: "验证 claimed 任务重复 start-team 不产生重复 run", template: "feature" }
    });
    const requirement = create.json();
    const prdResponse = await app.inject({ method: "POST", url: `/api/requirements/${requirement.id}/prd` });
    const prd = prdResponse.json().prd;
    const approval = await app.inject({ method: "POST", url: `/api/prds/${prd.id}/approve` });
    const workItem = approval.json().workItems[0];
    const claim = await app.inject({
      method: "POST",
      url: `/api/work-items/${workItem.id}/claim`,
      payload: { agentId: "agent_backend" }
    });
    expect(claim.statusCode).toBe(200);
    const firstStart = await app.inject({
      method: "POST",
      url: `/api/work-items/${workItem.id}/start`,
      payload: { runner: "simulated", claimToken: claim.json().claimToken }
    });

    const teamStart = await app.inject({
      method: "POST",
      url: `/api/prds/${prd.id}/start-team`,
      payload: { runner: "simulated" }
    });

    expect(teamStart.statusCode).toBe(201);
    const snapshot = await app.inject({ method: "GET", url: "/api/snapshot" });
    const runsForWorkItem = snapshot.json().agentRuns.filter((run: { workItemId: string }) => run.workItemId === workItem.id);
    expect(runsForWorkItem).toHaveLength(1);
    expect(runsForWorkItem[0].id).toBe(firstStart.json().id);
    await pollPrdRuns(app, prd.id, 4);
    await app.close();
  });

  it("supports grill-me style clarification turns before PRD creation", async () => {
    const app = await buildServer();
    const create = await app.inject({
      method: "POST",
      url: "/api/requirements",
      payload: { rawInput: "做一个可以分配 agent 任务的平台", template: "feature" }
    });
    const requirement = create.json();
    expect(requirement.clarificationTurns).toHaveLength(1);
    expect(requirement.clarificationTurns[0].speaker).toBe("agent");
    expect(requirement.clarificationTurns[0].recommendedAnswer).toEqual(expect.any(String));

    const turn = await app.inject({
      method: "POST",
      url: `/api/requirements/${requirement.id}/clarification-turn`,
      payload: { message: "主要用户是项目负责人，第一版要能看任务状态和 agent 归属。" }
    });
    expect(turn.statusCode).toBe(200);
    expect(turn.json().requirement.clarificationTurns).toHaveLength(3);
    expect(turn.json().nextQuestion.recommendedAnswer).toEqual(expect.any(String));

    const prdResponse = await app.inject({ method: "POST", url: `/api/requirements/${requirement.id}/prd` });
    expect(prdResponse.statusCode).toBe(200);
    expect(prdResponse.json().prd.bodyMarkdown).toContain("## 澄清记录");
    expect(prdResponse.json().prd.bodyMarkdown).toContain("主要用户是项目负责人");
    await app.close();
  });

  it("creates bug work and lets the test agent claim it", async () => {
    const app = await buildServer();
    const bugResponse = await app.inject({
      method: "POST",
      url: "/api/bugs",
      payload: {
        title: "开始执行按钮没有反应",
        description: "确认 PRD 后点击开始执行没有跳转。",
        reproductionSteps: "提交需求，生成 PRD，点击开始执行。",
        expectedBehavior: "页面跳转到执行进度页。",
        actualBehavior: "停留在确认页。",
        severity: "high"
      }
    });
    expect(bugResponse.statusCode).toBe(201);
    const { bug, workItem } = bugResponse.json();
    expect(bug.status).toBe("reported");
    expect(workItem.role).toBe("test");
    expect(workItem.sourceBugId).toBe(bug.id);

    const claim = await app.inject({
      method: "POST",
      url: `/api/work-items/${workItem.id}/claim`,
      payload: { agentId: "agent_test" }
    });
    expect(claim.statusCode).toBe(200);
    expect(claim.json().workItem.status).toBe("claimed");
    expect(claim.json().agent.status).toBe("busy");
    expect(claim.json().bug.status).toBe("needs_repro");

    await app.close();
  });

  it("turns a reproduced bug into a developer fix task and closes it after verification", async () => {
    const app = await buildServer();
    const bugResponse = await app.inject({
      method: "POST",
      url: "/api/bugs",
      payload: {
        title: "保存按钮没有反馈",
        description: "点击保存后页面没有任何反馈。",
        reproductionSteps: "打开设置页，修改标题，点击保存。",
        expectedBehavior: "展示保存成功提示。",
        actualBehavior: "页面没有变化。",
        severity: "medium"
      }
    });
    const { bug, workItem } = bugResponse.json();

    const reproStart = await app.inject({
      method: "POST",
      url: `/api/work-items/${workItem.id}/start`,
      payload: { runner: "simulated" }
    });
    expect(reproStart.statusCode).toBe(201);
    const reproRun = await pollRun(app, reproStart.json().id);
    expect(reproRun.status).toBe("succeeded");

    const snapshotAfterRepro = await app.inject({ method: "GET", url: "/api/snapshot" });
    const reproducedBug = snapshotAfterRepro.json().bugs.find((item: { id: string }) => item.id === bug.id);
    const fixWorkItem = snapshotAfterRepro
      .json()
      .workItems.find((item: { sourceBugId?: string; role: string }) => item.sourceBugId === bug.id && item.role === "backend");

    expect(reproducedBug.status).toBe("reproduced");
    expect(fixWorkItem.status).toBe("ready");
    expect(fixWorkItem.title).toContain("修复 bug");

    const fixStart = await app.inject({
      method: "POST",
      url: `/api/work-items/${fixWorkItem.id}/start`,
      payload: { runner: "simulated" }
    });
    expect(fixStart.statusCode).toBe(201);
    const fixRun = await pollRun(app, fixStart.json().id);
    expect(fixRun.status).toBe("succeeded");
    expect(fixRun.result.summary).toContain("完成模拟修复");

    const snapshotAfterFix = await app.inject({ method: "GET", url: "/api/snapshot" });
    const closedBug = snapshotAfterFix.json().bugs.find((item: { id: string }) => item.id === bug.id);
    const bugTestRuns = snapshotAfterFix
      .json()
      .testRuns.filter((test: { prdId: string }) => test.prdId === bug.prdId);
    const bugExecutionTestRuns = bugTestRuns.filter((test: { runner?: string }) =>
      test.runner !== "patchpilot-contract-registry" && test.runner !== "patchpilot-contract-tests"
    );
    const bugContractTestRuns = bugTestRuns.filter((test: { runner?: string }) =>
      test.runner === "patchpilot-contract-registry" || test.runner === "patchpilot-contract-tests"
    );
    const bugAuditActions = snapshotAfterFix
      .json()
      .auditEvents.filter((event: { prdId?: string }) => event.prdId === bug.prdId)
      .map((event: { action: string }) => event.action);
    expect(closedBug.status).toBe("closed");
    expect(bugExecutionTestRuns).toHaveLength(2);
    expect(bugContractTestRuns).toHaveLength(16);
    expect(bugTestRuns.every((test: { status: string }) => test.status === "passed")).toBe(true);
    expect(bugAuditActions).toContain("bug.reproduced");
    expect(bugAuditActions).toContain("bug.verifying");
    expect(bugAuditActions).toContain("bug.closed");

    await app.close();
  });
});

async function pollRun(app: Awaited<ReturnType<typeof buildServer>>, runId: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await app.inject({ method: "GET", url: `/api/runs/${runId}` });
    const run = response.json();
    if (run.status === "succeeded" || run.status === "failed") return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Run did not finish: ${runId}`);
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const budgetEnvKeys = [
  "PATCHPILOT_BUDGET_MAX_COST_USD",
  "PATCHPILOT_BUDGET_PRD_USD",
  "PATCHPILOT_BUDGET_WORK_ITEM_USD",
  "PATCHPILOT_BUDGET_RUN_USD",
  "PATCHPILOT_BUDGET_SOFT_THRESHOLD_RATIO"
] as const;

const artifactEnvKeys = [
  "PATCHPILOT_ARTIFACT_STORE",
  "PATCHPILOT_ARTIFACT_ROOT",
  "PATCHPILOT_ARTIFACT_S3_ENDPOINT",
  "PATCHPILOT_ARTIFACT_S3_REGION",
  "PATCHPILOT_ARTIFACT_S3_BUCKET",
  "PATCHPILOT_ARTIFACT_S3_ACCESS_KEY_ID",
  "PATCHPILOT_ARTIFACT_S3_SECRET_ACCESS_KEY",
  "PATCHPILOT_ARTIFACT_S3_FORCE_PATH_STYLE",
  "PATCHPILOT_ARTIFACT_S3_PREFIX"
] as const;

function setBudgetEnv(values: Partial<Record<(typeof budgetEnvKeys)[number], string>>) {
  const previous = new Map<(typeof budgetEnvKeys)[number], string | undefined>();
  for (const key of budgetEnvKeys) {
    previous.set(key, process.env[key]);
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  return () => {
    for (const key of budgetEnvKeys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function setArtifactEnv(values: Partial<Record<(typeof artifactEnvKeys)[number], string>>) {
  const previous = new Map<(typeof artifactEnvKeys)[number], string | undefined>();
  for (const key of artifactEnvKeys) {
    previous.set(key, process.env[key]);
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  return () => {
    for (const key of artifactEnvKeys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

async function createApprovedPrd(app: Awaited<ReturnType<typeof buildServer>>, rawInput: string) {
  const create = await app.inject({
    method: "POST",
    url: "/api/requirements",
    payload: { rawInput, template: "feature" }
  });
  expect(create.statusCode).toBe(201);
  const requirement = create.json();
  const prdResponse = await app.inject({ method: "POST", url: `/api/requirements/${requirement.id}/prd` });
  expect(prdResponse.statusCode).toBe(200);
  const prd = prdResponse.json().prd;
  const approval = await app.inject({ method: "POST", url: `/api/prds/${prd.id}/approve` });
  expect(approval.statusCode).toBe(200);
  return prd as { id: string };
}

async function createApprovedWorkItem(app: Awaited<ReturnType<typeof buildServer>>, rawInput: string) {
  const prd = await createApprovedPrd(app, rawInput);
  const snapshot = await app.inject({ method: "GET", url: "/api/snapshot" });
  const workItem = snapshot.json().workItems.find((item: { prdId: string }) => item.prdId === prd.id) as
    | { id: string }
    | undefined;
  if (!workItem) throw new Error("Expected approved PRD to create at least one work item");
  return workItem;
}

async function setWorkItemCapabilities(store: PatchPilotStore, workItemId: string, requiredCapabilities: string[]) {
  const snapshot = await store.exportJsonSnapshot();
  const workItem = snapshot.workItems.find((item) => item.id === workItemId);
  if (!workItem) throw new Error(`Expected work item to exist: ${workItemId}`);
  workItem.requiredCapabilities = requiredCapabilities;
  await store.importJsonSnapshot(snapshot);
}

function setSecretBrokerEnv(values: Record<string, string | undefined>) {
  const keys = [
    "PATCHPILOT_SECRET_BROKER_ENABLED",
    "PATCHPILOT_SECRET_BROKER_ALLOWED_SECRETS",
    "PATCHPILOT_CI_GITHUB_TOKEN"
  ];
  const previous = new Map<string, string | undefined>();
  for (const key of keys) {
    previous.set(key, process.env[key]);
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  return () => {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function fakeCodexRunResult(testId = "test_secret_broker"): AgentRunResult {
  return {
    summary: "Fake Codex runner completed the secret broker task.",
    previewUrl: "http://fake-preview.local",
    riskLevel: "low",
    changedFiles: [],
    tests: [
      {
        id: testId,
        status: "passed",
        command: "fake test",
        summary: "fake test passed",
        durationMs: 10
      }
    ],
    reviewerSummary: "Fake reviewer approved the secret broker result.",
    runner: "codex"
  };
}

async function pollPrdRuns(app: Awaited<ReturnType<typeof buildServer>>, prdId: string, expectedCount: number) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const response = await app.inject({ method: "GET", url: "/api/snapshot" });
    const runs = response
      .json()
      .agentRuns.filter((run: { prdId: string }) => run.prdId === prdId);
    if (
      runs.length === expectedCount &&
      runs.every((run: { status: string }) => run.status === "succeeded" || run.status === "failed")
    ) {
      return runs;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Runs did not finish for PRD: ${prdId}`);
}

async function listenOnRandomPort(app: Awaited<ReturnType<typeof buildServer>>) {
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address() as AddressInfo | string | null;
  if (!address || typeof address === "string") throw new Error("Fastify did not bind to a TCP port");
  return `http://127.0.0.1:${address.port}`;
}

async function startSimulatedRun(app: Awaited<ReturnType<typeof buildServer>>, rawInput: string) {
  const create = await app.inject({
    method: "POST",
    url: "/api/requirements",
    payload: { rawInput, template: "feature" }
  });
  expect(create.statusCode).toBe(201);
  const requirement = create.json() as { id: string };

  const prdResponse = await app.inject({ method: "POST", url: `/api/requirements/${requirement.id}/prd` });
  expect(prdResponse.statusCode).toBe(200);
  const prd = prdResponse.json().prd as { id: string };

  const approval = await app.inject({ method: "POST", url: `/api/prds/${prd.id}/approve` });
  expect(approval.statusCode).toBe(200);
  const workItem = (approval.json().workItems as Array<{ id: string }>)[0];
  if (!workItem) throw new Error("Expected approved PRD to create at least one work item");

  const start = await app.inject({
    method: "POST",
    url: `/api/work-items/${workItem.id}/start`,
    payload: { runner: "simulated" }
  });
  expect(start.statusCode).toBe(201);
  return start.json() as AgentRun;
}

interface SseFrame {
  event: string;
  data: string;
  raw: string;
}

async function collectSseFrames(url: string, timeoutMs: number) {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    if (!response.body) throw new Error("SSE response did not expose a readable body");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const frames: SseFrame[] = [];
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let frameEnd = buffer.indexOf("\n\n");
      while (frameEnd >= 0) {
        const raw = buffer.slice(0, frameEnd);
        buffer = buffer.slice(frameEnd + 2);
        if (raw.trim()) frames.push(parseSseFrame(raw));
        frameEnd = buffer.indexOf("\n\n");
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) frames.push(parseSseFrame(buffer));
    return frames;
  } catch (error) {
    if (timedOut) throw new Error(`Timed out waiting for SSE stream to close: ${url}`, { cause: error });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function parseSseFrame(raw: string): SseFrame {
  let event = "message";
  const dataLines: string[] = [];

  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice("event:".length).trim();
    if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trimStart());
  }

  return { event, data: dataLines.join("\n"), raw };
}
