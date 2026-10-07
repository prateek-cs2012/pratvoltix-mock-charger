/** OCPP 1.6-J action names. Framing is shared with 2.0.1; these names are version-specific. */
export const Ocpp16Action = {
  Authorize: "Authorize",
  BootNotification: "BootNotification",
  DataTransfer: "DataTransfer",
  DiagnosticsStatusNotification: "DiagnosticsStatusNotification",
  FirmwareStatusNotification: "FirmwareStatusNotification",
  Heartbeat: "Heartbeat",
  MeterValues: "MeterValues",
  StartTransaction: "StartTransaction",
  StatusNotification: "StatusNotification",
  StopTransaction: "StopTransaction",
  CancelReservation: "CancelReservation",
  ChangeAvailability: "ChangeAvailability",
  ChangeConfiguration: "ChangeConfiguration",
  ClearCache: "ClearCache",
  ClearChargingProfile: "ClearChargingProfile",
  GetCompositeSchedule: "GetCompositeSchedule",
  GetConfiguration: "GetConfiguration",
  GetDiagnostics: "GetDiagnostics",
  GetLocalListVersion: "GetLocalListVersion",
  RemoteStartTransaction: "RemoteStartTransaction",
  RemoteStopTransaction: "RemoteStopTransaction",
  ReserveNow: "ReserveNow",
  Reset: "Reset",
  SendLocalList: "SendLocalList",
  SetChargingProfile: "SetChargingProfile",
  TriggerMessage: "TriggerMessage",
  UnlockConnector: "UnlockConnector",
  UpdateFirmware: "UpdateFirmware",
} as const;

export type Ocpp16ActionName = (typeof Ocpp16Action)[keyof typeof Ocpp16Action];

/** OCPP 2.0.1 action names used by a CSMS test lab. RPC framing matches 1.6. */
export const Ocpp201Action = {
  Authorize: "Authorize",
  BootNotification: "BootNotification",
  Heartbeat: "Heartbeat",
  StatusNotification: "StatusNotification",
  TransactionEvent: "TransactionEvent",
  MeterValues: "MeterValues",
  RequestStartTransaction: "RequestStartTransaction",
  RequestStopTransaction: "RequestStopTransaction",
  Reset: "Reset",
  GetVariables: "GetVariables",
  SetVariables: "SetVariables",
  TriggerMessage: "TriggerMessage",
  DataTransfer: "DataTransfer",
  FirmwareStatusNotification: "FirmwareStatusNotification",
  LogStatusNotification: "LogStatusNotification",
  NotifyEvent: "NotifyEvent",
  ClearedChargingLimit: "ClearedChargingLimit",
} as const;

export type Ocpp201ActionName = (typeof Ocpp201Action)[keyof typeof Ocpp201Action];

export const Ocpp16ErrorCode = {
  NotImplemented: "NotImplemented",
  NotSupported: "NotSupported",
  InternalError: "InternalError",
  ProtocolError: "ProtocolError",
  SecurityError: "SecurityError",
  FormationViolation: "FormationViolation",
  PropertyConstraintViolation: "PropertyConstraintViolation",
  OccurrenceConstraintViolation: "OccurrenceConstraintViolation",
  TypeConstraintViolation: "TypeConstraintViolation",
  GenericError: "GenericError",
} as const;
