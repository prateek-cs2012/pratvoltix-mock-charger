import { safeConnectionError } from "@pratvoltix/simulator-control";

export async function executeExternalRun(input: {
  connect(): Promise<{ subprotocol: string }>;
  run(subprotocol: string): Promise<void>;
  restore(): Promise<void>;
}): Promise<{ negotiatedSubprotocol: string | null; error?: string }> {
  let negotiatedSubprotocol: string | null = null;
  let error: string | undefined;
  try {
    const connected = await input.connect();
    if (connected.subprotocol !== "ocpp1.6") {
      error = "Negotiated subprotocol was not ocpp1.6.";
      return { negotiatedSubprotocol: null, error };
    }
    negotiatedSubprotocol = connected.subprotocol;
    await input.run(negotiatedSubprotocol);
    return { negotiatedSubprotocol };
  } catch (caught) {
    error = safeConnectionError(caught);
    return { negotiatedSubprotocol, error };
  } finally {
    try {
      await input.restore();
    } catch {
      // The run result stays the connect or case outcome. Restore is still attempted.
    }
  }
}
