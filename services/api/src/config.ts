import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  defaultEgressAllowedHosts,
  defaultEgressAuditLogPath,
  type AgentRunnerKind,
  type ArtifactStorageProvider,
  type ContainerRuntimeKind
} from "@patchpilot/domain";
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
  PATCHPILOT_CONTAINER_SANDBOX_ENABLED?: string;
  PATCHPILOT_CONTAINER_SANDBOX_RUNTIME?: string;
  PATCHPILOT_CONTAINER_SANDBOX_IMAGE?: string;
  PATCHPILOT_CONTAINER_SANDBOX_CPUS?: string;
  PATCHPILOT_CONTAINER_SANDBOX_MEMORY_MB?: string;
  PATCHPILOT_CONTAINER_SANDBOX_WORKSPACE_DISK_MB?: string;
  PATCHPILOT_CONTAINER_SANDBOX_TMPFS_MB?: string;
  PATCHPILOT_CONTAINER_SANDBOX_PIDS_LIMIT?: string;
  PATCHPILOT_CONTAINER_SANDBOX_UID?: string;
  PATCHPILOT_CONTAINER_SANDBOX_GID?: string;
  PATCHPILOT_EGRESS_POLICY_ENABLED?: string;
  PATCHPILOT_EGRESS_ALLOWED_HOSTS?: string;
  PATCHPILOT_EGRESS_ALLOW_GIT_REMOTES?: string;
  PATCHPILOT_EGRESS_PROXY_IMAGE?: string;
  PATCHPILOT_EGRESS_PROXY_PORT?: string;
  PATCHPILOT_EGRESS_AUDIT_LOG_PATH?: string;
  PATCHPILOT_PREVIEW_URL?: string;
  PATCHPILOT_ARTIFACT_STORE?: string;
  PATCHPILOT_ARTIFACT_ROOT?: string;
  PATCHPILOT_ARTIFACT_S3_ENDPOINT?: string;
  PATCHPILOT_ARTIFACT_S3_REGION?: string;
  PATCHPILOT_ARTIFACT_S3_BUCKET?: string;
  PATCHPILOT_ARTIFACT_S3_ACCESS_KEY_ID?: string;
  PATCHPILOT_ARTIFACT_S3_SECRET_ACCESS_KEY?: string;
  PATCHPILOT_ARTIFACT_S3_FORCE_PATH_STYLE?: string;
  PATCHPILOT_ARTIFACT_S3_PREFIX?: string;
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
    containerSandbox: {
      enabled: boolean;
      runtime: ContainerRuntimeKind;
      image: string;
      cpus: number;
      memoryMb: number;
      workspaceDiskMb: number;
      tmpfsMb: number;
      pidsLimit: number;
      uid: number;
      gid: number;
    };
    egressPolicy: {
      enabled: boolean;
      allowedHosts: string[];
      allowGitRemotes: boolean;
      proxyImage: string;
      proxyPort: number;
      auditLogPath: string;
      denyPrivateNetworks: true;
      denyMetadataEndpoints: true;
    };
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
    localRoot: string;
    s3: {
      endpoint?: string;
      region: string;
      bucket: string;
      accessKeyId: string;
      secretAccessKey: string;
      forcePathStyle: boolean;
      prefix: string;
    };
  };
}

interface ReadConfigOptions {
  cwd?: string;
  env?: PatchPilotConfigEnv;
  configPath?: string;
}

const configuredRunnerSchema = z.enum(["auto", "simulated", "codex"]);
const artifactProviderSchema = z.enum(["local_fs", "s3"]);
const containerRuntimeSchema = z.enum(["auto", "docker", "podman"]);
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
    codexBypass: z.boolean().optional(),
    containerSandbox: z.object({
      enabled: z.boolean().optional(),
      runtime: containerRuntimeSchema.optional(),
      image: z.string().optional(),
      cpus: z.number().positive().optional(),
      memoryMb: z.number().int().positive().optional(),
      workspaceDiskMb: z.number().int().positive().optional(),
      tmpfsMb: z.number().int().positive().optional(),
      pidsLimit: z.number().int().positive().optional(),
      uid: z.number().int().positive().optional(),
      gid: z.number().int().positive().optional()
    }).optional(),
    egressPolicy: z.object({
      enabled: z.boolean().optional(),
      allowedHosts: stringArraySchema.optional(),
      allowGitRemotes: z.boolean().optional(),
      proxyImage: z.string().optional(),
      proxyPort: z.number().int().positive().optional(),
      auditLogPath: z.string().optional()
    }).optional()
  }).optional(),
  budget: z.object({
    codexTimeoutMs: z.number().positive().optional(),
    maxCostUsd: z.number().nonnegative().optional(),
    prdUsd: z.number().nonnegative().optional(),
    workItemUsd: z.number().nonnegative().optional(),
    runUsd: z.number().nonnegative().optional(),
    softThresholdRatio: z.number().min(0).max(1).optional()
  }).optional(),
  artifacts: z.object({
    provider: artifactProviderSchema.optional(),
    localRoot: z.string().optional(),
    s3: z.object({
      endpoint: z.string().optional(),
      region: z.string().optional(),
      bucket: z.string().optional(),
      accessKeyId: z.string().optional(),
      secretAccessKey: z.string().optional(),
      forcePathStyle: z.boolean().optional(),
      prefix: z.string().optional()
    }).optional()
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
  const localArtifactRoot = pickString(
    env.PATCHPILOT_ARTIFACT_ROOT,
    raw.artifacts?.localRoot ? resolveRelativePath(configRoot, raw.artifacts.localRoot) : undefined,
    join(cwd, ".patchpilot", "artifacts")
  );
  const s3Endpoint = pickString(env.PATCHPILOT_ARTIFACT_S3_ENDPOINT, raw.artifacts?.s3?.endpoint, "");

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
      codexBypass: pickBoolean(env.PATCHPILOT_CODEX_BYPASS, raw.security?.codexBypass, false),
      containerSandbox: {
        enabled: pickBoolean(
          env.PATCHPILOT_CONTAINER_SANDBOX_ENABLED,
          raw.security?.containerSandbox?.enabled,
          false
        ),
        runtime: pickContainerRuntime(
          env.PATCHPILOT_CONTAINER_SANDBOX_RUNTIME,
          raw.security?.containerSandbox?.runtime,
          "auto"
        ),
        image: pickString(
          env.PATCHPILOT_CONTAINER_SANDBOX_IMAGE,
          raw.security?.containerSandbox?.image,
          "node:24-alpine"
        ),
        cpus: pickNumber(env.PATCHPILOT_CONTAINER_SANDBOX_CPUS, raw.security?.containerSandbox?.cpus, 2),
        memoryMb: pickInteger(
          env.PATCHPILOT_CONTAINER_SANDBOX_MEMORY_MB,
          raw.security?.containerSandbox?.memoryMb,
          4096
        ),
        workspaceDiskMb: pickInteger(
          env.PATCHPILOT_CONTAINER_SANDBOX_WORKSPACE_DISK_MB,
          raw.security?.containerSandbox?.workspaceDiskMb,
          8192
        ),
        tmpfsMb: pickInteger(
          env.PATCHPILOT_CONTAINER_SANDBOX_TMPFS_MB,
          raw.security?.containerSandbox?.tmpfsMb,
          256
        ),
        pidsLimit: pickInteger(
          env.PATCHPILOT_CONTAINER_SANDBOX_PIDS_LIMIT,
          raw.security?.containerSandbox?.pidsLimit,
          512
        ),
        uid: pickInteger(
          env.PATCHPILOT_CONTAINER_SANDBOX_UID,
          raw.security?.containerSandbox?.uid,
          typeof process.getuid === "function" && process.getuid() > 0 ? process.getuid() : 1000
        ),
        gid: pickInteger(
          env.PATCHPILOT_CONTAINER_SANDBOX_GID,
          raw.security?.containerSandbox?.gid,
          typeof process.getgid === "function" && process.getgid() > 0 ? process.getgid() : 1000
        )
      },
      egressPolicy: {
        enabled: pickBoolean(env.PATCHPILOT_EGRESS_POLICY_ENABLED, raw.security?.egressPolicy?.enabled, true),
        allowedHosts: pickStringList(
          env.PATCHPILOT_EGRESS_ALLOWED_HOSTS,
          raw.security?.egressPolicy?.allowedHosts,
          [...defaultEgressAllowedHosts]
        ),
        allowGitRemotes: pickBoolean(
          env.PATCHPILOT_EGRESS_ALLOW_GIT_REMOTES,
          raw.security?.egressPolicy?.allowGitRemotes,
          true
        ),
        proxyImage: pickString(
          env.PATCHPILOT_EGRESS_PROXY_IMAGE,
          raw.security?.egressPolicy?.proxyImage,
          "node:24-alpine"
        ),
        proxyPort: pickInteger(env.PATCHPILOT_EGRESS_PROXY_PORT, raw.security?.egressPolicy?.proxyPort, 3128),
        auditLogPath: pickString(
          env.PATCHPILOT_EGRESS_AUDIT_LOG_PATH,
          raw.security?.egressPolicy?.auditLogPath,
          defaultEgressAuditLogPath
        ),
        denyPrivateNetworks: true,
        denyMetadataEndpoints: true
      }
    },
    budget: {
      codexTimeoutMs: pickNumber(env.PATCHPILOT_CODEX_TIMEOUT_MS, raw.budget?.codexTimeoutMs, 10 * 60 * 1000),
      maxCostUsd,
      prdUsd: pickNumber(env.PATCHPILOT_BUDGET_PRD_USD, raw.budget?.prdUsd, maxCostUsd),
      workItemUsd: pickNumber(env.PATCHPILOT_BUDGET_WORK_ITEM_USD, raw.budget?.workItemUsd, 0),
      runUsd: pickNumber(env.PATCHPILOT_BUDGET_RUN_USD, raw.budget?.runUsd, 0),
      softThresholdRatio: pickNumber(env.PATCHPILOT_BUDGET_SOFT_THRESHOLD_RATIO, raw.budget?.softThresholdRatio, 0.8)
    },
    artifacts: {
      provider: pickArtifactProvider(env.PATCHPILOT_ARTIFACT_STORE, raw.artifacts?.provider, "local_fs"),
      localRoot: localArtifactRoot,
      s3: {
        ...(s3Endpoint ? { endpoint: s3Endpoint } : {}),
        region: pickString(env.PATCHPILOT_ARTIFACT_S3_REGION, raw.artifacts?.s3?.region, "us-east-1"),
        bucket: pickString(env.PATCHPILOT_ARTIFACT_S3_BUCKET, raw.artifacts?.s3?.bucket, "patchpilot"),
        accessKeyId: pickString(env.PATCHPILOT_ARTIFACT_S3_ACCESS_KEY_ID, raw.artifacts?.s3?.accessKeyId, "patchpilot"),
        secretAccessKey: pickString(
          env.PATCHPILOT_ARTIFACT_S3_SECRET_ACCESS_KEY,
          raw.artifacts?.s3?.secretAccessKey,
          "patchpilot123"
        ),
        forcePathStyle: pickBoolean(
          env.PATCHPILOT_ARTIFACT_S3_FORCE_PATH_STYLE,
          raw.artifacts?.s3?.forcePathStyle,
          true
        ),
        prefix: pickString(env.PATCHPILOT_ARTIFACT_S3_PREFIX, raw.artifacts?.s3?.prefix, "patchpilot")
      }
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

function pickStringList(envValue: string | undefined, configValue: string[] | undefined, defaultValue: string[]) {
  const normalizedEnv = envValue?.trim();
  if (normalizedEnv) return splitList(normalizedEnv);
  const normalizedConfig = configValue?.map((value) => value.trim()).filter(Boolean);
  if (normalizedConfig && normalizedConfig.length > 0) return normalizedConfig;
  return defaultValue;
}

function splitList(value: string) {
  return value
    .split(/[,\n]/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function pickNumber(envValue: string | undefined, configValue: number | undefined, defaultValue: number) {
  const normalizedEnv = envValue?.trim();
  const parsedEnv = normalizedEnv ? Number(normalizedEnv) : undefined;
  if (parsedEnv !== undefined && Number.isFinite(parsedEnv)) return parsedEnv;
  if (configValue !== undefined) return configValue;
  return defaultValue;
}

function pickInteger(envValue: string | undefined, configValue: number | undefined, defaultValue: number) {
  return Math.max(1, Math.floor(pickNumber(envValue, configValue, defaultValue)));
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

function pickContainerRuntime(
  envValue: string | undefined,
  configValue: ContainerRuntimeKind | undefined,
  defaultValue: ContainerRuntimeKind
): ContainerRuntimeKind {
  if (envValue === "auto" || envValue === "docker" || envValue === "podman") return envValue;
  return configValue ?? defaultValue;
}

function pickArtifactProvider(
  envValue: string | undefined,
  configValue: ArtifactStorageProvider | undefined,
  defaultValue: ArtifactStorageProvider
): ArtifactStorageProvider {
  if (envValue === "local_fs" || envValue === "s3") return envValue;
  return configValue ?? defaultValue;
}
