import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { AgentRunnerKind } from "@patchpilot/domain";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

type ConfiguredRunner = "auto" | AgentRunnerKind;
type ConfigSource = "defaults" | "file";

export interface PatchPilotConfigEnv extends NodeJS.ProcessEnv {
  INIT_CWD?: string;
  PATCHPILOT_CONFIG_PATH?: string;
  PATCHPILOT_RUNNER?: string;
  PATCHPILOT_SIMULATION_DELAY_FACTOR?: string;
  PATCHPILOT_WORKSPACE_ROOT?: string;
  PATCHPILOT_TEST_COMMAND?: string;
  PATCHPILOT_TEST_TIMEOUT_MS?: string;
  PATCHPILOT_MAX_REPAIR_ATTEMPTS?: string;
  PATCHPILOT_CODEX_TIMEOUT_MS?: string;
  PATCHPILOT_BUDGET_MAX_COST_USD?: string;
  PATCHPILOT_BUDGET_PRD_USD?: string;
  PATCHPILOT_BUDGET_WORK_ITEM_USD?: string;
  PATCHPILOT_BUDGET_RUN_USD?: string;
  PATCHPILOT_BUDGET_SOFT_THRESHOLD_RATIO?: string;
  PATCHPILOT_CODEX_SANDBOX?: string;
  PATCHPILOT_CODEX_BYPASS?: string;
  PATCHPILOT_PREVIEW_URL?: string;
}

export interface ResolvedPatchPilotConfig {
  configSource: ConfigSource;
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
    runner: ConfiguredRunner;
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
}

interface ReadConfigOptions {
  cwd?: string;
  env?: PatchPilotConfigEnv;
  configPath?: string;
}

const configuredRunnerSchema = z.enum(["auto", "simulated", "codex"]);
const stringArraySchema = z.preprocess(
  (value) => (typeof value === "string" ? [value] : value),
  z.array(z.string())
);

const rawConfigSchema = z.object({
  setup: z.object({
    commands: stringArraySchema.optional()
  }).optional(),
  test: z.object({
    command: z.string().optional(),
    timeoutMs: z.number().positive().optional(),
    maxRepairAttempts: z.number().int().nonnegative().optional()
  }).optional(),
  smoke: z.object({
    command: z.string().optional(),
    timeoutMs: z.number().positive().optional(),
    previewUrl: z.string().optional()
  }).optional(),
  e2e: z.object({
    command: z.string().optional(),
    timeoutMs: z.number().positive().optional(),
    baseUrl: z.string().optional()
  }).optional(),
  dev: z.object({
    runner: configuredRunnerSchema.optional(),
    simulationDelayFactor: z.number().nonnegative().optional(),
    workspaceRoot: z.string().optional(),
    previewUrl: z.string().optional()
  }).optional(),
  security: z.object({
    codexSandbox: z.string().optional(),
    codexBypass: z.boolean().optional()
  }).optional(),
  budget: z.object({
    codexTimeoutMs: z.number().positive().optional(),
    maxCostUsd: z.number().nonnegative().optional(),
    prdUsd: z.number().nonnegative().optional(),
    workItemUsd: z.number().nonnegative().optional(),
    runUsd: z.number().nonnegative().optional(),
    softThresholdRatio: z.number().min(0).max(1).optional()
  }).optional()
}).partial();

type RawPatchPilotConfig = z.infer<typeof rawConfigSchema>;

export function readPatchPilotConfig(options: ReadConfigOptions = {}): ResolvedPatchPilotConfig {
  const env = options.env ?? process.env;
  const cwdStart = options.cwd ?? env.INIT_CWD ?? process.cwd();
  const cwd = findProjectRoot(cwdStart || process.cwd());
  const configPath = resolveConfigPath(cwd, env, options.configPath);
  const fileConfig = readConfigFile(configPath);
  const configSource: ConfigSource = fileConfig ? "file" : "defaults";
  const configRoot = fileConfig ? configRootFor(configPath) : cwd;
  const raw = fileConfig?.config ?? {};

  const devPreviewUrl = pickString(env.PATCHPILOT_PREVIEW_URL, raw.dev?.previewUrl, "http://localhost:3000");
  const testTimeoutMs = pickNumber(env.PATCHPILOT_TEST_TIMEOUT_MS, raw.test?.timeoutMs, 2 * 60 * 1000);
  const maxCostUsd = pickNumber(env.PATCHPILOT_BUDGET_MAX_COST_USD, raw.budget?.maxCostUsd, 0);

  return {
    configSource,
    ...(fileConfig ? { configPath } : {}),
    setup: {
      commands: raw.setup?.commands ?? []
    },
    test: {
      command: pickString(env.PATCHPILOT_TEST_COMMAND, raw.test?.command, "pnpm -r --if-present test"),
      timeoutMs: testTimeoutMs,
      maxRepairAttempts: pickNumber(env.PATCHPILOT_MAX_REPAIR_ATTEMPTS, raw.test?.maxRepairAttempts, 1)
    },
    smoke: {
      command: pickString(undefined, raw.smoke?.command, "pnpm e2e:smoke"),
      timeoutMs: pickNumber(undefined, raw.smoke?.timeoutMs, 2 * 60 * 1000),
      previewUrl: pickString(undefined, raw.smoke?.previewUrl, devPreviewUrl)
    },
    e2e: {
      command: pickString(undefined, raw.e2e?.command, "pnpm e2e:team && pnpm e2e:bug && pnpm e2e:smoke"),
      timeoutMs: pickNumber(undefined, raw.e2e?.timeoutMs, 5 * 60 * 1000),
      baseUrl: pickString(undefined, raw.e2e?.baseUrl, devPreviewUrl)
    },
    dev: {
      runner: pickRunner(env.PATCHPILOT_RUNNER, raw.dev?.runner, "auto"),
      simulationDelayFactor: pickNumber(
        env.PATCHPILOT_SIMULATION_DELAY_FACTOR,
        raw.dev?.simulationDelayFactor,
        1
      ),
      workspaceRoot: pickString(
        env.PATCHPILOT_WORKSPACE_ROOT,
        raw.dev?.workspaceRoot ? resolveRelativePath(configRoot, raw.dev.workspaceRoot) : undefined,
        join(cwd, ".patchpilot", "worktrees")
      ),
      previewUrl: devPreviewUrl
    },
    security: {
      codexSandbox: pickString(env.PATCHPILOT_CODEX_SANDBOX, raw.security?.codexSandbox, "workspace-write"),
      codexBypass: pickBoolean(env.PATCHPILOT_CODEX_BYPASS, raw.security?.codexBypass, false)
    },
    budget: {
      codexTimeoutMs: pickNumber(env.PATCHPILOT_CODEX_TIMEOUT_MS, raw.budget?.codexTimeoutMs, 10 * 60 * 1000),
      maxCostUsd,
      prdUsd: pickNumber(env.PATCHPILOT_BUDGET_PRD_USD, raw.budget?.prdUsd, maxCostUsd),
      workItemUsd: pickNumber(env.PATCHPILOT_BUDGET_WORK_ITEM_USD, raw.budget?.workItemUsd, 0),
      runUsd: pickNumber(env.PATCHPILOT_BUDGET_RUN_USD, raw.budget?.runUsd, 0),
      softThresholdRatio: pickNumber(env.PATCHPILOT_BUDGET_SOFT_THRESHOLD_RATIO, raw.budget?.softThresholdRatio, 0.8)
    }
  };
}

function resolveConfigPath(cwd: string, env: PatchPilotConfigEnv, explicitPath: string | undefined) {
  const configuredPath = explicitPath || env.PATCHPILOT_CONFIG_PATH;
  if (configuredPath) return resolveRelativePath(cwd, configuredPath);
  return join(cwd, ".patchpilot", "config.yaml");
}

function findProjectRoot(start: string) {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, ".patchpilot", "config.yaml"))) return current;
    if (existsSync(join(current, "pnpm-workspace.yaml"))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(start);
    current = parent;
  }
}

function configRootFor(configPath: string) {
  const configDir = dirname(configPath);
  return basename(configDir) === ".patchpilot" ? dirname(configDir) : configDir;
}

function readConfigFile(configPath: string): { config: RawPatchPilotConfig } | undefined {
  if (!existsSync(configPath)) return undefined;

  try {
    const parsed = parseYaml(readFileSync(configPath, "utf8")) ?? {};
    return { config: rawConfigSchema.parse(parsed) };
  } catch (error) {
    throw new Error(`Could not read PatchPilot config at ${configPath}`, { cause: error });
  }
}

function resolveRelativePath(cwd: string, value: string) {
  return isAbsolute(value) ? value : resolve(cwd, value);
}

function pickString(envValue: string | undefined, configValue: string | undefined, defaultValue: string) {
  const normalizedEnv = envValue?.trim();
  if (normalizedEnv) return normalizedEnv;
  const normalizedConfig = configValue?.trim();
  if (normalizedConfig) return normalizedConfig;
  return defaultValue;
}

function pickNumber(envValue: string | undefined, configValue: number | undefined, defaultValue: number) {
  const normalizedEnv = envValue?.trim();
  const parsedEnv = normalizedEnv ? Number(normalizedEnv) : undefined;
  if (parsedEnv !== undefined && Number.isFinite(parsedEnv)) return parsedEnv;
  if (configValue !== undefined) return configValue;
  return defaultValue;
}

function pickBoolean(envValue: string | undefined, configValue: boolean | undefined, defaultValue: boolean) {
  if (envValue !== undefined) return ["1", "true", "yes"].includes(envValue.toLowerCase());
  if (configValue !== undefined) return configValue;
  return defaultValue;
}

function pickRunner(
  envValue: string | undefined,
  configValue: ConfiguredRunner | undefined,
  defaultValue: ConfiguredRunner
): ConfiguredRunner {
  if (envValue === "auto" || envValue === "simulated" || envValue === "codex") return envValue;
  return configValue ?? defaultValue;
}
