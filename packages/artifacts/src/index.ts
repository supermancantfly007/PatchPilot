import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { ArtifactKind, ArtifactRecord, ArtifactStorageProvider } from "@patchpilot/domain";
import {
  redactRecordValues,
  redactSecrets,
  secretRedactionPolicyVersion
} from "@patchpilot/security";

export type ArtifactContent = string | Uint8Array;

export interface PutArtifactInput {
  id?: string;
  kind: ArtifactKind;
  content: ArtifactContent;
  contentType?: string;
  extension?: string;
  metadata?: Record<string, string>;
  requirementId?: string;
  prdId?: string;
  workItemId?: string;
  runId?: string;
  testRunId?: string;
  createdAt?: string;
}

export interface StoredArtifact {
  record: ArtifactRecord;
  bytes: Uint8Array;
}

export interface ArtifactStore {
  putArtifact(input: PutArtifactInput): Promise<ArtifactRecord>;
  getArtifact(id: string): Promise<StoredArtifact>;
}

export interface LocalArtifactStoreConfig {
  rootDir: string;
}

export interface S3ArtifactStoreConfig {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
  prefix?: string;
}

export interface ArtifactStoreConfig {
  provider: ArtifactStorageProvider;
  localRoot?: string;
  s3?: S3ArtifactStoreConfig;
}

export class LocalFileSystemArtifactStore implements ArtifactStore {
  constructor(private readonly config: LocalArtifactStoreConfig) {}

  async putArtifact(input: PutArtifactInput): Promise<ArtifactRecord> {
    const prepared = prepareArtifactInput(input, "local_fs");
    const contentPath = join(this.config.rootDir, prepared.relativePath);
    const metadataPath = join(this.config.rootDir, "index", `${prepared.record.id}.json`);
    const record: ArtifactRecord = {
      ...prepared.record,
      uri: `file://${contentPath}`
    };
    await mkdir(dirname(contentPath), { recursive: true });
    await mkdir(dirname(metadataPath), { recursive: true });
    await writeFile(contentPath, prepared.bytes);
    await writeFile(metadataPath, JSON.stringify(record, null, 2));
    return record;
  }

  async getArtifact(id: string): Promise<StoredArtifact> {
    const metadataPath = join(this.config.rootDir, "index", `${safeSegment(id)}.json`);
    const record = JSON.parse(await readFile(metadataPath, "utf8")) as ArtifactRecord;
    if (!record.uri.startsWith("file://")) {
      throw new Error(`Artifact ${id} is not a local file artifact`);
    }
    const bytes = await readFile(new URL(record.uri));
    return { record, bytes };
  }
}

export class S3CompatibleArtifactStore implements ArtifactStore {
  private readonly client: S3Client;
  private readonly prefix: string;

  constructor(private readonly config: S3ArtifactStoreConfig) {
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle ?? true,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey
      }
    });
    this.prefix = config.prefix?.replace(/^\/+|\/+$/g, "") ?? "patchpilot";
  }

  async putArtifact(input: PutArtifactInput): Promise<ArtifactRecord> {
    const prepared = prepareArtifactInput(input, "s3", this.prefix);
    const record: ArtifactRecord = {
      ...prepared.record,
      uri: `s3://${this.config.bucket}/${prepared.relativePath}`
    };

    await this.client.send(new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: prepared.relativePath,
      Body: prepared.bytes,
      ContentType: record.contentType,
      Metadata: artifactMetadata(record)
    }));
    await this.client.send(new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: indexKey(this.prefix, record.id),
      Body: JSON.stringify(record, null, 2),
      ContentType: "application/json"
    }));
    return record;
  }

  async getArtifact(id: string): Promise<StoredArtifact> {
    const metadata = await this.client.send(new GetObjectCommand({
      Bucket: this.config.bucket,
      Key: indexKey(this.prefix, id)
    }));
    const record = JSON.parse(await bodyToString(metadata.Body)) as ArtifactRecord;
    const key = record.uri.replace(`s3://${this.config.bucket}/`, "");
    const object = await this.client.send(new GetObjectCommand({
      Bucket: this.config.bucket,
      Key: key
    }));
    return { record, bytes: await bodyToBytes(object.Body) };
  }
}

export function createArtifactStore(config: ArtifactStoreConfig): ArtifactStore {
  if (config.provider === "s3") {
    if (!config.s3) throw new Error("S3 artifact store requires s3 config");
    return new S3CompatibleArtifactStore(config.s3);
  }
  if (!config.localRoot) throw new Error("Local artifact store requires localRoot");
  return new LocalFileSystemArtifactStore({ rootDir: config.localRoot });
}

function prepareArtifactInput(input: PutArtifactInput, storage: ArtifactStorageProvider, prefix = "") {
  const preparedContent = prepareArtifactContent(input.content);
  const bytes = toBytes(preparedContent.content);
  const id = safeSegment(input.id || `artifact_${input.kind}_${randomUUID()}`);
  const extension = normalizeExtension(input.extension || extensionFor(input.contentType));
  const relativePath = posix.join(prefix, input.kind, `${id}${extension}`);
  const checksumSha256 = createHash("sha256").update(bytes).digest("hex");
  const metadata = prepareArtifactMetadata(input.metadata, preparedContent.redactionCount);
  const record: ArtifactRecord = {
    id,
    kind: input.kind,
    storage,
    uri: "",
    contentType: input.contentType || "application/octet-stream",
    sizeBytes: bytes.byteLength,
    checksumSha256,
    ...(metadata ? { metadata } : {}),
    ...(input.requirementId ? { requirementId: input.requirementId } : {}),
    ...(input.prdId ? { prdId: input.prdId } : {}),
    ...(input.workItemId ? { workItemId: input.workItemId } : {}),
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.testRunId ? { testRunId: input.testRunId } : {}),
    createdAt: input.createdAt || new Date().toISOString()
  };
  return { bytes, relativePath, record };
}

function prepareArtifactContent(content: ArtifactContent) {
  if (typeof content !== "string") return { content, redactionCount: 0 };
  const result = redactSecrets(content);
  return {
    content: result.redacted,
    redactionCount: result.findings.length
  };
}

function prepareArtifactMetadata(metadata: Record<string, string> | undefined, contentRedactionCount: number) {
  const redactedMetadata = redactRecordValues(metadata) ?? {};
  const metadataRedacted = JSON.stringify(redactedMetadata) !== JSON.stringify(metadata ?? {});
  const redactionCount = contentRedactionCount + (metadataRedacted ? 1 : 0);
  if (redactionCount > 0) {
    redactedMetadata.redactionStatus = "redacted";
    redactedMetadata.redactionPolicyVersion = secretRedactionPolicyVersion;
    redactedMetadata.redactionFindingCount = String(redactionCount);
  }
  return Object.keys(redactedMetadata).length > 0 ? redactedMetadata : undefined;
}

function toBytes(content: ArtifactContent) {
  return typeof content === "string" ? Buffer.from(content, "utf8") : content;
}

function safeSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || `artifact_${randomUUID()}`;
}

function normalizeExtension(value: string | undefined) {
  if (!value) return "";
  const normalized = value.startsWith(".") ? value : `.${value}`;
  return normalized.replace(/[^a-zA-Z0-9.]+/g, "") || "";
}

function extensionFor(contentType: string | undefined) {
  if (!contentType) return "";
  if (contentType === "application/json") return ".json";
  if (contentType.startsWith("text/")) return ".txt";
  if (contentType === "image/png") return ".png";
  if (contentType === "image/jpeg") return ".jpg";
  return "";
}

function artifactMetadata(record: ArtifactRecord) {
  return {
    kind: record.kind,
    id: record.id,
    checksumSha256: record.checksumSha256,
    ...(record.runId ? { runId: record.runId } : {}),
    ...(record.testRunId ? { testRunId: record.testRunId } : {})
  };
}

function indexKey(prefix: string, id: string) {
  return posix.join(prefix, "index", `${safeSegment(id)}.json`);
}

async function bodyToString(body: unknown) {
  return new TextDecoder().decode(await bodyToBytes(body));
}

async function bodyToBytes(body: unknown): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  if (body instanceof Uint8Array) return body;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (typeof (body as { transformToByteArray?: unknown }).transformToByteArray === "function") {
    return (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();
  }
  const chunks: Uint8Array[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
  }
  return Buffer.concat(chunks);
}
