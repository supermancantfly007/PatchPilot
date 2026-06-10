import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const baseUrl = process.env.PATCHPILOT_E2E_URL || "http://localhost:3000";
const chromeExecutable =
  process.env.PLAYWRIGHT_CHROME_EXECUTABLE || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const browser = await chromium.launch({
  executablePath: chromeExecutable,
  headless: true
});

const scenarios = [
  { name: "desktop", viewport: { width: 1440, height: 1000 } },
  { name: "mobile-375", viewport: { width: 375, height: 900 } }
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function screenshotPathFor(scenarioName) {
  const target = process.env.PATCHPILOT_E2E_SCREENSHOT;
  if (!target) return undefined;
  if (scenarios.length === 1) return target;

  const slashIndex = target.lastIndexOf("/");
  const dotIndex = target.lastIndexOf(".");
  if (dotIndex > slashIndex) {
    return `${target.slice(0, dotIndex)}-${scenarioName}${target.slice(dotIndex)}`;
  }
  return `${target}-${scenarioName}.png`;
}

async function waitForUsableAction(locator, label) {
  await locator.waitFor({ state: "visible", timeout: 15000 });
  await locator.scrollIntoViewIfNeeded();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await locator.isEnabled()) break;
    await sleep(100);
  }
  if (!(await locator.isEnabled())) {
    throw new Error(`${label} remained disabled`);
  }

  const details = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const centerX = Math.max(0, Math.min(window.innerWidth - 1, rect.left + rect.width / 2));
    const centerY = Math.max(0, Math.min(window.innerHeight - 1, rect.top + rect.height / 2));
    const hit = document.elementFromPoint(centerX, centerY);
    return {
      bottom: rect.bottom,
      centerHitsElement: hit ? element === hit || element.contains(hit) : false,
      clientHeight: element.clientHeight,
      clientWidth: element.clientWidth,
      hitLabel: hit ? `${hit.tagName.toLowerCase()}${hit.className ? `.${String(hit.className).replace(/\s+/g, ".")}` : ""}` : "none",
      left: rect.left,
      right: rect.right,
      scrollHeight: element.scrollHeight,
      scrollWidth: element.scrollWidth,
      text: element.textContent?.replace(/\s+/g, " ").trim() ?? "",
      top: rect.top,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth
    };
  });

  if (details.left < -1 || details.right > details.viewportWidth + 1 || details.top < -1 || details.bottom > details.viewportHeight + 1) {
    throw new Error(`${label} is outside the viewport: ${JSON.stringify(details)}`);
  }
  if (details.scrollWidth > details.clientWidth + 1 || details.scrollHeight > details.clientHeight + 1) {
    throw new Error(`${label} content is clipped: ${JSON.stringify(details)}`);
  }
  if (!details.centerHitsElement) {
    throw new Error(`${label} is covered at its center by ${details.hitLabel}: ${JSON.stringify(details)}`);
  }
}

async function assertNoHorizontalOverflow(page, label) {
  const details = await page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    const scrollWidth = Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0);
    const offenders = Array.from(document.body.querySelectorAll("*"))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          className: typeof element.className === "string" ? element.className : "",
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          tagName: element.tagName.toLowerCase(),
          text: element.textContent?.replace(/\s+/g, " ").trim().slice(0, 80) ?? "",
          width: Math.round(rect.width)
        };
      })
      .filter((item) => item.width > 0 && (item.left < -1 || item.right > viewportWidth + 1))
      .slice(0, 8);

    return { offenders, scrollWidth, viewportWidth };
  });

  if (details.scrollWidth > details.viewportWidth + 1) {
    throw new Error(`${label} has horizontal overflow: ${JSON.stringify(details)}`);
  }
}

async function runSmokeScenario(scenario) {
  const page = await browser.newPage({ viewport: scenario.viewport });
  const fixtureDir = await mkdtemp(join(tmpdir(), `patchpilot-${scenario.name}-attachments-`));

  try {
    const checkpoint = async (label) => {
      await assertNoHorizontalOverflow(page, `${scenario.name}: ${label}`);
    };

    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await checkpoint("home");
    await page.getByPlaceholder(/你想让 PatchPilot 做什么/).fill(
      "做一个端到端可用的 agent 平台，白色底，用户可以提交需求、确认需求、看到 agent 执行进度、查看测试证据并接受结果。"
    );
    const attachmentFile = join(fixtureDir, `td123-${scenario.name}-context.txt`);
    await writeFile(attachmentFile, `TD-123 ${scenario.name} attachment fixture`, "utf8");
    await page.getByLabel("添加文件、截图或录屏").setInputFiles(attachmentFile);
    await page.getByRole("button", { name: /^截图$/ }).click();
    await page.getByLabel("链接标题").fill("客户反馈链接");
    await page.getByLabel("链接 URL").fill("https://example.com/patchpilot/td-123");
    await page.getByRole("button", { name: /添加链接/ }).click();
    await page.getByText(`td123-${scenario.name}-context.txt`).first().waitFor();
    await page.getByText("客户反馈链接").first().waitFor();
    await page.getByText("3 个附件或链接会进入需求说明").waitFor();
    const submitRequirement = page.getByRole("button", { name: /生成需求说明/ });
    await waitForUsableAction(submitRequirement, `${scenario.name}: submit requirement`);
    await submitRequirement.click();

    await page.waitForURL(/\/requirements\/.+\/confirm/);
    await page.getByText("简版需求确认").waitFor();
    await checkpoint("clarification");
    const useRecommendedAnswer = page.getByRole("button", { name: /使用推荐答案/ });
    await waitForUsableAction(useRecommendedAnswer, `${scenario.name}: use recommended clarification answer`);
    await useRecommendedAnswer.click();
    const clarificationAnswer = page.getByPlaceholder(/回答当前问题/);
    await clarificationAnswer.waitFor({ state: "visible" });
    if (!(await clarificationAnswer.inputValue()).trim()) {
      throw new Error(`${scenario.name}: recommended clarification answer did not populate the textarea`);
    }
    const sendClarification = page.getByRole("button", { name: /发送并继续澄清/ });
    await waitForUsableAction(sendClarification, `${scenario.name}: send clarification answer`);
    await sendClarification.click();
    await page.waitForFunction(() => {
      const input = document.querySelector("textarea[placeholder*='回答当前问题']");
      return input instanceof HTMLTextAreaElement && input.value === "";
    });
    await checkpoint("clarification reply");
    const generatePrd = page.getByRole("button", { name: /生成需求说明/ });
    await waitForUsableAction(generatePrd, `${scenario.name}: generate requirement brief`);
    await generatePrd.click();
    await page.locator("strong").filter({ hasText: "如何验收" }).first().waitFor();
    await page.getByRole("heading", { name: "接口契约" }).waitFor();
    await page.getByText("交付控制 HTTP API").waitFor();
    await page.locator("strong").filter({ hasText: "关联资料" }).first().waitFor();
    await page.getByText(`td123-${scenario.name}-context.txt`).first().waitFor();
    await page.getByText("待补充截图 1").first().waitFor();
    await page.getByText("客户反馈链接").first().waitFor();
    await checkpoint("requirement brief");
    const startTeam = page.getByRole("button", { name: /开始执行/ });
    await waitForUsableAction(startTeam, `${scenario.name}: start team`);
    await startTeam.click();

    await page.waitForURL(/\/runs\/.+/);
    await page.getByText(/PatchPilot 正在推进这次任务/).waitFor();
    await page.getByText("Agent team 进度").waitFor();
    await page.getByText(/4\/4 完成/).waitFor({ timeout: 15000 });
    await page.getByRole("heading", { name: "预算和审批" }).waitFor();
    await page.getByText("成本").first().waitFor();
    await page.getByText("未设置").first().waitFor();
    await page.getByRole("heading", { name: "交付证据" }).waitFor();
    await page.getByText("输入资料").waitFor();
    await page.getByText(`td123-${scenario.name}-context.txt`).first().waitFor();
    await page.getByText("WorkspaceRun").waitFor();
    await page.getByText(/TestCase · 已通过/).waitFor();
    await page.getByText(/PullRequest · 待审查/).waitFor();
    await page.getByText(/ReviewRecord · 已批准/).waitFor();
    await page.getByText("TestRun").waitFor();
    await checkpoint("run progress");
    const viewResult = page.getByRole("button", { name: /查看结果并确认/ });
    await waitForUsableAction(viewResult, `${scenario.name}: view result`);
    await viewResult.click();

    await page.waitForURL(/\/acceptance\/.+/);
    await page.getByText("这次 agent 交付完成了").waitFor();
    await page.getByText(/4\/4 可验收/).waitFor();
    await page.getByText("4 个 agent 已完成交付").waitFor();
    await page.getByText("12 组文件").waitFor();
    await page.getByText("团队审查摘要").waitFor();
    await page.getByRole("heading", { name: "测试用例" }).waitFor();
    await page.getByText("测试用例通过率").waitFor();
    await page.getByText("100%").first().waitFor();
    await page.getByRole("heading", { name: "测试证据" }).waitFor();
    await page.getByRole("heading", { name: "审查证据" }).waitFor();
    await page.getByRole("heading", { name: "PR 交付" }).waitFor();
    await page.getByRole("heading", { name: "输入资料" }).waitFor();
    await page.getByText("客户反馈链接").first().waitFor();
    await page.getByRole("heading", { name: "交付审计" }).waitFor();
    await checkpoint("acceptance");
    await page.getByPlaceholder(/如果要求修改/).fill("首页需要明确显示返工任务已重新进入队列。");
    const rejectResult = page.getByRole("button", { name: /要求修改/ });
    await waitForUsableAction(rejectResult, `${scenario.name}: reject result`);
    await rejectResult.click();

    await page.waitForURL(/\/requirements\/.+\/confirm/);
    await page.getByText("这些任务已回到返工队列").waitFor();
    await page.getByText(/返工第 1 轮/).first().waitFor();
    await checkpoint("rework confirmation");
    const restartTeam = page.getByRole("button", { name: /开始执行/ });
    await waitForUsableAction(restartTeam, `${scenario.name}: restart team`);
    await restartTeam.click();

    await page.waitForURL(/\/runs\/.+/);
    await page.getByText(/PatchPilot 正在推进这次任务/).waitFor();
    await page.getByText("Agent team 进度").waitFor();
    await page.getByText(/4\/4 完成/).waitFor({ timeout: 15000 });
    await page.getByText(/返工第 1 轮/).first().waitFor();
    await checkpoint("rework run progress");
    const viewReworkResult = page.getByRole("button", { name: /查看结果并确认/ });
    await waitForUsableAction(viewReworkResult, `${scenario.name}: view rework result`);
    await viewReworkResult.click();

    await page.waitForURL(/\/acceptance\/.+/);
    await page.getByText("这次 agent 交付完成了").waitFor();
    await page.getByText(/4\/4 可验收/).waitFor();
    await page.getByText("4 个 agent 已完成交付").waitFor();
    await page.getByText("12 组文件").waitFor();
    await page.getByText("团队审查摘要").waitFor();
    await page.getByText(/返工第 1 轮/).first().waitFor();
    await checkpoint("rework acceptance");
    const acceptResult = page.getByRole("button", { name: /接受结果/ });
    await waitForUsableAction(acceptResult, `${scenario.name}: accept result`);
    await acceptResult.click();

    await page.waitForURL(baseUrl);
    await page.getByText(/你说目标，PatchPilot 负责推进到可验收结果/).waitFor();
    await checkpoint("accepted home");
    const controlLink = page.getByRole("link", { name: /专业控制台/ });
    await waitForUsableAction(controlLink, `${scenario.name}: open control`);
    await controlLink.click();

    await page.waitForURL(/\/control/);
    await page.getByRole("heading", { name: "专业控制台" }).waitFor();
    await page.getByText(/[1-9]\d* 个工作项/).first().waitFor();
    await page.getByText(/[1-9]\d* 条测试用例/).first().waitFor();
    await page.getByText(/[1-9]\d* 个 Agent Run/).first().waitFor();
    await page.getByText(/[1-9]\d* 条审计事件/).first().waitFor();
    await page.getByRole("heading", { name: "需求管理" }).waitFor();
    await page.getByRole("heading", { name: "工作项看板" }).waitFor();
    await page.getByRole("heading", { name: "测试用例管理" }).waitFor();
    await page.getByRole("heading", { name: "Bug 队列" }).waitFor();
    await page.getByRole("heading", { name: "Agent Run 证据" }).waitFor();
    await page.getByRole("heading", { name: "审批队列" }).waitFor();
    await page.getByRole("heading", { name: "成本与预算" }).waitFor();
    await page.getByText("成本 / 预算").first().waitFor();
    const requirementRegion = page.getByRole("region", { name: "需求管理" });
    await requirementRegion.getByText(/端到端可用的 agent 平台/).first().waitFor();
    await requirementRegion.getByText(/4 个工作项 · 8 个 Agent Run · 4 条测试用例/).first().waitFor();
    await requirementRegion.getByText(/3 个输入资料引用/).first().waitFor();
    const workItemRegion = page.getByRole("region", { name: "工作项看板" });
    await workItemRegion.getByText(/返工第 1 轮/).first().waitFor();
    await workItemRegion.getByText("首页需要明确显示返工任务已重新进入队列。").first().waitFor();
    await page.getByRole("region", { name: "交付审计" }).getByText("acceptance.accepted").first().waitFor();
    await checkpoint("control");

    const screenshotPath = screenshotPathFor(scenario.name);
    if (screenshotPath) {
      await page.screenshot({ path: screenshotPath, fullPage: true });
    }
  } finally {
    await page.close();
    await rm(fixtureDir, { recursive: true, force: true });
  }
}

try {
  for (const scenario of scenarios) {
    await runSmokeScenario(scenario);
  }

  console.log("PatchPilot smoke E2E passed for desktop and mobile-375");
} finally {
  await browser.close();
}
