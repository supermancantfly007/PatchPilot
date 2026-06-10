import type { TemporalCanaryActivityInput, TemporalCanaryActivityResult } from "./types";

export interface TemporalCanaryActivityStore {
  complete(input: TemporalCanaryActivityInput): Promise<TemporalCanaryActivityResult>;
}

export class InMemoryTemporalCanaryActivityStore implements TemporalCanaryActivityStore {
  readonly completed = new Map<string, TemporalCanaryActivityResult>();

  async complete(input: TemporalCanaryActivityInput): Promise<TemporalCanaryActivityResult> {
    const existing = this.completed.get(input.idempotencyKey);
    if (existing) return existing;

    const result: TemporalCanaryActivityResult = {
      workflowId: input.workflowId,
      idempotencyKey: input.idempotencyKey,
      label: input.label,
      ...(input.signal ? { signal: input.signal } : {}),
      completedAt: new Date().toISOString()
    };
    this.completed.set(input.idempotencyKey, result);
    return result;
  }
}

export function createTemporalCanaryActivities(store: TemporalCanaryActivityStore = new InMemoryTemporalCanaryActivityStore()) {
  return {
    completeCanaryActivity(input: TemporalCanaryActivityInput) {
      return store.complete(input);
    }
  };
}

export type TemporalCanaryActivities = ReturnType<typeof createTemporalCanaryActivities>;
