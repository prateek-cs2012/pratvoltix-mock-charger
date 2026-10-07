import { OcppProtocolError } from "./errors.js";

export const CALL = 2;
export const CALL_RESULT = 3;
export const CALL_ERROR = 4;

export type MessageTypeId = typeof CALL | typeof CALL_RESULT | typeof CALL_ERROR;

export type OcppCall = readonly [typeof CALL, string, string, Record<string, unknown>];
export type OcppCallResult = readonly [typeof CALL_RESULT, string, Record<string, unknown>];
export type OcppCallErrorMessage = readonly [typeof CALL_ERROR, string, string, string, Record<string, unknown>];
export type OcppMessage = OcppCall | OcppCallResult | OcppCallErrorMessage;

export type OcppVersion = "1.6" | "2.0.1";

export const OCPP_SUBPROTOCOLS: Record<OcppVersion, string> = {
  "1.6": "ocpp1.6",
  "2.0.1": "ocpp2.0.1",
};

const MAX_UNIQUE_ID_LENGTH = 36;

function isPayload(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readUniqueId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_UNIQUE_ID_LENGTH) {
    throw new OcppProtocolError("Unique id must be a non-empty string of at most 36 characters");
  }
  return value;
}

export function parseOcppMessage(raw: string): OcppMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new OcppProtocolError("Message is not valid JSON");
  }

  if (!Array.isArray(parsed) || parsed.length < 3) {
    throw new OcppProtocolError("OCPP message must be an array of at least 3 elements");
  }

  const messageType = parsed[0];
  const uniqueId = readUniqueId(parsed[1]);

  if (messageType === CALL) {
    if (parsed.length !== 4) {
      throw new OcppProtocolError("CALL must contain message type, unique id, action, and payload");
    }
    const action = parsed[2];
    const payload = parsed[3];
    if (typeof action !== "string" || action.length === 0) {
      throw new OcppProtocolError("CALL action must be a non-empty string");
    }
    if (!isPayload(payload)) {
      throw new OcppProtocolError("CALL payload must be a JSON object");
    }
    return [CALL, uniqueId, action, payload];
  }

  if (messageType === CALL_RESULT) {
    if (parsed.length !== 3) {
      throw new OcppProtocolError("CALLRESULT must contain message type, unique id, and payload");
    }
    const payload = parsed[2];
    if (!isPayload(payload)) {
      throw new OcppProtocolError("CALLRESULT payload must be a JSON object");
    }
    return [CALL_RESULT, uniqueId, payload];
  }

  if (messageType === CALL_ERROR) {
    if (parsed.length !== 5) {
      throw new OcppProtocolError("CALLERROR must contain message type, unique id, error code, description, and details");
    }
    const errorCode = parsed[2];
    const description = parsed[3];
    const details = parsed[4];
    if (typeof errorCode !== "string" || errorCode.length === 0) {
      throw new OcppProtocolError("CALLERROR error code must be a non-empty string");
    }
    if (typeof description !== "string") {
      throw new OcppProtocolError("CALLERROR description must be a string");
    }
    if (!isPayload(details)) {
      throw new OcppProtocolError("CALLERROR details must be a JSON object");
    }
    return [CALL_ERROR, uniqueId, errorCode, description, details];
  }

  throw new OcppProtocolError(`Unsupported message type id ${String(messageType)}`);
}

export function serializeOcppMessage(message: OcppMessage): string {
  return JSON.stringify(message);
}

export function isOcppCall(message: OcppMessage): message is OcppCall {
  return message[0] === CALL;
}
