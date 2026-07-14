export type StatusCounts = {
  total: number;
  pass: number;
  fail: number;
  na: number;
  blocked: number;
  pending: number;
};

export type GateOptions = {
  /** Statuses that violate the gate; default ["fail"]. */
  failOn: ("fail" | "blocked")[];
  /** Minimum executed percentage (0–100); undefined = no requirement. */
  minExecuted?: number;
};

export type GateVerdict = {
  passed: boolean;
  reasons: string[];
  executedPercent: number;
};

export function parseFailOn(value: string): GateOptions["failOn"] {
  const parts = value.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const valid = ["fail", "blocked"];
  for (const p of parts) {
    if (!valid.includes(p)) throw new Error(`Invalid --fail-on value '${p}' (allowed: fail, blocked)`);
  }
  return parts as GateOptions["failOn"];
}

export function executedPercent(counts: StatusCounts): number {
  if (counts.total === 0) return 0;
  return Math.round(((counts.total - counts.pending) / counts.total) * 1000) / 10;
}

export function evaluateGate(counts: StatusCounts, options: GateOptions): GateVerdict {
  const reasons: string[] = [];
  for (const status of options.failOn) {
    if (counts[status] > 0) {
      reasons.push(`${counts[status]} case(s) with status '${status}'`);
    }
  }
  const pct = executedPercent(counts);
  if (options.minExecuted !== undefined && pct < options.minExecuted) {
    reasons.push(`executed ${pct}% < required ${options.minExecuted}%`);
  }
  return { passed: reasons.length === 0, reasons, executedPercent: pct };
}
