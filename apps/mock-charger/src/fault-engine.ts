import {
  MAX_ACTIVE_FAULTS,
  summarizeFault,
  type FaultEffect,
  type FaultRule,
  type FaultSummary,
  ControlProtocolError,
} from "@pratvoltix/simulator-control";

interface ActiveFault {
  rule: FaultRule;
  seen: number;
}

export class FaultEngine {
  private readonly rules: ActiveFault[] = [];

  arm(rule: FaultRule): void {
    if (this.rules.some((active) => active.rule.id === rule.id)) {
      throw new ControlProtocolError("duplicate-rule", `Fault "${rule.id}" is already armed.`);
    }
    if (this.rules.length >= MAX_ACTIVE_FAULTS) {
      throw new ControlProtocolError("too-many-rules", `At most ${MAX_ACTIVE_FAULTS} faults can be armed.`);
    }
    this.rules.push({
      rule: {
        ...rule,
        match: { ...rule.match },
        effect: cloneEffect(rule.effect),
      },
      seen: 0,
    });
  }

  clear(id: string): { cleared: boolean; alreadyConsumed: boolean } {
    const index = this.rules.findIndex((active) => active.rule.id === id);
    if (index < 0) {
      return { cleared: false, alreadyConsumed: true };
    }
    this.rules.splice(index, 1);
    return { cleared: true, alreadyConsumed: false };
  }

  clearAll(): number {
    const count = this.rules.length;
    this.rules.length = 0;
    return count;
  }

  list(): FaultSummary[] {
    return this.rules.map((active) => summarizeFault(active.rule));
  }

  /**
   * Rules run in arm order. A matching call increments that rule's occurrence count.
   * The first rule whose count reaches its occurrence is consumed and returned.
   */
  take(action: string): FaultEffect | undefined {
    for (let index = 0; index < this.rules.length; index += 1) {
      const active = this.rules[index];
      if (!active || active.rule.match.action !== action) {
        continue;
      }
      active.seen += 1;
      if (active.seen < active.rule.match.occurrence) {
        continue;
      }
      this.rules.splice(index, 1);
      return active.rule.effect;
    }
    return undefined;
  }
}

function cloneEffect(effect: FaultEffect): FaultEffect {
  if (effect.type === "call-result") {
    return { type: "call-result", payload: { ...effect.payload } };
  }
  if (effect.type === "call-error") {
    return {
      type: "call-error",
      errorCode: effect.errorCode,
      description: effect.description,
      ...(effect.details ? { details: { ...effect.details } } : {}),
    };
  }
  if (effect.type === "delay") {
    return { type: "delay", delayMs: effect.delayMs };
  }
  return effect.type === "disconnect" ? { type: "disconnect" } : { type: "suppress-response" };
}
