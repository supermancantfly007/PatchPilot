import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LocalFileSystemArtifactStore,
  S3CompatibleArtifactStore,
  createArtifactStore
} from "./index";

describe("ArtifactStore", () => {
  it("stores and reads local text artifacts with metadata", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "patchpilot-artifacts-"));
    const store = new LocalFileSystemArtifactStore({ rootDir });

    try {
      const record = await store.putArtifact({
        id: "artifact_test_log_run_1",
        kind: "log",
        content: "test output",
        contentType: "text/plain",
        requirementId: "req_1",
        prdId: "prd_1",
        workItemId: "wi_1",
        runId: "run_1",
        testRunId: "test_1",
        metadata: { command: "pnpm test" }
      });
      const stored = await store.getArtifact(record.id);

      expect(record).toMatchObject({
        id: "artifact_test_log_run_1",
        kind: "log",
        storage: "local_fs",
        contentType: "text/plain",
        sizeBytes: 11,
        requirementId: "req_1",
        runId: "run_1",
        testRunId: "test_1"
      });
      expect(record.uri).toContain("/log/artifact_test_log_run_1.txt");
      expect(new TextDecoder().decode(stored.bytes)).toBe("test output");
      expect(stored.record.checksumSha256).toBe(record.checksumSha256);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("stores binary screenshot-compatible artifacts", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "patchpilot-artifacts-"));
    const store = createArtifactStore({ provider: "local_fs", localRoot: rootDir });

    try {
      const record = await store.putArtifact({
        kind: "screenshot",
        content: new Uint8Array([137, 80, 78, 71]),
        contentType: "image/png",
        runId: "run_2"
      });
      const stored = await store.getArtifact(record.id);

      expect(record.kind).toBe("screenshot");
      expect(record.uri).toContain(".png");
      expect([...stored.bytes]).toEqual([137, 80, 78, 71]);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  const runS3Integration = process.env.PATCHPILOT_ARTIFACT_S3_INTEGRATION === "1";
  const s3It = runS3Integration ? it : it.skip;

  s3It("stores and reads S3-compatible artifacts against MinIO", async () => {
    const store = new S3CompatibleArtifactStore({
      endpoint: process.env.PATCHPILOT_ARTIFACT_S3_ENDPOINT || "http://localhost:9000",
      region: process.env.PATCHPILOT_ARTIFACT_S3_REGION || "us-east-1",
      bucket: process.env.PATCHPILOT_ARTIFACT_S3_BUCKET || "patchpilot",
      accessKeyId: process.env.PATCHPILOT_ARTIFACT_S3_ACCESS_KEY_ID || "patchpilot",
      secretAccessKey: process.env.PATCHPILOT_ARTIFACT_S3_SECRET_ACCESS_KEY || "patchpilot123",
      forcePathStyle: true,
      prefix: `test-${Date.now()}`
    });

    const record = await store.putArtifact({
      kind: "test_report",
      content: JSON.stringify({ ok: true }),
      contentType: "application/json",
      runId: "run_s3"
    });
    const stored = await store.getArtifact(record.id);

    expect(record.storage).toBe("s3");
    expect(record.uri).toContain("s3://");
    expect(JSON.parse(new TextDecoder().decode(stored.bytes))).toEqual({ ok: true });
  });
});
