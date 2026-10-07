import type { FaultRule, FaultSummary, ReconnectStormConfig } from "./faults.js";

export { ControlProtocolError } from "./errors.js";
export {
  MAX_ACTIVE_FAULTS,
  MAX_DELAY_MS,
  readClearFaultResult,
  readFaultSummaries,
  summarizeFault,
  validateFaultRule,
  validateReconnectStormConfig,
  type FaultEffect,
  type FaultRule,
  type FaultSummary,
  type ReconnectStormConfig,
} from "./faults.js";
export {
  CONTROL_ACTIONS,
  CONTROL_PATH,
  CONTROL_PROTOCOL_VERSION,
  CONTROL_SUBPROTOCOL,
  SIMULATOR_CAPABILITY,
  ControlChannel,
  parseControlMessage,
  validateHello,
  type ControlAction,
  type ControlChannelOptions,
  type ControlErrorBody,
  type ControlRequest,
  type ControlResponse,
  type HelloPayload,
} from "./protocol.js";
export {
  TargetError,
  publicTargetSnapshot,
  resolveCsmsTarget,
  safeConnectionError,
  sanitizeCsmsTemplate,
  sanitizeCsmsUrl,
  type CsmsTargetRequest,
  type CsmsTargetSnapshot,
  type ResolvedCsmsTarget,
} from "./target.js";

export interface ClearFaultResult {
  cleared: boolean;
  alreadyConsumed: boolean;
}

export interface SimulatorController {
  armFault(rule: FaultRule): Promise<void>;
  clearFault(id: string): Promise<ClearFaultResult>;
  clearAllFaults(): Promise<void>;
  listFaults(): Promise<FaultSummary[]>;
}

export interface ReconnectStormController {
  setReconnectStorm(config: ReconnectStormConfig): Promise<void>;
  clearReconnectStorm(): Promise<void>;
}

export interface LocalAuthEntry {
  idTag: string;
  status: string;
  expiryDate?: string;
}

export interface OfflineTransactionEntry {
  localId: number;
  connectorId: number;
  idTag: string;
  meterStart: number;
  meterStop: number;
  startTimestamp: string;
  stopTimestamp: string;
  reason: string;
}

export interface ExtendedSimulatorController {
  setOutboundDelay(delayMs: number): Promise<void>;
  clearOutboundDelay(): Promise<void>;
  setLocalAuthList(entries: LocalAuthEntry[]): Promise<void>;
  getLocalAuthList(): Promise<LocalAuthEntry[]>;
  queueOfflineTransaction(tx: OfflineTransactionEntry): Promise<void>;
  uploadOfflineTransactions(): Promise<number>;
}
