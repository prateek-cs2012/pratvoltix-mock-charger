import { describe, expect, it } from "vitest";
import { OcppProtocolError } from "./errors.js";
import { CALL, CALL_ERROR, CALL_RESULT, parseOcppMessage, serializeOcppMessage } from "./messages.js";

describe("parseOcppMessage", () => {
  it("parses a CALL", () => {
    const message = parseOcppMessage(
      JSON.stringify([CALL, "uid-1", "Heartbeat", {}]),
    );
    expect(message).toEqual([CALL, "uid-1", "Heartbeat", {}]);
  });

  it("parses CALLRESULT and CALLERROR frames used by 1.6 and 2.0.1", () => {
    const result = parseOcppMessage(JSON.stringify([CALL_RESULT, "uid-2", { status: "Accepted" }]));
    const error = parseOcppMessage(
      JSON.stringify([CALL_ERROR, "uid-3", "InternalError", "boom", { detail: true }]),
    );
    expect(result[0]).toBe(CALL_RESULT);
    expect(error[2]).toBe("InternalError");
  });

  it("rejects malformed frames", () => {
    expect(() => parseOcppMessage("not-json")).toThrow(OcppProtocolError);
    expect(() => parseOcppMessage(JSON.stringify([2, "uid", "Heartbeat"]))).toThrow(/CALL must contain/);
    expect(() => parseOcppMessage(JSON.stringify([2, "", "Heartbeat", {}]))).toThrow(/Unique id/);
    expect(() => parseOcppMessage(JSON.stringify([9, "uid", {}]))).toThrow(/Unsupported message type/);
  });

  it("round-trips a serialized message", () => {
    const message = [CALL, "abc", "BootNotification", { chargePointVendor: "Pratvoltix" }] as const;
    expect(parseOcppMessage(serializeOcppMessage(message))).toEqual([...message]);
  });
});
