import type { History, IsolationMode, JsonValue, ReadOp, Transaction, TransactionStatus, WriteOp } from "./types";
import { formatJsonValue } from "./format";

const INITIAL_TRANSACTION_ID = "T0";

export class HistoryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HistoryValidationError";
  }
}

export interface NormalizedHistory {
  history: History;
  committed: Transaction[];
  ignored: Transaction[];
  order: Map<string, number>;
  txById: Map<string, Transaction>;
  notes: string[];
}

type VersionOrderMode = "explicit-commit" | "fixture-order";

interface VersionOrdering {
  mode: VersionOrderMode;
  notes: string[];
}

export function normalizeHistory(history: History): NormalizedHistory {
  if (!isRecord(history)) {
    throw new HistoryValidationError("history must be an object");
  }
  if (!isNonEmptyString(history.name) || !isNonEmptyString(history.description) || !Array.isArray(history.transactions)) {
    throw new HistoryValidationError("history requires name, description, and transactions[]");
  }
  if (history.mode !== undefined && !isIsolationMode(history.mode)) {
    throw new HistoryValidationError(`history mode must be serializable or strict-serializable`);
  }

  const txById = new Map<string, Transaction>();
  history.transactions.forEach((tx, index) => {
    if (!isRecord(tx) || !isNonEmptyString(tx.id) || !Array.isArray(tx.ops)) {
      throw new HistoryValidationError(`transaction at index ${index} requires id and ops[]`);
    }
    if (tx.label !== undefined && typeof tx.label !== "string") {
      throw new HistoryValidationError(`${tx.id} label must be a string`);
    }
    if (tx.process !== undefined && typeof tx.process !== "string") {
      throw new HistoryValidationError(`${tx.id} process must be a string`);
    }
    if (tx.status !== undefined && !isTransactionStatus(tx.status)) {
      throw new HistoryValidationError(`${tx.id} status must be committed or aborted`);
    }
    validateTime(tx);
    if (txById.has(tx.id)) {
      throw new HistoryValidationError(`duplicate transaction id ${tx.id}`);
    }
    txById.set(tx.id, tx);
    tx.ops.forEach((op, opIndex) => validateOp(tx.id, op, opIndex));
    rejectRepeatedWrites(tx);
  });

  const ordering = validateCommittedOrdering(history.transactions);
  const fixtureIndex = new Map(history.transactions.map((tx, index) => [tx.id, index]));
  const committed = history.transactions
    .filter((tx) => (tx.status ?? "committed") === "committed")
    .slice()
    .sort((a, b) => compareCommittedVersionOrder(a, b, ordering.mode, fixtureIndex));
  const ignored = history.transactions.filter((tx) => (tx.status ?? "committed") !== "committed");
  const order = new Map<string, number>();
  committed.forEach((tx, index) => order.set(tx.id, index));

  for (const tx of committed) {
    for (const op of tx.ops) {
      if (op.type !== "read") continue;
      if (!txById.has(op.from)) {
        throw new HistoryValidationError(`${tx.id} reads ${op.key} from unknown transaction ${op.from}`);
      }
      const writer = txById.get(op.from);
      if (!writer || (writer.status ?? "committed") !== "committed") {
        throw new HistoryValidationError(`${tx.id} reads ${op.key} from non-committed transaction ${op.from}`);
      }
      const write = writer.ops.find((writerOp) => writerOp.type === "write" && writerOp.key === op.key);
      if (!write || write.type !== "write") {
        throw new HistoryValidationError(`${tx.id} reads ${op.key} from ${op.from}, but ${op.from} does not write that key`);
      }
      if (!jsonEqual(write.value, op.value)) {
        throw new HistoryValidationError(
          `${tx.id} reads ${op.key}=${formatJsonValue(op.value)} from ${op.from}, but ${op.from} wrote ${formatJsonValue(write.value)}`,
        );
      }
    }
  }

  const notes = [
    ...ordering.notes,
    ...ignored.map((tx) => `${tx.id} is ${tx.status}; it is ignored when building committed-version order.`),
  ];
  return { history, committed, ignored, order, txById, notes };
}

function validateOp(txId: string, op: ReadOp | WriteOp, opIndex: number): void {
  if (!isRecord(op)) {
    throw new HistoryValidationError(`${txId} op ${opIndex} must be an object`);
  }
  if (op.type !== "read" && op.type !== "write") {
    throw new HistoryValidationError(`${txId} op ${opIndex} has invalid type`);
  }
  if (!isNonEmptyString(op.key)) {
    throw new HistoryValidationError(`${txId} op ${opIndex} requires key`);
  }
  if (!("value" in op) || !isJsonValue(op.value)) {
    throw new HistoryValidationError(`${txId} ${op.type} ${op.key} requires a JSON value`);
  }
  if (op.type === "read" && !isNonEmptyString(op.from)) {
    throw new HistoryValidationError(`${txId} read ${op.key} requires from transaction id`);
  }
  if (op.type === "read") {
    void formatJsonValue(op.value);
  }
}

function compareCommittedVersionOrder(
  left: Transaction,
  right: Transaction,
  mode: VersionOrderMode,
  fixtureIndex: Map<string, number>,
): number {
  if (isInitialSeed(left) && !isInitialSeed(right)) return -1;
  if (!isInitialSeed(left) && isInitialSeed(right)) return 1;
  if (mode === "explicit-commit") {
    return (left.commit ?? 0) - (right.commit ?? 0) || (fixtureIndex.get(left.id) ?? 0) - (fixtureIndex.get(right.id) ?? 0);
  }
  return (fixtureIndex.get(left.id) ?? 0) - (fixtureIndex.get(right.id) ?? 0);
}

function validateCommittedOrdering(transactions: Transaction[]): VersionOrdering {
  const committed = transactions.filter((tx) => (tx.status ?? "committed") === "committed");
  const nonInitial = committed.filter((tx) => !isInitialSeed(tx));
  const withCommit = nonInitial.filter((tx) => tx.commit !== undefined);
  if (withCommit.length > 0 && withCommit.length < nonInitial.length) {
    const missing = nonInitial.filter((tx) => tx.commit === undefined).map((tx) => tx.id).join(", ");
    throw new HistoryValidationError(
      `committed non-initial transactions must either all include commit timestamps or all omit them; missing commit on ${missing}`,
    );
  }
  const commitTimes = new Map<number, string>();
  for (const tx of withCommit) {
    const existing = commitTimes.get(tx.commit ?? 0);
    if (existing) {
      throw new HistoryValidationError(`${tx.id} and ${existing} share commit time ${tx.commit}; non-initial version order must be unambiguous`);
    }
    commitTimes.set(tx.commit ?? 0, tx.id);
  }
  if (withCommit.length === nonInitial.length && nonInitial.length > 0) {
    return {
      mode: "explicit-commit",
      notes: [`Version order uses commit timestamps for committed non-initial transactions; ${INITIAL_TRANSACTION_ID} is treated as the initial seed when present.`],
    };
  }
  return {
    mode: "fixture-order",
    notes: [`Version order uses fixture order for committed non-initial transactions; ${INITIAL_TRANSACTION_ID} is treated as the initial seed when present.`],
  };
}

function validateTime(tx: Transaction): void {
  if (tx.begin !== undefined && !Number.isFinite(tx.begin)) {
    throw new HistoryValidationError(`${tx.id} begin must be a finite number`);
  }
  if (tx.commit !== undefined && !Number.isFinite(tx.commit)) {
    throw new HistoryValidationError(`${tx.id} commit must be a finite number`);
  }
  if (tx.begin !== undefined && tx.commit !== undefined && tx.begin > tx.commit) {
    throw new HistoryValidationError(`${tx.id} begin ${tx.begin} is after commit ${tx.commit}`);
  }
}

function isInitialSeed(tx: Transaction): boolean {
  return tx.id === INITIAL_TRANSACTION_ID;
}

function rejectRepeatedWrites(tx: Transaction): void {
  const written = new Set<string>();
  for (const op of tx.ops) {
    if (op.type !== "write") continue;
    if (written.has(op.key)) {
      throw new HistoryValidationError(`${tx.id} writes ${op.key} more than once; v1 requires one version per key per transaction`);
    }
    written.add(op.key);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isTransactionStatus(value: unknown): value is TransactionStatus {
  return value === "committed" || value === "aborted";
}

function isIsolationMode(value: unknown): value is IsolationMode {
  return value === "serializable" || value === "strict-serializable";
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  const valueType = typeof value;
  if (valueType === "string" || valueType === "boolean") return true;
  if (valueType === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (isRecord(value)) return Object.values(value).every(isJsonValue);
  return false;
}

function jsonEqual(left: JsonValue, right: JsonValue): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null) return left === right;

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => jsonEqual(value, right[index] as JsonValue));
  }

  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key, index) => key === rightKeys[index] && jsonEqual(left[key] as JsonValue, right[key] as JsonValue));
  }

  return false;
}
