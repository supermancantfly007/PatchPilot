export type RequirementTemplate = "feature" | "bug" | "ui" | "document";

export type RequirementStatus =
  | "submitted"
  | "clarifying"
  | "prd_draft"
  | "approved"
  | "rejected";

export type WorkItemStatus =
  | "proposed"
  | "ready"
  | "claimed"
  | "running"
  | "review"
  | "blocked"
  | "done"
  | "cancelled";

export type AgentRunStatus =
  | "queued"
  | "running"
  | "needs_approval"
  | "succeeded"
  | "failed"
  | "cancelled";

export type TestRunStatus = "queued" | "running" | "passed" | "failed" | "blocked" | "skipped";

export type TestCaseStatus = "draft" | "ready" | "passed" | "failed" | "blocked";

export type TestCaseKind = "acceptance" | "regression" | "contract" | "smoke";

export type WorkspaceRunStatus = "preparing" | "ready" | "active" | "archived" | "failed" | "destroyed";

export type PullRequestStatus = "draft" | "ready_for_review" | "changes_requested" | "approved" | "merged" | "closed";

export type ReviewStatus = "approved" | "changes_requested" | "blocked";

export type AcceptanceStatus = "pending" | "accepted" | "rejected";

export type TimelineStepKey = "understanding" | "planning" | "developing" | "testing" | "confirming";

export type AgentRunnerKind = "simulated" | "codex";

export type AgentRole = "product" | "frontend" | "backend" | "test" | "ops" | "reviewer";

export type AgentStatus = "idle" | "busy" | "offline";

export type BugSeverity = "low" | "medium" | "high" | "critical";

export type BugStatus =
  | "reported"
  | "needs_repro"
  | "reproduced"
  | "unreproducible"
  | "fixing"
  | "verifying"
  | "closed";

export type FailureType =
  | "transient"
  | "deterministic"
  | "test_failed"
  | "policy_denied"
  | "budget_exhausted"
  | "environment_failed";

export type ArtifactKind = "log" | "trace" | "diff" | "test_report" | "screenshot" | "preview_metadata";

export type ArtifactStorageProvider = "local_fs" | "s3";

export type InterfaceContractKind = "http" | "event" | "schema";

export type InterfaceContractStatus = "draft" | "approved" | "breaking_change_pending" | "deprecated";

export type ApprovalKind =
  | "prd_approval"
  | "budget_exceeded"
  | "dangerous_operation"
  | "breaking_contract"
  | "network_allowlist_change"
  | "secret_grant"
  | "production_data_access";

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

export type ApprovalRiskLevel = "low" | "medium" | "high" | "critical";

export type ApprovalTargetType =
  | "prd"
  | "work_item"
  | "agent_run"
  | "interface_contract"
  | "budget"
  | "policy"
  | "secret"
  | "network"
  | "repository";

export interface TimelineStep {
  key: TimelineStepKey;
  label: string;
  status: "waiting" | "active" | "done" | "failed";
  detail: string;
}

export interface Requirement {
  id: string;
  title: string;
  rawInput: string;
  template: RequirementTemplate;
  status: RequirementStatus;
  simpleSummary: string;
  clarificationQuestions: ClarificationQuestion[];
  clarificationTurns: ClarificationTurn[];
  createdAt: string;
  updatedAt: string;
}

export interface ClarificationQuestion {
  id: string;
  question: string;
  recommendedAnswer: string;
  answer?: string;
}

export interface ClarificationTurn {
  id: string;
  speaker: "agent" | "user";
  message: string;
  recommendedAnswer?: string;
  createdAt: string;
}

export interface Prd {
  id: string;
  requirementId: string;
  version: number;
  status: "draft" | "approved";
  title: string;
  bodyMarkdown: string;
  acceptanceCriteria: string[];
  budgetUsd?: number;
  approvedAt?: string;
}

export interface WorkItem {
  id: string;
  prdId: string;
  title: string;
  status: WorkItemStatus;
  role: AgentRole;
  scope: string;
  nonGoals: string[];
  acceptanceCriteria: string[];
  testSuggestions: string[];
  dependsOn?: string[];
  requiredCapabilities?: string[];
  budgetUsd?: number;
  concurrencyKey?: string;
  maxConcurrent?: number;
  assignedAgentId?: string;
  claimedAt?: string;
  claimToken?: string;
  leaseExpiresAt?: string;
  heartbeatAt?: string;
  version?: number;
  sourceBugId?: string;
  reworkCount?: number;
  lastRejectionReason?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface InterfaceContract {
  id: string;
  prdId: string;
  name: string;
  kind: InterfaceContractKind;
  status: InterfaceContractStatus;
  version: number;
  summary: string;
  providerRole: AgentRole;
  consumerRoles: AgentRole[];
  specMarkdown: string;
  testSuggestions: string[];
  createdAt: string;
  updatedAt: string;
}

export interface AgentProfile {
  id: string;
  name: string;
  role: AgentRole;
  status: AgentStatus;
  currentWorkItemId?: string;
  capabilities?: string[];
  lastSeenAt: string;
}

export interface BugReport {
  id: string;
  title: string;
  description: string;
  reproductionSteps: string;
  expectedBehavior: string;
  actualBehavior: string;
  severity: BugSeverity;
  status: BugStatus;
  reporter: string;
  requirementId: string;
  prdId: string;
  workItemId: string;
  sourceRunId?: string;
  sourceTestRunId?: string;
  sourceFailureType?: FailureType;
  sourceCommit?: string;
  sourceBranch?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRun {
  id: string;
  requirementId: string;
  prdId: string;
  workItemId: string;
  runner: AgentRunnerKind;
  status: AgentRunStatus;
  currentStep: TimelineStepKey;
  timeline: TimelineStep[];
  events: AgentRunEvent[];
  result?: AgentRunResult;
  failureType?: FailureType;
  failureSummary?: string;
  budgetUsd?: number;
  budgetSoftThresholdUsd?: number;
  budgetApprovalId?: string;
  costEstimateUsd: number;
  costActualUsd?: number;
  artifactIds?: string[];
  startedAt: string;
  endedAt?: string;
}

export interface AgentRunEvent {
  id: string;
  at: string;
  type:
    | "requirement.understood"
    | "plan.created"
    | "workspace.created"
    | "codex.started"
    | "codex.output"
    | "git.diff.created"
    | "agent.progress"
    | "test.started"
    | "test.passed"
    | "test.failed"
    | "review.completed"
    | "acceptance.waiting"
    | "run.failed";
  message: string;
}

export interface AgentRunResult {
  summary: string;
  previewUrl: string;
  riskLevel: "low" | "medium" | "high";
  changedFiles: string[];
  tests: TestRun[];
  reviewerSummary: string;
  runner: AgentRunnerKind;
  agentMessages?: string[];
  reasoningSummaries?: string[];
  toolCalls?: AgentRunToolCall[];
  diffSummary?: AgentRunDiffSummary;
  testOutputSummary?: string;
  workspacePath?: string;
  branchName?: string;
  baseBranch?: string;
  baseCommit?: string;
  headCommit?: string;
  codexSessionId?: string;
  artifactIds?: string[];
}

export type AgentRunToolCallStatus = "started" | "completed" | "failed" | "unknown";

export interface AgentRunToolCall {
  id: string;
  name: string;
  status: AgentRunToolCallStatus;
  summary: string;
  command?: string;
  exitCode?: number | null;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
}

export interface AgentRunDiffSummary {
  changedFileCount: number;
  changedFiles: string[];
  hasChanges: boolean;
  branchName?: string;
  baseBranch?: string;
  baseCommit?: string;
  headCommit?: string;
}

export interface RuntimeConfig {
  configuredRunner: "auto" | AgentRunnerKind;
  activeRunner: AgentRunnerKind;
  codexAvailable: boolean;
  gitWorkspaceAvailable: boolean;
  testCommand: string;
  workspaceRoot: string;
  previewUrl: string;
  configSource: "defaults" | "file";
  configPath?: string;
  setup: {
    commands: string[];
  };
  test: {
    command: string;
    timeoutMs: number;
    maxRepairAttempts: number;
  };
  smoke: {
    command: string;
    timeoutMs: number;
    previewUrl: string;
  };
  e2e: {
    command: string;
    timeoutMs: number;
    baseUrl: string;
  };
  dev: {
    runner: "auto" | AgentRunnerKind;
    simulationDelayFactor: number;
    workspaceRoot: string;
    previewUrl: string;
  };
  security: {
    codexSandbox: string;
    codexBypass: boolean;
  };
  budget: {
    codexTimeoutMs: number;
    maxCostUsd: number;
    prdUsd: number;
    workItemUsd: number;
    runUsd: number;
    softThresholdRatio: number;
  };
  artifacts: {
    provider: ArtifactStorageProvider;
    localRoot?: string;
    s3?: {
      endpoint?: string;
      region: string;
      bucket: string;
      forcePathStyle: boolean;
      prefix: string;
    };
  };
}

export interface TestRun {
  id: string;
  testCaseId?: string;
  runId?: string;
  prdId?: string;
  workItemId?: string;
  status: TestRunStatus;
  command: string;
  summary: string;
  durationMs: number;
  startedAt?: string;
  endedAt?: string;
  commit?: string;
  branch?: string;
  pullRequestId?: string;
  workspacePath?: string;
  runner?: string;
  environmentImage?: string;
  exitCode?: number | null;
  failureSummary?: string;
  logArtifactId?: string;
  artifactIds?: string[];
  retryCount?: number;
  attempt?: number;
  maxAttempts?: number;
  flakySignal?: boolean;
}

export interface TestCase {
  id: string;
  requirementId: string;
  prdId: string;
  workItemId: string;
  sourceBugId?: string;
  title: string;
  kind: TestCaseKind;
  status: TestCaseStatus;
  priority: "low" | "medium" | "high";
  steps: string[];
  expectedResult: string;
  linkedAcceptanceCriteria: string[];
  lastRunId?: string;
  lastTestRunId?: string;
  flaky?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceRun {
  id: string;
  runId: string;
  requirementId: string;
  prdId: string;
  workItemId: string;
  runner: AgentRunnerKind;
  status: WorkspaceRunStatus;
  isolation: "simulated" | "git_worktree";
  path: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface ArtifactRecord {
  id: string;
  kind: ArtifactKind;
  storage: ArtifactStorageProvider;
  uri: string;
  contentType: string;
  sizeBytes: number;
  checksumSha256: string;
  metadata?: Record<string, string>;
  requirementId?: string;
  prdId?: string;
  workItemId?: string;
  runId?: string;
  testRunId?: string;
  createdAt: string;
}

export interface AuditEvent {
  id: string;
  traceId: string;
  actor: string;
  action: string;
  targetType:
    | "requirement"
    | "prd"
    | "work_item"
    | "agent_run"
    | "workspace_run"
    | "test_case"
    | "test_run"
    | "pull_request"
    | "review_record"
    | "bug"
    | "acceptance"
    | "approval";
  targetId: string;
  message: string;
  requirementId?: string;
  prdId?: string;
  workItemId?: string;
  runId?: string;
  createdAt: string;
}

export interface ApprovalRecord {
  id: string;
  kind: ApprovalKind;
  status: ApprovalStatus;
  targetType: ApprovalTargetType;
  targetId: string;
  requestedBy: string;
  requestedReason: string;
  riskLevel: ApprovalRiskLevel;
  expiresAt: string;
  approvedBy?: string;
  deniedBy?: string;
  decisionReason?: string;
  decidedAt?: string;
  requirementId?: string;
  prdId?: string;
  workItemId?: string;
  runId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PullRequestRecord {
  id: string;
  provider: "local" | "github";
  status: PullRequestStatus;
  title: string;
  requirementId: string;
  prdId: string;
  workItemId: string;
  runId: string;
  branchName: string;
  baseBranch: string;
  baseCommit?: string;
  headCommit?: string;
  url: string;
  bodyMarkdown: string;
  reviewerSummary: string;
  testSummary: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewRecord {
  id: string;
  status: ReviewStatus;
  requirementId: string;
  prdId: string;
  workItemId: string;
  runId: string;
  linkedPullRequestId: string;
  reviewerAgentId: string;
  summary: string;
  testSummary: string;
  riskLevel: AgentRunResult["riskLevel"];
  findings: string[];
  createdAt: string;
  updatedAt: string;
}

export interface AcceptanceDecision {
  runId: string;
  status: AcceptanceStatus;
  reason?: string;
  decidedAt?: string;
}

export interface PatchPilotSnapshot {
  requirements: Requirement[];
  prds: Prd[];
  workItems: WorkItem[];
  interfaceContracts: InterfaceContract[];
  agentRuns: AgentRun[];
  workspaceRuns: WorkspaceRun[];
  testCases: TestCase[];
  testRuns: TestRun[];
  artifacts: ArtifactRecord[];
  pullRequests: PullRequestRecord[];
  reviewRecords: ReviewRecord[];
  auditEvents: AuditEvent[];
  acceptances: AcceptanceDecision[];
  approvals: ApprovalRecord[];
  bugs: BugReport[];
  agents: AgentProfile[];
}

export const emptySnapshot = (): PatchPilotSnapshot => ({
  requirements: [],
  prds: [],
  workItems: [],
  interfaceContracts: [],
  agentRuns: [],
  workspaceRuns: [],
  testCases: [],
  testRuns: [],
  artifacts: [],
  pullRequests: [],
  reviewRecords: [],
  auditEvents: [],
  acceptances: [],
  approvals: [],
  bugs: [],
  agents: createDefaultAgents(new Date().toISOString())
});

export function createDefaultAgents(now: string): AgentProfile[] {
  return [
    { id: "agent_product", name: "产品 Agent", role: "product", status: "idle", lastSeenAt: now },
    { id: "agent_frontend", name: "前端 Agent", role: "frontend", status: "idle", lastSeenAt: now },
    { id: "agent_backend", name: "后端 Agent", role: "backend", status: "idle", lastSeenAt: now },
    { id: "agent_test", name: "测试 Agent", role: "test", status: "idle", lastSeenAt: now },
    { id: "agent_ops", name: "运维 Agent", role: "ops", status: "idle", lastSeenAt: now },
    { id: "agent_reviewer", name: "Reviewer Agent", role: "reviewer", status: "idle", lastSeenAt: now }
  ];
}

export function createTimeline(): TimelineStep[] {
  return [
    {
      key: "understanding",
      label: "理解中",
      status: "active",
      detail: "正在把你的输入整理成清晰需求"
    },
    { key: "planning", label: "计划中", status: "waiting", detail: "等待生成任务和验收标准" },
    { key: "developing", label: "开发中", status: "waiting", detail: "等待 agent 执行代码变更" },
    { key: "testing", label: "测试中", status: "waiting", detail: "等待运行目标测试和审查" },
    { key: "confirming", label: "等待确认", status: "waiting", detail: "等待你验收结果" }
  ];
}

export function advanceTimeline(timeline: TimelineStep[], current: TimelineStepKey): TimelineStep[] {
  const order: TimelineStepKey[] = ["understanding", "planning", "developing", "testing", "confirming"];
  const currentIndex = order.indexOf(current);

  return timeline.map((step) => {
    const index = order.indexOf(step.key);
    if (index < currentIndex) return { ...step, status: "done" };
    if (index === currentIndex) return { ...step, status: "active" };
    return { ...step, status: "waiting" };
  });
}

export function completeTimeline(timeline: TimelineStep[]): TimelineStep[] {
  return timeline.map((step) => ({ ...step, status: "done" }));
}

export function generateClarificationQuestions(input: string, template: RequirementTemplate): ClarificationQuestion[] {
  const base = input.trim().slice(0, 80) || "这个需求";
  const questionsByTemplate: Record<RequirementTemplate, ClarificationQuestion[]> = {
    feature: [
      {
        id: "goal",
        question: "这个功能最重要的成功标准是什么？",
        recommendedAnswer: `用户能顺利完成「${base}」并看到明确结果`
      },
      {
        id: "scope",
        question: "第一版有没有明确不做的内容？",
        recommendedAnswer: "先做最小可用闭环，复杂配置和边缘场景延后"
      },
      {
        id: "acceptance",
        question: "你希望怎么确认它完成了？",
        recommendedAnswer: "页面可操作、关键测试通过，并展示变更摘要"
      }
    ],
    bug: [
      {
        id: "repro",
        question: "这个问题稳定复现的步骤是什么？",
        recommendedAnswer: "使用你提供的报错、截图或描述生成最小复现"
      },
      {
        id: "expected",
        question: "正确行为应该是什么？",
        recommendedAnswer: "不再出现该错误，并保留原有正常流程"
      },
      {
        id: "proof",
        question: "修好后你希望看到什么证明？",
        recommendedAnswer: "复现用例失败转通过，并给出测试结果"
      }
    ],
    ui: [
      {
        id: "surface",
        question: "主要想改善哪个页面或区域？",
        recommendedAnswer: "优先改善用户第一眼看到和最常点击的区域"
      },
      {
        id: "style",
        question: "你希望视觉风格更接近什么？",
        recommendedAnswer: "白色底、清爽、专业、按钮和状态清晰"
      },
      {
        id: "acceptance",
        question: "怎么判断这次 UI 改动成功？",
        recommendedAnswer: "移动端和桌面端不拥挤，核心操作一眼可见"
      }
    ],
    document: [
      {
        id: "priority",
        question: "文档里最应该先落地的是哪一部分？",
        recommendedAnswer: "先落地能形成可演示闭环的核心流程"
      },
      {
        id: "constraints",
        question: "有没有必须遵守的技术或业务限制？",
        recommendedAnswer: "保持现有技术栈，避免高风险生产操作"
      },
      {
        id: "acceptance",
        question: "完成后谁来验收，验收什么？",
        recommendedAnswer: "需求提交者验收核心行为，技术负责人看测试和风险"
      }
    ]
  };

  return questionsByTemplate[template];
}

export function createInitialClarificationTurn(
  input: string,
  template: RequirementTemplate,
  now: string
): ClarificationTurn {
  const question = createGrillMeQuestion(input, template, []);
  return {
    id: `turn_${now.replace(/\W/g, "")}_agent_0`,
    speaker: "agent",
    message: question.question,
    recommendedAnswer: question.recommendedAnswer,
    createdAt: now
  };
}

export function createGrillMeQuestion(
  input: string,
  template: RequirementTemplate,
  turns: ClarificationTurn[]
): ClarificationQuestion {
  const answers = turns.filter((turn) => turn.speaker === "user");
  const base = input.trim().slice(0, 90) || "这个需求";
  const primaryOutcome: ClarificationQuestion = {
    id: "primary_outcome",
    question: "这次最重要的用户可见结果是什么？",
    recommendedAnswer: `用户能完成「${base}」并看到明确的成功反馈`
  };
  const users: ClarificationQuestion = {
    id: "users",
    question: "第一版主要给谁用？他们在什么场景下打开它？",
    recommendedAnswer: "先服务普通需求提交者，让他们不用理解工程细节也能启动和验收 agent 工作"
  };
  const boundaries: ClarificationQuestion = {
    id: "boundaries",
    question: "哪些事情第一版明确不做，避免 agent 误解范围？",
    recommendedAnswer: "不自动合并、不自动发布、不访问生产密钥或生产数据"
  };
  const acceptanceSignal: ClarificationQuestion = {
    id: "acceptance_signal",
    question: "你验收时最想看到哪几类证据？",
    recommendedAnswer: "需求摘要、执行过程、变更范围、测试结果、风险提示和可点击验收入口"
  };
  const failureHandling: ClarificationQuestion = {
    id: "failure_handling",
    question: "如果 agent 做失败了，用户应该看到什么、下一步能做什么？",
    recommendedAnswer: "展示失败摘要、失败阶段、可复现日志，并允许重新提交或转成 bug 单"
  };
  const common: ClarificationQuestion[] = [
    primaryOutcome,
    users,
    boundaries,
    acceptanceSignal,
    failureHandling
  ];

  const byTemplate: Record<RequirementTemplate, ClarificationQuestion[]> = {
    feature: common,
    ui: [
      primaryOutcome,
      {
        id: "visual_style",
        question: "这个界面应当给用户什么第一印象？",
        recommendedAnswer: "白色底、清爽、按钮明确、状态清晰，普通用户不需要读说明也能继续"
      },
      {
        id: "critical_path",
        question: "页面上最核心的一条操作路径是什么？",
        recommendedAnswer: "输入需求 -> 逐轮澄清 -> 确认 PRD -> 启动 agent -> 查看证据 -> 验收"
      },
      boundaries,
      acceptanceSignal
    ],
    bug: [
      {
        id: "repro_loop",
        question: "这个 bug 最稳定的复现步骤是什么？",
        recommendedAnswer: "写出从打开页面/调用接口到看到错误的每一步，包含输入数据和实际错误"
      },
      {
        id: "expected_vs_actual",
        question: "正确行为和现在的错误行为分别是什么？",
        recommendedAnswer: "正确行为是流程继续并展示成功反馈；错误行为是当前失败现象稳定出现"
      },
      {
        id: "regression_signal",
        question: "修复后用什么反馈循环证明 bug 不再复现？",
        recommendedAnswer: "先加一个失败的集成测试或 E2E smoke，再修复到测试通过"
      },
      boundaries,
      acceptanceSignal
    ],
    document: [
      {
        id: "source_priority",
        question: "文档中哪一段必须先变成可运行能力？",
        recommendedAnswer: "先落地能从需求输入走到验收结果的核心闭环"
      },
      primaryOutcome,
      users,
      boundaries,
      acceptanceSignal
    ]
  };

  const plan = byTemplate[template];
  const next = plan[answers.length];
  if (next) return next;

  return {
    id: `follow_up_${answers.length + 1}`,
    question: "还有没有一个必须补充的边界、反例或验收细节？如果没有，就可以生成 PRD。",
    recommendedAnswer: "没有更多补充，可以基于当前澄清记录生成 PRD"
  };
}

export function makeSimpleSummary(input: string, template: RequirementTemplate): string {
  const label: Record<RequirementTemplate, string> = {
    feature: "新功能",
    bug: "Bug 修复",
    ui: "界面改进",
    document: "需求文档落地"
  };
  const normalized = input.trim() || "未命名需求";
  return `${label[template]}：${normalized}`;
}

export function createPrd(requirement: Requirement): Prd {
  const title = requirement.simpleSummary;
  const clarificationSummary =
    requirement.clarificationTurns.length > 0
      ? requirement.clarificationTurns
          .map((turn) => `- ${turn.speaker === "agent" ? "平台" : "用户"}：${turn.message}`)
          .join("\n")
      : "- 尚无澄清记录";
  const acceptanceCriteria = [
    "用户能在普通模式下理解本次变更的目标和结果",
    "平台生成的工作项包含范围、非目标、验收标准和测试建议",
    "执行结果包含变更摘要、测试结果、风险等级和验收入口"
  ];

  return {
    id: `prd_${requirement.id}`,
    requirementId: requirement.id,
    version: 1,
    status: "draft",
    title,
    acceptanceCriteria,
    bodyMarkdown: [
      `# ${title}`,
      "",
      "## 要做什么",
      requirement.rawInput,
      "",
      "## 澄清记录",
      clarificationSummary,
      "",
      "## 不做什么",
      "- 不自动合并到主分支",
      "- 不访问生产密钥或生产数据",
      "- 不展开超出本次描述的复杂企业配置",
      "",
      "## 如何验收",
      ...acceptanceCriteria.map((criterion) => `- ${criterion}`)
    ].join("\n")
  };
}

export function createWorkItems(prd: Prd): WorkItem[] {
  const now = new Date().toISOString();
  return [
    {
      id: `wi_${prd.requirementId}_backend`,
      prdId: prd.id,
      title: "后端交付控制面",
      status: "ready",
      role: "backend",
      scope: "实现需求、PRD、工作项、agent run、测试证据和验收决策所需的 API 与状态流转。",
      nonGoals: ["不自动合并", "不执行生产发布", "不访问生产密钥"],
      acceptanceCriteria: prd.acceptanceCriteria,
      testSuggestions: ["运行 API 生命周期测试", "验证重复启动和非法状态会被拒绝", "确认事件流能到达终态"],
      version: 1,
      createdAt: now,
      updatedAt: now
    },
    {
      id: `wi_${prd.requirementId}_frontend`,
      prdId: prd.id,
      title: "前端普通用户闭环",
      status: "ready",
      role: "frontend",
      scope: "实现白底极简工作台、逐轮澄清、订单式进度、证据摘要和验收入口。",
      nonGoals: ["不做营销落地页", "不暴露不必要工程术语", "不阻塞移动端关键动作"],
      acceptanceCriteria: prd.acceptanceCriteria,
      testSuggestions: ["运行 Web 组件测试", "跑浏览器 smoke", "检查桌面和移动端无明显溢出"],
      version: 1,
      createdAt: now,
      updatedAt: now
    },
    {
      id: `wi_${prd.requirementId}_test`,
      prdId: prd.id,
      title: "测试与回归证据",
      status: "ready",
      role: "test",
      scope: "把验收标准转为单元、API 或浏览器 smoke 测试，并整理失败返工证据。",
      nonGoals: ["不追求无关全量覆盖", "不把不稳定测试当作通过证据", "不跳过关键路径测试"],
      acceptanceCriteria: prd.acceptanceCriteria,
      testSuggestions: ["新增或更新关键路径测试", "确认失败能转为可处理缺陷", "记录测试命令和结果"],
      version: 1,
      createdAt: now,
      updatedAt: now
    },
    {
      id: `wi_${prd.requirementId}_ops`,
      prdId: prd.id,
      title: "本地运行与交付运维",
      status: "ready",
      role: "ops",
      scope: "补齐本地启动、环境变量、端口、中间件和 runner 模式说明，让团队能一键跑通。",
      nonGoals: ["不做生产 Kubernetes 部署", "不引入强制云服务", "不自动发布"],
      acceptanceCriteria: prd.acceptanceCriteria,
      testSuggestions: ["验证 dev 脚本", "检查端口和 env 文档", "确认可选 Docker 中间件不影响本地模拟闭环"],
      version: 1,
      createdAt: now,
      updatedAt: now
    }
  ];
}

export function createTestCasesForWorkItems(
  prd: Prd,
  workItems: WorkItem[],
  now = new Date().toISOString()
): TestCase[] {
  return workItems.map((workItem) => ({
    id: `tc_${workItem.id}`,
    requirementId: prd.requirementId,
    prdId: prd.id,
    workItemId: workItem.id,
    sourceBugId: workItem.sourceBugId,
    title: testCaseTitle(workItem),
    kind: testCaseKind(workItem),
    status: "ready",
    priority: workItem.sourceBugId ? "high" : "medium",
    steps:
      workItem.testSuggestions.length > 0
        ? workItem.testSuggestions
        : ["根据工作项范围执行目标验证", "记录测试命令、结果和风险"],
    expectedResult: workItem.acceptanceCriteria[0] || "工作项验收标准通过，并留下可审查测试证据。",
    linkedAcceptanceCriteria: workItem.acceptanceCriteria,
    createdAt: now,
    updatedAt: now
  }));
}

export function testCaseStatusFromTestRunStatus(status: TestRunStatus): TestCaseStatus {
  if (status === "passed") return "passed";
  if (status === "failed") return "failed";
  if (status === "blocked" || status === "skipped") return "blocked";
  return "ready";
}

function testCaseTitle(workItem: WorkItem) {
  if (workItem.sourceBugId && workItem.role === "test") return `复现用例：${workItem.title}`;
  if (workItem.sourceBugId) return `回归用例：${workItem.title}`;
  return `验收用例：${workItem.title}`;
}

function testCaseKind(workItem: WorkItem): TestCaseKind {
  if (workItem.sourceBugId) return "regression";
  if (workItem.role === "frontend" || workItem.role === "ops") return "smoke";
  if (workItem.role === "backend") return "contract";
  return "acceptance";
}

export function createBugRequirement(input: {
  id: string;
  title: string;
  description: string;
  reproductionSteps: string;
  expectedBehavior: string;
  actualBehavior: string;
  now: string;
}): Requirement {
  const rawInput = [
    input.description,
    "",
    "复现步骤：",
    input.reproductionSteps,
    "",
    "期望行为：",
    input.expectedBehavior,
    "",
    "实际行为：",
    input.actualBehavior
  ].join("\n");

  return {
    id: input.id,
    title: `Bug 修复：${input.title}`,
    rawInput,
    template: "bug",
    status: "approved",
    simpleSummary: `Bug 修复：${input.title}`,
    clarificationQuestions: generateClarificationQuestions(rawInput, "bug").map((question) => ({
      ...question,
      answer: question.recommendedAnswer
    })),
    clarificationTurns: [
      createInitialClarificationTurn(rawInput, "bug", input.now),
      {
        id: `turn_${input.now.replace(/\W/g, "")}_user_0`,
        speaker: "user",
        message: "已按 bug 表单提交复现步骤、期望行为和实际行为。",
        createdAt: input.now
      }
    ],
    createdAt: input.now,
    updatedAt: input.now
  };
}

export function createBugPrd(requirement: Requirement, now: string): Prd {
  const acceptanceCriteria = [
    "测试 agent 能根据复现步骤确认问题存在或给出阻塞原因",
    "开发 agent 完成修复后保留原有正常流程",
    "结果页包含复现结论、修复摘要、测试证据和验收入口"
  ];

  return {
    id: `prd_${requirement.id}`,
    requirementId: requirement.id,
    version: 1,
    status: "approved",
    title: requirement.simpleSummary,
    acceptanceCriteria,
    approvedAt: now,
    bodyMarkdown: [
      `# ${requirement.simpleSummary}`,
      "",
      "## 要修什么",
      requirement.rawInput,
      "",
      "## 不做什么",
      "- 不访问生产密钥或生产数据",
      "- 不自动合并到主分支",
      "- 不扩大到无关重构",
      "",
      "## 如何验收",
      ...acceptanceCriteria.map((criterion) => `- ${criterion}`)
    ].join("\n")
  };
}

export function createBugWorkItem(input: {
  bugId: string;
  requirementId: string;
  prdId: string;
  title: string;
  now: string;
}): WorkItem {
  return {
    id: `wi_${input.requirementId}_bugrepro`,
    prdId: input.prdId,
    title: `复现 bug：${input.title}`,
    status: "ready",
    role: "test",
    sourceBugId: input.bugId,
    scope: "测试 agent 根据复现步骤确认问题存在，记录最小复现和回归测试建议，然后交给开发 agent 修复。",
    nonGoals: ["不自动发布", "不修改无关模块", "不访问生产数据"],
    acceptanceCriteria: [
      "复现步骤被记录并给出确认结果",
      "失败现象、期望行为和实际行为被整理成可执行修复上下文",
      "生成后续开发修复任务"
    ],
    testSuggestions: ["用 bug 复现步骤写回归检查", "记录最小复现路径", "给开发 agent 留下回归测试建议"],
    version: 1,
    createdAt: input.now,
    updatedAt: input.now
  };
}

export function createBugFixWorkItem(input: {
  bugId: string;
  requirementId: string;
  prdId: string;
  title: string;
  now: string;
}): WorkItem {
  return {
    id: `wi_${input.requirementId}_devfix`,
    prdId: input.prdId,
    title: `修复 bug：${input.title}`,
    status: "ready",
    role: "backend",
    sourceBugId: input.bugId,
    scope: "开发 agent 基于测试 agent 的复现结论修复问题，补充或更新回归测试，并保留修复证据。",
    nonGoals: ["不自动发布", "不修改无关模块", "不访问生产数据"],
    acceptanceCriteria: [
      "复现问题被修复并保留原有正常流程",
      "相关回归测试通过",
      "验收页展示修复摘要、测试证据和风险"
    ],
    testSuggestions: ["先运行复现/回归测试", "修复后运行目标测试命令", "确认 bug 不再复现"],
    version: 1,
    createdAt: input.now,
    updatedAt: input.now
  };
}
