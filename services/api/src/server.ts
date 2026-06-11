import cors from "@fastify/cors";
import {
  acceptanceSchema,
  approvalDecisionSchema,
  apiRoute,
  bugInputSchema,
  claimSchema,
  clarificationSchema,
  clarificationTurnSchema,
  createApprovalSchema,
  externalIssueLinkSchema,
  externalIssueStatusUpdateSchema,
  releaseWorkItemSchema,
  requirementInputSchema,
  startRunSchema
} from "@patchpilot/contracts";
import {
  PatchPilotAuthError,
  assertCanApprovePrd,
  assertCanDecideApproval,
  assertCanExportAuditPackage,
  assertCanRequestApproval,
  assertCanStartCapabilities,
  parsePatchPilotAuthHeaders,
  type PatchPilotAuthContext,
  patchPilotAuthRoleHeader,
  patchPilotAuthUserHeader,
  type PatchPilotHeaderMap
} from "@patchpilot/security";
import {
  getTelemetry,
  prometheusContentType,
  renderPrometheusMetrics,
  shutdownTelemetry,
  type PatchPilotTelemetry
} from "@patchpilot/telemetry";
import Fastify from "fastify";
import { z } from "zod";
import { DomainError, PatchPilotStore } from "./store";

declare module "fastify" {
  interface FastifyRequest {
    auth?: PatchPilotAuthContext;
  }
}

export async function buildServer(options: { store?: PatchPilotStore; telemetry?: PatchPilotTelemetry } = {}) {
  const app = Fastify({ logger: true });
  const telemetry = options.telemetry ?? getTelemetry({ serviceName: "patchpilot-api" });
  const store = options.store ?? new PatchPilotStore({ telemetry });
  await app.register(cors, { origin: true });
  app.addHook("preHandler", async (request) => {
    request.auth = parsePatchPilotAuthHeaders(request.headers as PatchPilotHeaderMap);
  });
  app.addHook("onClose", async () => {
    await store.close();
    if (options.telemetry) await telemetry.shutdown();
    else await shutdownTelemetry();
  });

  app.get(apiRoute("health"), async () => ({ ok: true, service: "patchpilot-api" }));

  app.get(apiRoute("metrics"), async (_request, reply) => {
    const snapshot = await store.getSnapshot();
    return reply.type(prometheusContentType).send(renderPrometheusMetrics(snapshot));
  });

  app.get(apiRoute("getConfig"), async () => store.getRuntimeConfig());

  app.get(apiRoute("snapshot"), async () => store.getSnapshot());

  app.get(apiRoute("verifyAudit"), async () => store.verifyAuditChain());

  app.get(apiRoute("exportPrdAuditPackage"), async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    assertCanExportAuditPackage(request.auth);
    return store.exportPrdAuditPackage(id, { actorId: request.auth?.userId });
  });

  app.get(apiRoute("agents"), async () => store.getAgents());

  app.post(apiRoute("createRequirement"), async (request, reply) => {
    const input = requirementInputSchema.parse(request.body);
    const requirement = await store.createRequirement(input);
    return reply.code(201).send(requirement);
  });

  app.get(apiRoute("getRequirement"), async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    return store.getRequirementBundle(id);
  });

  app.post(apiRoute("answerClarification"), async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const input = clarificationSchema.parse(request.body);
    return store.answerClarification(id, input.answers);
  });

  app.post(apiRoute("addClarificationTurn"), async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const input = clarificationTurnSchema.parse(request.body);
    return store.addClarificationTurn(id, input.message);
  });

  app.post(apiRoute("createPrd"), async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    return store.createPrdFromClarification(id);
  });

  app.post(apiRoute("approvePrd"), async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    assertCanApprovePrd(request.auth);
    return store.approvePrd(id, request.auth ? { actor: request.auth.userId } : {});
  });

  app.post(apiRoute("startTeam"), async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const input = startRunSchema.parse(request.body);
    assertCanApprovePrd(request.auth);
    const workItems = await store.previewWorkItemsForPrd(id);
    for (const workItem of workItems) {
      assertCanStartCapabilities(request.auth, workItem.requiredCapabilities);
    }
    const result = await store.startTeam(id, input.runner, request.auth ? { actor: request.auth.userId } : {});
    return reply.code(201).send(result);
  });

  app.post(apiRoute("acceptTeam"), async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const input = acceptanceSchema.parse(request.body);
    return store.acceptPrdRuns(id, input.status, input.reason);
  });

  app.post(apiRoute("createApproval"), async (request, reply) => {
    const input = createApprovalSchema.parse(request.body);
    assertCanRequestApproval(request.auth, input);
    const approval = await store.createApproval({ ...input, requestedBy: request.auth?.userId ?? input.requestedBy });
    return reply.code(201).send(approval);
  });

  app.post(apiRoute("approveApproval"), async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const input = approvalDecisionSchema.parse(request.body);
    const approval = await store.getApproval(id);
    assertCanDecideApproval(request.auth, approval);
    return store.approveApproval(id, { ...input, decidedBy: request.auth?.userId ?? input.decidedBy });
  });

  app.post(apiRoute("denyApproval"), async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const input = approvalDecisionSchema.parse(request.body);
    const approval = await store.getApproval(id);
    assertCanDecideApproval(request.auth, approval);
    return store.denyApproval(id, { ...input, decidedBy: request.auth?.userId ?? input.decidedBy });
  });

  app.post(apiRoute("startWorkItem"), async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const input = startRunSchema.parse(request.body);
    const workItem = await store.getWorkItem(id);
    assertCanStartCapabilities(request.auth, workItem.requiredCapabilities);
    const run = await store.startRun(id, input.runner, { claimToken: input.claimToken });
    return reply.code(201).send(run);
  });

  app.post(apiRoute("claimWorkItem"), async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const input = claimSchema.parse(request.body);
    return store.claimWorkItem(id, input.agentId, { leaseDurationMs: input.leaseDurationMs });
  });

  app.post(apiRoute("releaseWorkItem"), async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const input = releaseWorkItemSchema.parse(request.body);
    return store.releaseWorkItem(id, { claimToken: input.claimToken });
  });

  app.post(apiRoute("createBug"), async (request, reply) => {
    const input = bugInputSchema.parse(request.body);
    const result = await store.createBug(input);
    return reply.code(201).send(result);
  });

  app.post(apiRoute("linkExternalIssue"), async (request, reply) => {
    const input = externalIssueLinkSchema.parse(request.body);
    const result = await store.registerExternalIssueLink(input);
    return reply.code(201).send(result);
  });

  app.post(apiRoute("updateExternalIssueStatus"), async (request) => {
    const input = externalIssueStatusUpdateSchema.parse(request.body);
    return store.ingestExternalIssueStatus(input);
  });

  app.get(apiRoute("getRun"), async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    return store.getRun(id);
  });

  app.get(apiRoute("streamRunEvents"), async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*"
    });

    let lastEventCount = -1;
    let lastStatus: string | undefined;
    const send = async () => {
      try {
        const run = await store.getRun(id);
        if (run.events.length !== lastEventCount || run.status !== lastStatus) {
          lastEventCount = run.events.length;
          lastStatus = run.status;
          reply.raw.write(`data: ${JSON.stringify(run)}\n\n`);
        }
        if (["succeeded", "failed", "cancelled"].includes(run.status)) {
          clearInterval(interval);
          reply.raw.end();
        }
      } catch (error) {
        reply.raw.write(`event: error\ndata: ${JSON.stringify({ message: String(error) })}\n\n`);
        clearInterval(interval);
        reply.raw.end();
      }
    };

    const interval = setInterval(() => void send(), 500);
    request.raw.on("close", () => clearInterval(interval));
    await send();
  });

  app.post(apiRoute("acceptRun"), async (request) => {
    const { runId } = z.object({ runId: z.string() }).parse(request.params);
    const input = acceptanceSchema.parse(request.body);
    return store.acceptRun(runId, input.status, input.reason);
  });

  app.setErrorHandler((error, _request, reply) => {
    const message = error instanceof Error ? error.message : String(error);
    let statusCode = 500;
    if (error instanceof z.ZodError) statusCode = 400;
    if (error instanceof PatchPilotAuthError) statusCode = error.statusCode;
    if (error instanceof DomainError && error.code === "NOT_FOUND") statusCode = 404;
    if (error instanceof DomainError && error.code === "INVALID_STATE") statusCode = 409;
    reply.code(statusCode).send({
      error:
        statusCode === 400
          ? "Bad Request"
          : statusCode === 401
            ? "Unauthorized"
            : statusCode === 403
              ? "Forbidden"
          : statusCode === 404
            ? "Not Found"
            : statusCode === 409
              ? "Conflict"
              : "Internal Server Error",
      message,
      ...(error instanceof PatchPilotAuthError
        ? { code: error.code, requiredHeaders: [patchPilotAuthUserHeader, patchPilotAuthRoleHeader] }
        : {})
    });
  });

  return app;
}

const port = Number(process.env.PORT || 4000);

if (process.env.NODE_ENV !== "test") {
  const app = await buildServer();
  await app.listen({ port, host: "0.0.0.0" });
}
