import { describe, expect, it } from "vitest";
import { CodexRunError, classifyFailureMessage, parseCodexEvent, summarizeCodexExecFailure } from "./index";

describe("codex-runner", () => {
  it("parses Codex JSONL events and session ids", () => {
    expect(parseCodexEvent(JSON.stringify({
      type: "agent_message",
      session_id: "session-123",
      message: "implemented the change"
    }))).toMatchObject({
      message: "Codex：implemented the change",
      sessionId: "session-123",
      agentMessage: "implemented the change"
    });
  });

  it("parses reasoning summaries from nested Codex items", () => {
    expect(parseCodexEvent(JSON.stringify({
      type: "item.completed",
      item: {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "inspected the runner capture path" }]
      }
    }))).toMatchObject({
      message: "Codex：inspected the runner capture path",
      reasoningSummary: "inspected the runner capture path"
    });
  });

  it("parses command execution tool calls from JSONL events", () => {
    expect(parseCodexEvent(JSON.stringify({
      type: "item.completed",
      item: {
        id: "tool-call-1",
        type: "command_execution",
        command: "pnpm test",
        status: "completed",
        exit_code: 0,
        duration_ms: 423
      }
    }))).toMatchObject({
      message: "Codex：执行命令：pnpm test",
      toolCall: {
        id: "tool-call-1",
        name: "exec_command",
        command: "pnpm test",
        status: "completed",
        exitCode: 0,
        durationMs: 423
      }
    });
  });

  it("parses plain-text fallback output", () => {
    expect(parseCodexEvent("plain progress")).toEqual({
      message: "Codex：plain progress",
      sessionId: undefined
    });
    expect(parseCodexEvent("  ")).toEqual({
      message: undefined,
      sessionId: undefined
    });
  });

  it("summarizes Codex exec failures without leaking huge output", () => {
    const summary = summarizeCodexExecFailure({
      stderr: "x".repeat(2000),
      exitCode: 2
    });

    expect(summary).toHaveLength("Codex 执行失败：".length + 1600);
    expect(summary).toMatch(/^Codex 执行失败：x+$/);
  });

  it("classifies structured runner failures", () => {
    expect(classifyFailureMessage("测试未通过：expected true")).toBe("test_failed");
    expect(classifyFailureMessage("request timed out after 60000ms")).toBe("transient");
    expect(classifyFailureMessage("command not found: codex")).toBe("environment_failed");
    expect(classifyFailureMessage("sandbox policy denied write access")).toBe("policy_denied");
    expect(classifyFailureMessage("budget quota exceeded")).toBe("budget_exhausted");

    const testRun = {
      id: "test_failed",
      status: "failed" as const,
      command: "pnpm test",
      summary: "one assertion failed",
      durationMs: 42
    };
    const error = new CodexRunError("测试未通过：one assertion failed", "test_failed", testRun);
    expect(error).toMatchObject({
      name: "CodexRunError",
      failureType: "test_failed",
      testRun
    });
  });
});
