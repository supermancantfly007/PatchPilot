import cors from "@fastify/cors";
import Fastify from "fastify";
import { z } from "zod";
import { DomainError, PatchPilotStore } from "./store";

const store = new PatchPilotStore();

const requirementInputSchema = z.object({
  rawInput: z.string().trim().min(3),
  template: z.enum(["feature", "bug", "ui", "document"])
});

const clarificationSchema = z.object({
  answers: z.record(z.string(), z.string()).default({})
});

const acceptanceSchema = z.object({
  status: z.enum(["accepted", "rejected"]),
  reason: z.string().optional()
}).superRefine((input, ctx) => {
  if (input.status === "rejected" && !input.reason?.trim()) {
    ctx.addIssue({
      code: "custom",
      message: "Reason is required when rejecting a run",
      path: ["reason"]
    });
  }
});

export async function buildServer() {
  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });

  app.get("/health", async () => ({ ok: true, service: "patchpilot-api" }));

  app.get("/api/snapshot", async () => store.getSnapshot());

  app.post("/api/requirements", async (request, reply) => {
    const input = requirementInputSchema.parse(request.body);
    const requirement = await store.createRequirement(input);
    return reply.code(201).send(requirement);
  });

  app.get("/api/requirements/:id", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    return store.getRequirementBundle(id);
  });

  app.post("/api/requirements/:id/clarification-answer", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const input = clarificationSchema.parse(request.body);
    return store.answerClarification(id, input.answers);
  });

  app.post("/api/prds/:id/approve", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    return store.approvePrd(id);
  });

  app.post("/api/work-items/:id/start", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const run = await store.startRun(id);
    return reply.code(201).send(run);
  });

  app.get("/api/runs/:id", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    return store.getRun(id);
  });

  app.get("/api/runs/:id/events", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*"
    });

    let lastEventCount = -1;
    const send = async () => {
      try {
        const run = await store.getRun(id);
        if (run.events.length !== lastEventCount) {
          lastEventCount = run.events.length;
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

  app.post("/api/acceptance/:runId", async (request) => {
    const { runId } = z.object({ runId: z.string() }).parse(request.params);
    const input = acceptanceSchema.parse(request.body);
    return store.acceptRun(runId, input.status, input.reason);
  });

  app.setErrorHandler((error, _request, reply) => {
    const message = error instanceof Error ? error.message : String(error);
    let statusCode = 500;
    if (error instanceof z.ZodError) statusCode = 400;
    if (error instanceof DomainError && error.code === "NOT_FOUND") statusCode = 404;
    if (error instanceof DomainError && error.code === "INVALID_STATE") statusCode = 409;
    reply.code(statusCode).send({
      error:
        statusCode === 400
          ? "Bad Request"
          : statusCode === 404
            ? "Not Found"
            : statusCode === 409
              ? "Conflict"
              : "Internal Server Error",
      message
    });
  });

  return app;
}

const port = Number(process.env.PORT || 4000);

if (process.env.NODE_ENV !== "test") {
  const app = await buildServer();
  await app.listen({ port, host: "0.0.0.0" });
}
