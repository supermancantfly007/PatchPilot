import { chromium } from "playwright-core";

const baseUrl = process.env.PATCHPILOT_E2E_URL || "http://localhost:3000";
const chromeExecutable =
  process.env.PLAYWRIGHT_CHROME_EXECUTABLE || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const browser = await chromium.launch({
  executablePath: chromeExecutable,
  headless: true
});

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByPlaceholder(/你想让 PatchPilot 做什么/).fill(
    "做一个端到端可用的 agent 平台，白色底，用户可以提交需求、确认需求、看到 agent 执行进度、查看测试证据并接受结果。"
  );
  await page.getByRole("button", { name: /生成需求说明/ }).click();

  await page.waitForURL(/\/requirements\/.+\/confirm/);
  await page.getByText("简版需求确认").waitFor();
  await page.getByRole("button", { name: /生成需求说明/ }).click();
  await page.locator("strong").filter({ hasText: "如何验收" }).first().waitFor();
  await page.getByRole("heading", { name: "接口契约" }).waitFor();
  await page.getByText("交付控制 HTTP API").waitFor();
  await page.getByRole("button", { name: /开始执行/ }).click();

  await page.waitForURL(/\/runs\/.+/);
  await page.getByText(/PatchPilot 正在推进这次任务/).waitFor();
  await page.getByText("Agent team 进度").waitFor();
  await page.getByText(/4\/4 完成/).waitFor({ timeout: 15000 });
  await page.getByRole("heading", { name: "交付证据" }).waitFor();
  await page.getByText("WorkspaceRun").waitFor();
  await page.getByText(/TestCase · 待执行/).waitFor();
  await page.getByText(/PullRequest · 待审查/).waitFor();
  await page.getByText(/ReviewRecord · 已批准/).waitFor();
  await page.getByText("TestRun").waitFor();
  await page.getByRole("button", { name: /查看结果并确认/ }).waitFor({ state: "visible", timeout: 15000 });
  await page.getByRole("button", { name: /查看结果并确认/ }).click();

  await page.waitForURL(/\/acceptance\/.+/);
  await page.getByText("这次 agent 交付完成了").waitFor();
  await page.getByText(/4\/4 可验收/).waitFor();
  await page.getByRole("heading", { name: "测试用例" }).waitFor();
  await page.getByRole("heading", { name: "测试证据" }).waitFor();
  await page.getByRole("heading", { name: "审查证据" }).waitFor();
  await page.getByRole("heading", { name: "PR 交付" }).waitFor();
  await page.getByRole("heading", { name: "交付审计" }).waitFor();
  await page.getByRole("button", { name: /接受结果/ }).click();

  await page.waitForURL(baseUrl);
  await page.getByText(/你说目标，PatchPilot 负责推进到可验收结果/).waitFor();

  if (process.env.PATCHPILOT_E2E_SCREENSHOT) {
    await page.screenshot({ path: process.env.PATCHPILOT_E2E_SCREENSHOT, fullPage: true });
  }

  console.log("PatchPilot smoke E2E passed");
} finally {
  await browser.close();
}
