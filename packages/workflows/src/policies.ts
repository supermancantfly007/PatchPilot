export const temporalCanaryActivityRetryPolicy = {
  initialInterval: "200 milliseconds",
  backoffCoefficient: 2,
  maximumInterval: "2 seconds",
  maximumAttempts: 3
} as const;

export const temporalCanaryActivityOptions = {
  startToCloseTimeout: "10 seconds",
  retry: temporalCanaryActivityRetryPolicy
} as const;

export const approvalActivityRetryPolicy = {
  initialInterval: "500 milliseconds",
  backoffCoefficient: 2,
  maximumInterval: "5 seconds",
  maximumAttempts: 5
} as const;

export const approvalActivityOptions = {
  startToCloseTimeout: "15 seconds",
  retry: approvalActivityRetryPolicy
} as const;

export const requirementIntakeActivityRetryPolicy = {
  initialInterval: "500 milliseconds",
  backoffCoefficient: 2,
  maximumInterval: "5 seconds",
  maximumAttempts: 5
} as const;

export const requirementIntakeActivityOptions = {
  startToCloseTimeout: "15 seconds",
  retry: requirementIntakeActivityRetryPolicy
} as const;

export const workItemPlanningActivityRetryPolicy = {
  initialInterval: "500 milliseconds",
  backoffCoefficient: 2,
  maximumInterval: "5 seconds",
  maximumAttempts: 5
} as const;

export const workItemPlanningActivityOptions = {
  startToCloseTimeout: "15 seconds",
  retry: workItemPlanningActivityRetryPolicy
} as const;

export const workItemExecutionActivityRetryPolicy = {
  initialInterval: "500 milliseconds",
  backoffCoefficient: 2,
  maximumInterval: "10 seconds",
  maximumAttempts: 5
} as const;

export const workItemExecutionActivityOptions = {
  startToCloseTimeout: "30 seconds",
  retry: workItemExecutionActivityRetryPolicy
} as const;

export const defectReproductionActivityRetryPolicy = {
  initialInterval: "500 milliseconds",
  backoffCoefficient: 2,
  maximumInterval: "10 seconds",
  maximumAttempts: 5
} as const;

export const defectReproductionActivityOptions = {
  startToCloseTimeout: "30 seconds",
  retry: defectReproductionActivityRetryPolicy
} as const;
