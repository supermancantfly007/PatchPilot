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

export type AcceptanceStatus = "pending" | "accepted" | "rejected";

export type TimelineStepKey = "understanding" | "planning" | "developing" | "testing" | "confirming";

export type AgentRunnerKind = "simulated" | "codex";

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
  createdAt: string;
  updatedAt: string;
}

export interface ClarificationQuestion {
  id: string;
  question: string;
  recommendedAnswer: string;
  answer?: string;
}

export interface Prd {
  id: string;
  requirementId: string;
  version: number;
  status: "draft" | "approved";
  title: string;
  bodyMarkdown: string;
  acceptanceCriteria: string[];
  approvedAt?: string;
}

export interface WorkItem {
  id: string;
  prdId: string;
  title: string;
  status: WorkItemStatus;
  scope: string;
  nonGoals: string[];
  acceptanceCriteria: string[];
  testSuggestions: string[];
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
  failureSummary?: string;
  costEstimateUsd: number;
  costActualUsd?: number;
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
  workspacePath?: string;
  codexSessionId?: string;
}

export interface RuntimeConfig {
  configuredRunner: "auto" | AgentRunnerKind;
  activeRunner: AgentRunnerKind;
  codexAvailable: boolean;
  gitWorkspaceAvailable: boolean;
  testCommand: string;
  workspaceRoot: string;
}

export interface TestRun {
  id: string;
  status: TestRunStatus;
  command: string;
  summary: string;
  durationMs: number;
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
  agentRuns: AgentRun[];
  acceptances: AcceptanceDecision[];
}

export const emptySnapshot = (): PatchPilotSnapshot => ({
  requirements: [],
  prds: [],
  workItems: [],
  agentRuns: [],
  acceptances: []
});

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
  return [
    {
      id: `wi_${prd.requirementId}_001`,
      prdId: prd.id,
      title: "完成最小可验收交付闭环",
      status: "ready",
      scope: "围绕已确认需求完成一次端到端变更，包括实现、测试、审查摘要和验收入口。",
      nonGoals: ["不自动合并", "不执行生产发布", "不访问生产密钥"],
      acceptanceCriteria: prd.acceptanceCriteria,
      testSuggestions: ["运行目标测试命令", "检查完成页证据摘要", "确认风险提示和验收按钮可用"]
    }
  ];
}
