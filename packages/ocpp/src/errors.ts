export class OcppError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OcppError";
  }
}

export class OcppProtocolError extends OcppError {
  constructor(message: string) {
    super(message);
    this.name = "OcppProtocolError";
  }
}

export class OcppTimeoutError extends OcppError {
  readonly action: string;

  constructor(action: string) {
    super(`Timed out waiting for ${action}`);
    this.name = "OcppTimeoutError";
    this.action = action;
  }
}

export class OcppCallError extends OcppError {
  readonly errorCode: string;
  readonly errorDescription: string;
  readonly errorDetails: Record<string, unknown>;

  constructor(errorCode: string, errorDescription: string, errorDetails: Record<string, unknown> = {}) {
    super(`${errorCode}: ${errorDescription}`);
    this.name = "OcppCallError";
    this.errorCode = errorCode;
    this.errorDescription = errorDescription;
    this.errorDetails = errorDetails;
  }
}

/** Thrown by a call handler when the peer should receive a CALLERROR. */
export class OcppResponseError extends OcppError {
  readonly errorCode: string;
  readonly details: Record<string, unknown>;

  constructor(errorCode: string, description: string, details: Record<string, unknown> = {}) {
    super(description);
    this.name = "OcppResponseError";
    this.errorCode = errorCode;
    this.details = details;
  }
}
