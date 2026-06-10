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
