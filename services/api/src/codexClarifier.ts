import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnCommand } from "@patchpilot/command-executor";
import { parseCodexEvent, summarizeCodexExecFailure } from "@patchpilot/codex-runner";
import { redactSecrets, type SecretRedactionOptions } from "@patchpilot/security";
import type { ClarificationTurn, Requirement, RequirementTemplate } from "@patchpilot/domain";

export interface ClarifierInput {
  requirementId: string;
  rawInput: string;
  template: RequirementTemplate;
  turns: ClarificationTurn[];
}

export interface ClarifierResult {
  message: string;
  recommendedAnswer: string;
  readyForPrd: boolean;
  codexSessionId?: string;
}

export interface RequirementClarifier {
  start(input: ClarifierInput): Promise<ClarifierResult>;
  continue(input: ClarifierInput & { codexSessionId: string; userMessage: string }): Promise<ClarifierResult>;
}

export interface LocalCodexClarifierConfig {
  repositoryRoot: string;
  codexTimeoutMs: number;
  codexSandbox: string;
  codexBypass: boolean;
}

const clarificationOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["message", "recommendedAnswer", "readyForPrd"],
  properties: {
    message: {
      type: "string",
      description: "The next one-at-a-time grill-me clarification question, or a final confirmation question."
    },
    recommendedAnswer: {
      type: "string",
      description: "The recommended answer the user can accept or edit."
    },
    readyForPrd: {
      type: "boolean",
      description: "True only when enough requirement detail has been confirmed to draft a PRD."
    }
  }
};

export class LocalCodexClarifier implements RequirementClarifier {
  constructor(private readonly config: LocalCodexClarifierConfig) {}

  async start(input: ClarifierInput): Promise<ClarifierResult> {
    return this.runCodexClarification(buildInitialPrompt(input));
  }

  async continue(input: ClarifierInput & { codexSessionId: string; userMessage: string }): Promise<ClarifierResult> {
    return this.runCodexClarification(buildContinuationPrompt(input), input.codexSessionId);
  }

  private async runCodexClarification(prompt: string, codexSessionId?: string): Promise<ClarifierResult> {
    const tempDir = await mkdtemp(join(tmpdir(), "patchpilot-codex-clarifier-"));
    const schemaPath = join(tempDir, "clarification.schema.json");
    const lastMessagePath = join(tempDir, "last-message.json");
    await writeFile(schemaPath, JSON.stringify(clarificationOutputSchema), "utf8");

    const args = ["exec"];
    if (this.config.codexBypass) {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    } else {
      args.push("--sandbox", this.config.codexSandbox);
    }
    args.push("-C", this.config.repositoryRoot);
    if (codexSessionId) {
      args.push("resume", "--json", "--output-schema", schemaPath, "-o", lastMessagePath, codexSessionId, "-");
    } else {
      args.push("--json", "--output-schema", schemaPath, "-o", lastMessagePath, "-");
    }

    try {
      const process = await spawnCommand({
        kind: "codex",
        command: "codex",
        args,
        cwd: this.config.repositoryRoot,
        timeoutMs: this.config.codexTimeoutMs,
        env: buildCodexCliEnv(),
        inheritEnv: false,
        maxOutputBytes: 512 * 1024
      });
      process.child.stdin.end(prompt);
      const result = await process.done;
      if (result.exitCode !== 0) {
        throw new Error(summarizeCodexExecFailure({
          stderr: result.stderr,
          stdoutRemainder: result.stdout,
          exitCode: result.exitCode
        }));
      }

      const parsed = parseClarificationResult(await readFile(lastMessagePath, "utf8"));
      const sessionId = parseCodexSessionId(result.stdout);
      return {
        ...parsed,
        codexSessionId: sessionId ?? codexSessionId
      };
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}

function buildInitialPrompt(input: ClarifierInput) {
  return [
    "$grill-me",
    "",
    "你正在 PatchPilot 的真实 Codex CLI 需求确认会话中工作。必须使用真实 skill 会话，不要生成占位内容。",
    "按 grill-me skill 的规则执行：一次只问一个问题，并给出推荐答案。",
    "如果问题能通过读取当前代码库回答，就先读取代码库。",
    "最终响应必须符合提供的 JSON schema。",
    "",
    `需求 ID：${input.requirementId}`,
    `需求类型：${input.template}`,
    "用户原始需求：",
    input.rawInput,
    "",
    "现在开始第一轮需求确认。只返回一个问题和一个推荐答案。"
  ].join("\n");
}

function buildContinuationPrompt(input: ClarifierInput & { userMessage: string }) {
  return [
    "继续这个 PatchPilot 需求确认会话。",
    "用户刚刚回答：",
    input.userMessage,
    "",
    "继续按 $grill-me 的规则追问。一次只问一个问题，并给出推荐答案。",
    "如果当前信息已经足够生成 PRD，readyForPrd 设为 true，但 message 仍应是让用户确认生成 PRD 的一句话。",
    "最终响应必须符合提供的 JSON schema。"
  ].join("\n");
}

function parseClarificationResult(raw: string): Omit<ClarifierResult, "codexSessionId"> {
  const parsed = parseJsonObject(raw);
  return {
    message: normalizeText(parsed.message, "Codex 没有返回澄清问题。"),
    recommendedAnswer: normalizeText(parsed.recommendedAnswer, "请补充你认为最关键的约束、验收标准或反例。"),
    readyForPrd: parsed.readyForPrd === true
  };
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    const match = raw.match(/\{[\s\S]*\}/u);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    }
  }
  throw new Error("Codex clarifier returned non-JSON output.");
}

function parseCodexSessionId(stdout: string, options: SecretRedactionOptions = {}) {
  for (const line of stdout.split("\n")) {
    const event = parseCodexEvent(line, options);
    if (event.sessionId) return event.sessionId;
  }
  return undefined;
}

function normalizeText(value: unknown, fallback: string) {
  const text = typeof value === "string" ? value.trim() : "";
  return redactSecrets(text || fallback).redacted;
}

function buildCodexCliEnv() {
  const env = { ...process.env };
  delete env.CODEX_API_KEY;
  return env;
}

export function codexClarificationTurn(input: {
  speaker: "agent" | "user";
  message: string;
  recommendedAnswer?: string;
  codexSessionId?: string;
  now?: string;
}): ClarificationTurn {
  const now = input.now ?? new Date().toISOString();
  return {
    id: `turn_${randomUUID()}`,
    speaker: input.speaker,
    message: redactSecrets(input.message).redacted,
    ...(input.recommendedAnswer ? { recommendedAnswer: redactSecrets(input.recommendedAnswer).redacted } : {}),
    ...(input.codexSessionId ? { codexSessionId: input.codexSessionId } : {}),
    createdAt: now
  };
}

export function latestCodexSessionId(requirement: Requirement) {
  return requirement.clarificationTurns
    .slice()
    .reverse()
    .find((turn) => turn.codexSessionId)?.codexSessionId;
}
