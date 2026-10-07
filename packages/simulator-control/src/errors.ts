export class ControlProtocolError extends Error {
  readonly code: string;
  readonly requestId: string | undefined;

  constructor(code: string, message: string, requestId?: string) {
    super(message);
    this.name = "ControlProtocolError";
    this.code = code;
    this.requestId = requestId;
  }
}
