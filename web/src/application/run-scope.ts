/** Accept a result only when it belongs to the requested Run and its request is still current. */
export function isCurrentRunResponse(input: {
  expectedRunId: string;
  responseRunId: unknown;
  requestSequence: number;
  currentSequence: number;
  requestActive: boolean;
}): boolean {
  return input.requestActive
    && input.requestSequence === input.currentSequence
    && input.responseRunId === input.expectedRunId;
}
