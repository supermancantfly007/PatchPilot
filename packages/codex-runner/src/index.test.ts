import { describe, expect, it } from "vitest";
import { parseCodexEvent, summarizeCodexExecFailure } from "./index";

describe("codex-runner", () => {
  it("parses Codex JSONL events and session ids", () => {
    expect(parseCodexEvent(JSON.stringify({
      type: "agent_message",
      session_id: "session-123",
      message: "implemented the change"
    }))).toEqual({
      message: "Codex：implemented the change",
      sessionId: "session-123"
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
});
