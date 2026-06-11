import { createHash } from "node:crypto";
import {
  type ArtifactKind,
  type ArtifactRecord,
  type AuditEvent,
  type PatchPilotSnapshot,
  verifyAuditChain
} from "@patchpilot/domain";
import { contractVersion } from "@patchpilot/contracts";
import { redactJsonValue, secretRedactionPolicyVersion } from "@patchpilot/security";

export const auditExportFormatVersion = "patchpilot.audit.prd.v1";
export const auditRetentionPolicyVersion = "td-308-retention-v1";
export const auditExportAuthEnforcement = "td_222_rbac_enforced";

export interface BuildPrdAuditExportPackageInput {
  snapshot: PatchPilotSnapshot;
  prdId: string;
  createdAt: string;
  actorType: string;
  actorId: string;
  exportAuditEventId: string;
}

export interface AuditExportPackage {
  manifest: {
    formatVersion: typeof auditExportFormatVersion;
    contractVersion: typeof contractVersion;
    createdAt: string;
    createdBy: {
      actorType: string;
      actorId: string;
      adminIntent: true;
      authEnforcement: typeof auditExportAuthEnforcement;
    };
    scope: {
      type: "prd";
      prdId: string;
      requirementId: string;
      filters: {
        includesLinkedWorkItems: true;
        includesLinkedRuns: true;
        includesLinkedApprovals: true;
        includesProjectAuditLedger: true;
      };
    };
    exportAuditEventId: string;
    counts: Record<string, number>;
    redaction: {
      redacted: true;
      finalPass: true;
      policyVersion: typeof secretRedactionPolicyVersion;
      piiMarkers: string[];
    };
    retention: AuditExportRetentionPolicy;
    integrity: {
      payloadSha256: string;
      auditEventJsonlSha256: string;
      artifactManifestSha256: string;
    };
  };
  verification: AuditExportVerification;
  records: AuditExportRecords;
  artifactManifest: AuditExportArtifactManifestEntry[];
  auditEvents: AuditEvent[];
  auditEventsJsonl: string;
  readme: string;
}

export interface AuditExportVerification {
  chainOrder: "oldest_to_newest";
  ledgerScope: "project_ledger_full";
  valid: boolean;
  checkedEvents: number;
  firstHash: string | null;
  headHash: string | null;
  errors: string[];
  scopeEventIds: string[];
  interleavedEventCount: number;
}

export interface AuditExportRetentionPolicy {
  policyVersion: typeof auditRetentionPolicyVersion;
  legalHold: false;
  worm: {
    enabled: false;
    mode: "metadata_only";
    semantics: string;
    futureStorage: "s3_object_lock_or_equivalent";
  };
  tiers: Array<{
    tier: "tier_0_audit_ledger" | "tier_1_product_evidence" | "tier_2_decision_artifacts" | "tier_3_raw_run_artifacts";
    defaultRetention: string;
    appliesTo: string[];
  }>;
}

export interface AuditExportArtifactManifestEntry {
  artifactId: string;
  kind: ArtifactKind;
  checksumSha256: string;
  sizeBytes: number;
  contentType: string;
  storage: ArtifactRecord["storage"];
  uri: string;
  retentionTier: AuditExportRetentionPolicy["tiers"][number]["tier"];
  redactionStatus: "redacted" | "not_marked" | "metadata_only";
  includedBytes: false;
  tombstone: false;
  createdAt: string;
  requirementId?: string;
  prdId?: string;
  workItemId?: string;
  runId?: string;
  testRunId?: string;
}

export interface AuditExportRecords {
  requirement: PatchPilotSnapshot["requirements"][number] | null;
  prd: PatchPilotSnapshot["prds"][number];
  workItems: PatchPilotSnapshot["workItems"];
  interfaceContracts: PatchPilotSnapshot["interfaceContracts"];
  agentRuns: PatchPilotSnapshot["agentRuns"];
  workspaceRuns: PatchPilotSnapshot["workspaceRuns"];
  testCases: PatchPilotSnapshot["testCases"];
  testRuns: PatchPilotSnapshot["testRuns"];
  artifacts: PatchPilotSnapshot["artifacts"];
  pullRequests: PatchPilotSnapshot["pullRequests"];
  reviewRecords: PatchPilotSnapshot["reviewRecords"];
  approvals: PatchPilotSnapshot["approvals"];
  bugs: PatchPilotSnapshot["bugs"];
  acceptances: PatchPilotSnapshot["acceptances"];
}

export function buildPrdAuditExportPackage(input: BuildPrdAuditExportPackageInput): AuditExportPackage {
  const snapshot = structuredClone(input.snapshot);
  const prd = snapshot.prds.find((item) => item.id === input.prdId);
  if (!prd) throw new Error(`PRD not found: ${input.prdId}`);

  const workItems = snapshot.workItems.filter((item) => item.prdId === prd.id);
  const workItemIds = new Set(workItems.map((item) => item.id));
  const runs = snapshot.agentRuns.filter((run) => run.prdId === prd.id || workItemIds.has(run.workItemId));
  const runIds = new Set(runs.map((run) => run.id));
  const testCases = snapshot.testCases.filter((testCase) => testCase.prdId === prd.id || workItemIds.has(testCase.workItemId));
  const testCaseIds = new Set(testCases.map((testCase) => testCase.id));
  const testRuns = snapshot.testRuns.filter((testRun) =>
    testRun.prdId === prd.id ||
    (testRun.workItemId ? workItemIds.has(testRun.workItemId) : false) ||
    (testRun.runId ? runIds.has(testRun.runId) : false) ||
    (testRun.testCaseId ? testCaseIds.has(testRun.testCaseId) : false)
  );
  const testRunIds = new Set(testRuns.map((testRun) => testRun.id));

  const records: AuditExportRecords = {
    requirement: snapshot.requirements.find((requirement) => requirement.id === prd.requirementId) ?? null,
    prd,
    workItems,
    interfaceContracts: snapshot.interfaceContracts.filter((contract) => contract.prdId === prd.id),
    agentRuns: runs,
    workspaceRuns: snapshot.workspaceRuns.filter((workspace) => workspace.prdId === prd.id || runIds.has(workspace.runId)),
    testCases,
    testRuns,
    artifacts: snapshot.artifacts.filter((artifact) =>
      artifact.prdId === prd.id ||
      (artifact.workItemId ? workItemIds.has(artifact.workItemId) : false) ||
      (artifact.runId ? runIds.has(artifact.runId) : false) ||
      (artifact.testRunId ? testRunIds.has(artifact.testRunId) : false)
    ),
    pullRequests: snapshot.pullRequests.filter((pullRequest) => pullRequest.prdId === prd.id || runIds.has(pullRequest.runId)),
    reviewRecords: snapshot.reviewRecords.filter((review) => review.prdId === prd.id || runIds.has(review.runId)),
    approvals: snapshot.approvals.filter((approval) =>
      approval.prdId === prd.id ||
      (approval.workItemId ? workItemIds.has(approval.workItemId) : false) ||
      (approval.runId ? runIds.has(approval.runId) : false)
    ),
    bugs: snapshot.bugs.filter((bug) => bug.prdId === prd.id || workItemIds.has(bug.workItemId)),
    acceptances: snapshot.acceptances.filter((acceptance) => runIds.has(acceptance.runId))
  };

  const scopeEventIds = new Set(
    snapshot.auditEvents
      .filter((event) => auditEventMatchesScope(event, prd.id, prd.requirementId, workItemIds, runIds, testRunIds))
      .map((event) => event.id)
  );
  const auditEventsNewestFirst = [...snapshot.auditEvents];
  const auditEvents = [...auditEventsNewestFirst].reverse();
  const chain = verifyAuditChain(auditEventsNewestFirst);
  const verification: AuditExportVerification = {
    chainOrder: "oldest_to_newest",
    ledgerScope: "project_ledger_full",
    valid: chain.valid,
    checkedEvents: chain.checkedEvents,
    firstHash: auditEvents[0]?.hash ?? null,
    headHash: chain.headHash,
    errors: chain.errors,
    scopeEventIds: auditEvents.filter((event) => scopeEventIds.has(event.id)).map((event) => event.id),
    interleavedEventCount: auditEvents.filter((event) => !scopeEventIds.has(event.id)).length
  };
  const artifactManifest = records.artifacts.map(toArtifactManifestEntry);
  const retention = retentionPolicy();
  const counts = {
    requirements: records.requirement ? 1 : 0,
    prds: 1,
    workItems: records.workItems.length,
    interfaceContracts: records.interfaceContracts.length,
    agentRuns: records.agentRuns.length,
    workspaceRuns: records.workspaceRuns.length,
    testCases: records.testCases.length,
    testRuns: records.testRuns.length,
    artifacts: records.artifacts.length,
    pullRequests: records.pullRequests.length,
    reviewRecords: records.reviewRecords.length,
    approvals: records.approvals.length,
    bugs: records.bugs.length,
    acceptances: records.acceptances.length,
    auditEvents: auditEvents.length,
    scopedAuditEvents: scopeEventIds.size
  };

  const redactedBody = redactJsonValue({
    verification,
    records,
    artifactManifest,
    auditEvents,
    readme: exportReadme()
  });
  const auditEventsJsonl = `${redactedBody.auditEvents.map((event) => JSON.stringify(event)).join("\n")}\n`;
  const packageWithoutIntegrity = {
    manifest: {
      formatVersion: auditExportFormatVersion as typeof auditExportFormatVersion,
      contractVersion: contractVersion as typeof contractVersion,
      createdAt: input.createdAt,
      createdBy: {
        actorType: input.actorType,
        actorId: input.actorId,
        adminIntent: true as const,
        authEnforcement: auditExportAuthEnforcement as typeof auditExportAuthEnforcement
      },
      scope: {
        type: "prd" as const,
        prdId: prd.id,
        requirementId: prd.requirementId,
        filters: {
          includesLinkedWorkItems: true as const,
          includesLinkedRuns: true as const,
          includesLinkedApprovals: true as const,
          includesProjectAuditLedger: true as const
        }
      },
      exportAuditEventId: input.exportAuditEventId,
      counts,
      redaction: {
        redacted: true as const,
        finalPass: true as const,
        policyVersion: secretRedactionPolicyVersion as typeof secretRedactionPolicyVersion,
        piiMarkers: ["[REDACTED:email]", "[REDACTED:phone]", "[REDACTED:account-id]"]
      },
      retention,
      integrity: {
        payloadSha256: "",
        auditEventJsonlSha256: sha256(auditEventsJsonl),
        artifactManifestSha256: sha256(stableStringify(redactedBody.artifactManifest))
      }
    },
    ...redactedBody,
    auditEventsJsonl
  };
  const payloadSha256 = sha256(stableStringify({
    ...packageWithoutIntegrity,
    manifest: {
      ...packageWithoutIntegrity.manifest,
      integrity: {
        ...packageWithoutIntegrity.manifest.integrity,
        payloadSha256: ""
      }
    }
  }));

  return {
    ...packageWithoutIntegrity,
    manifest: {
      ...packageWithoutIntegrity.manifest,
      integrity: {
        ...packageWithoutIntegrity.manifest.integrity,
        payloadSha256
      }
    }
  };
}

function auditEventMatchesScope(
  event: AuditEvent,
  prdId: string,
  requirementId: string,
  workItemIds: Set<string>,
  runIds: Set<string>,
  testRunIds: Set<string>
) {
  return event.prdId === prdId ||
    event.requirementId === requirementId ||
    (event.workItemId ? workItemIds.has(event.workItemId) : false) ||
    (event.runId ? runIds.has(event.runId) : false) ||
    (event.targetType === "test_run" && testRunIds.has(event.targetId));
}

function toArtifactManifestEntry(artifact: ArtifactRecord): AuditExportArtifactManifestEntry {
  return {
    artifactId: artifact.id,
    kind: artifact.kind,
    checksumSha256: artifact.checksumSha256,
    sizeBytes: artifact.sizeBytes,
    contentType: artifact.contentType,
    storage: artifact.storage,
    uri: artifact.uri,
    retentionTier: retentionTierForArtifact(artifact.kind),
    redactionStatus: artifact.metadata?.redactionStatus === "redacted" ? "redacted" : "metadata_only",
    includedBytes: false,
    tombstone: false,
    createdAt: artifact.createdAt,
    ...(artifact.requirementId ? { requirementId: artifact.requirementId } : {}),
    ...(artifact.prdId ? { prdId: artifact.prdId } : {}),
    ...(artifact.workItemId ? { workItemId: artifact.workItemId } : {}),
    ...(artifact.runId ? { runId: artifact.runId } : {}),
    ...(artifact.testRunId ? { testRunId: artifact.testRunId } : {})
  };
}

function retentionTierForArtifact(kind: ArtifactKind): AuditExportArtifactManifestEntry["retentionTier"] {
  if (kind === "log" || kind === "trace") return "tier_3_raw_run_artifacts";
  return "tier_2_decision_artifacts";
}

function retentionPolicy(): AuditExportRetentionPolicy {
  return {
    policyVersion: auditRetentionPolicyVersion,
    legalHold: false,
    worm: {
      enabled: false,
      mode: "metadata_only",
      semantics: "The exported ledger is append-only by audit hash chain and payload checksums; production WORM storage can persist this package unchanged.",
      futureStorage: "s3_object_lock_or_equivalent"
    },
    tiers: [
      {
        tier: "tier_0_audit_ledger",
        defaultRetention: "project_life_plus_contractual_audit_period",
        appliesTo: ["auditEvents", "verification", "exportAuditEventId"]
      },
      {
        tier: "tier_1_product_evidence",
        defaultRetention: "minimum_1_year_after_final_acceptance_or_cancellation",
        appliesTo: ["agentRuns", "workspaceRuns", "testRuns", "pullRequests", "reviewRecords", "acceptances"]
      },
      {
        tier: "tier_2_decision_artifacts",
        defaultRetention: "minimum_1_year_after_final_acceptance_or_cancellation",
        appliesTo: ["diff", "test_report", "preview_metadata", "screenshot", "intake_attachment"]
      },
      {
        tier: "tier_3_raw_run_artifacts",
        defaultRetention: "90_days_after_terminal_agent_run_by_default",
        appliesTo: ["log", "trace"]
      }
    ]
  };
}

function exportReadme() {
  return [
    "# PatchPilot PRD Audit Export",
    "",
    "This package is redacted and scoped to one PRD, with the full project audit ledger included so the hash chain can be verified offline.",
    "",
    "Verification steps:",
    "1. Parse auditEventsJsonl from oldest to newest.",
    "2. Recompute each event hash with the PatchPilot canonical AuditEvent hash algorithm.",
    "3. Confirm each previousHash links to the prior event hash and that the final hash matches manifest.verification.headHash.",
    "4. Compare artifact metadata checksums against retained artifact bytes when those bytes are available."
  ].join("\n");
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortJsonValue(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJsonValue(item)])
  );
}
