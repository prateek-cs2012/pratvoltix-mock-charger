import { validateFaultRule, type FaultRule, type SimulatorController } from "@pratvoltix/simulator-control";

export async function withFault<T>(
  controller: SimulatorController,
  rule: FaultRule,
  operation: () => Promise<T>,
): Promise<T> {
  const armed = validateFaultRule(rule);
  try {
    await controller.armFault(armed);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to arm fault";
    throw new Error(`Failed to arm fault "${armed.id}": ${message}`);
  }

  let operationError: unknown;
  let value: T | undefined;
  try {
    value = await operation();
  } catch (error) {
    operationError = error;
  }

  let cleanupError: unknown;
  try {
    const result = await controller.clearFault(armed.id);
    if (!result.cleared && !result.alreadyConsumed) {
      cleanupError = new Error(`Fault "${armed.id}" is still active after cleanup.`);
    }
  } catch (error) {
    cleanupError = error;
  }

  if (cleanupError) {
    const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : "Fault cleanup failed";
    if (operationError instanceof Error) {
      operationError.message = `${operationError.message} (fault cleanup failed: ${cleanupMessage})`;
      throw operationError;
    }
    if (operationError !== undefined) {
      throw new Error(`${String(operationError)} (fault cleanup failed: ${cleanupMessage})`);
    }
    throw new Error(`Fault cleanup failed for "${armed.id}": ${cleanupMessage}`);
  }
  if (operationError !== undefined) {
    throw operationError;
  }
  return value as T;
}
