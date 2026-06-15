import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const dataDir = await mkdtemp(join(tmpdir(), "patchpilot-professional-governance-"));
const apiPort = Number(process.env.PATCHPILOT_E2E_PRO_API_PORT || 4300 + (process.pid % 1000));
const webPort = Number(process.env.PATCHPILOT_E2E_PRO_WEB_PORT || apiPort + 1000);
const apiBaseUrl = `http://localhost:${apiPort}`;
const webBaseUrl = `http://localhost:${webPort}`;
const e2eAuthHeaders = {
  "x-patchpilot-user": "e2e-governance-maintainer",
  "x-patchpilot-role": "maintainer"
};
const chromeExecutable =
  process.env.PLAYWRIGHT_CHROME_EXECUTABLE || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const api = spawn("pnpm", ["--filter", "@patchpilot/api", "start"], {
  cwd: repoRoot,
  env: {
    ...process.env,
    PORT: String(apiPort),
    PATCHPILOT_DATA_DIR: dataDir,
    PATCHPILOT_RUNNER: "codex",
    PATCHPILOT_BUDGET_RUN_USD: "0.2"
  },
  stdio: ["ignore", "pipe", "pipe"]
});

const web = spawn("pnpm", ["--filter", "@patchpilot/web", "exec", "next", "dev", "--port", String(webPort)], {
  cwd: repoRoot,
  env: {
    ...process.env,
    NEXT_PUBLIC_API_BASE_URL: apiBaseUrl,
    NEXT_PUBLIC_PATCHPILOT_USER_ID: e2eAuthHeaders["x-patchpilot-user"],
    NEXT_PUBLIC_PATCHPILOT_ROLE: e2eAuthHeaders["x-patchpilot-role"]
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let apiOutput = "";
let webOutput = "";
api.stdout.on("data", (chunk) => {
  apiOutput += chunk.toString("utf8");
});
api.stderr.on("data", (chunk) => {
  apiOutput += chunk.toString("utf8");
});
web.stdout.on("data", (chunk) => {
  webOutput += chunk.toString("utf8");
});
web.stderr.on("data", (chunk) => {
  webOutput += chunk.toString("utf8");
});

let browser;

try {
  await waitForHealth();
  await waitForWeb();

  const requirement = await requestJson("/api/requirements", {
    method: "POST",
    body: JSON.stringify({
      rawInput: "专业模式需要直接处理预算审批并展示成本、预算和失败类型。",
      template: "feature"
    })
  });
  const { prd } = await requestJson(`/api/requirements/${requirement.id}/prd`, { method: "POST" });
  const prdApproval = await requestJson(`/api/prds/${prd.id}/approve`, { method: "POST" });
  const [firstWorkItem, secondWorkItem] = prdApproval.workItems;
  assert(firstWorkItem?.id && secondWorkItem?.id, "approved PRD should create at least two work items");

  const pausedForApprove = await requestJson(`/api/work-items/${firstWorkItem.id}/start`, {
    method: "POST",
    body: JSON.stringify({ runner: "codex" })
  });
  assertEqual(pausedForApprove.status, "needs_approval", "first run should wait for budget approval");
  const approvalToApprove = await findApproval(pausedForApprove.budgetApprovalId);

  browser = await chromium.launch({
    executablePath: chromeExecutable,
    headless: true
  });
  const page = await browser.newPage({ viewport: { width: 375, height: 900 } });

  await page.goto(`${webBaseUrl}/control`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.getByRole("heading", { name: "专业控制台" }).waitFor();
  await page.getByRole("heading", { name: "审批队列" }).waitFor();
  await page.getByRole("heading", { name: "成本与预算" }).waitFor();
  await page.getByText("预算超限").first().waitFor();
  await page.getByText("$0.42").first().waitFor();
  await page.getByText("$0.20").first().waitFor();
  await assertNoHorizontalOverflow(page, "control pending approval");

  const approveButton = page.getByRole("button", { name: `批准审批 ${approvalShortId(approvalToApprove.id)}` });
  await waitForUsableAction(approveButton, "approve budget approval from control");
  await approveButton.click();
  await page.getByRole("region", { name: "审批队列" }).getByText("已批准").first().waitFor();

  const approvedSnapshot = await requestJson("/api/snapshot");
  const approvedApproval = approvedSnapshot.approvals.find((approval) => approval.id === approvalToApprove.id);
  assertEqual(approvedApproval?.status, "approved", "control approval action should approve the budget gate");

  const pausedForDeny = await requestJson(`/api/work-items/${secondWorkItem.id}/start`, {
    method: "POST",
    body: JSON.stringify({ runner: "codex" })
  });
  assertEqual(pausedForDeny.status, "needs_approval", "second run should wait for budget approval");
  const approvalToDeny = await findApproval(pausedForDeny.budgetApprovalId);

  await page.goto(`${webBaseUrl}/runs/${pausedForDeny.id}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.getByRole("heading", { name: "预算和审批" }).waitFor();
  await page.getByText("已超过预算").first().waitFor();
  await page.getByText("预算超限").first().waitFor();
  await page.getByText("高风险").first().waitFor();
  await assertNoHorizontalOverflow(page, "run detail pending approval");

  const denyButton = page.getByRole("button", { name: `拒绝审批 ${approvalShortId(approvalToDeny.id)}` });
  await waitForUsableAction(denyButton, "deny budget approval from run detail");
  await denyButton.click();
  await page.getByText("已拒绝").first().waitFor();

  const deniedSnapshot = await requestJson("/api/snapshot");
  const deniedApproval = deniedSnapshot.approvals.find((approval) => approval.id === approvalToDeny.id);
  const deniedRun = deniedSnapshot.agentRuns.find((run) => run.id === pausedForDeny.id);
  assertEqual(deniedApproval?.status, "denied", "run detail denial action should deny the budget gate");
  assertEqual(deniedRun?.status, "needs_approval", "denied budget run should remain paused");

  console.log("PatchPilot professional governance E2E passed");
} finally {
  if (browser) await browser.close();
  api.kill("SIGTERM");
  web.kill("SIGTERM");
  await Promise.all([waitForExit(api), waitForExit(web)]);
  await rm(dataDir, { recursive: true, force: true });
}

async function findApproval(id) {
  assert(id, "run should link to a budget approval");
  const snapshot = await requestJson("/api/snapshot");
  const approval = snapshot.approvals.find((item) => item.id === id);
  assert(approval, `approval should exist: ${id}`);
  return approval;
}

async function requestJson(path, init = {}) {
  const headers = new Headers(init.headers);
  for (const [key, value] of Object.entries(e2eAuthHeaders)) headers.set(key, value);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(`${apiBaseUrl}${path}`, { ...init, headers });
  if (!response.ok) {
    throw new Error(`${init.method || "GET"} ${path} failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function waitForHealth() {
  await poll(async () => {
    if (api.exitCode !== null) {
      throw new Error(`API exited before health check\n${apiOutput}`);
    }
    try {
      const health = await requestJson("/health");
      return health.ok ? health : undefined;
    } catch (_error) {
      return undefined;
    }
  }, 20000);
}

async function waitForWeb() {
  await poll(async () => {
    if (web.exitCode !== null) {
      throw new Error(`Web exited before readiness check\n${webOutput}`);
    }
    try {
      const response = await fetch(`${webBaseUrl}/control`);
      return response.ok ? response : undefined;
    } catch (_error) {
      return undefined;
    }
  }, 60000);
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

async function poll(read, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await read();
    if (result) return result;
    await sleep(250);
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

function approvalShortId(approvalId) {
  return approvalId.replace(/^approval_/, "").slice(0, 8);
}

function assert(value, message) {
  if (!value) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForExit(child) {
  if (child.exitCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000))
  ]);
}
