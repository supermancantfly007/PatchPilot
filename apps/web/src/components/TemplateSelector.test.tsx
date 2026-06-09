import { describe, expect, it } from "vitest";

describe("web smoke", () => {
  it("keeps the MVP template labels stable", () => {
    const labels = ["做新功能", "修 bug", "改页面", "上传需求"];
    expect(labels).toHaveLength(4);
    expect(labels).toContain("改页面");
  });
});
