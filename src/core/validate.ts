import type { History, IsolationMode, JsonValue, PredicateExpression, PredicateOperator, PredicateReadOp, ReadOp, Transaction, TransactionStatus, TxOp, WriteMutation, WriteOp } from "./types";
import { formatJsonValue } from "./format";
import { evaluatePredicateTruth, formatPredicate, jsonEqual } from "./predicate";

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
    for (let opIndex = 0; opIndex < tx.ops.length; opIndex += 1) {
      const op = tx.ops[opIndex];
      if (op.type !== "read") continue;
      if (!txById.has(op.from)) {
        throw new HistoryValidationError(`${tx.id} reads ${op.key} from unknown transaction ${op.from}`);
      }
      const writer = txById.get(op.from);
      if (!writer || (writer.status ?? "committed") !== "committed") {
        throw new HistoryValidationError(`${tx.id} reads ${op.key} from non-committed transaction ${op.from}`);
      }
      const writeIndex = writer.ops.findIndex((writerOp) => writerOp.type === "write" && writerOp.key === op.key);
      const write = writer.ops[writeIndex];
      if (!write || write.type !== "write") {
        throw new HistoryValidationError(`${tx.id} reads ${op.key} from ${op.from}, but ${op.from} does not write that key`);
      }
      if (writer.id === tx.id && writeIndex > opIndex) {
        throw new HistoryValidationError(`${tx.id} reads ${op.key} from its own write before that write appears in ops[]`);
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

function validateOp(txId: string, op: TxOp, opIndex: number): void {
  if (!isRecord(op)) {
    throw new HistoryValidationError(`${txId} op ${opIndex} must be an object`);
  }
  if (op.type !== "read" && op.type !== "write" && op.type !== "predicate-read") {
    throw new HistoryValidationError(`${txId} op ${opIndex} has invalid type`);
  }
  if (op.type === "read") {
    validatePointRead(txId, op, opIndex);
  } else if (op.type === "write") {
    validateWrite(txId, op, opIndex);
  } else {
    validatePredicateRead(txId, op, opIndex);
  }
}

function validatePointRead(txId: string, op: ReadOp, opIndex: number): void {
  if (!isNonEmptyString(op.key)) {
    throw new HistoryValidationError(`${txId} op ${opIndex} requires key`);
  }
  if (!("value" in op) || !isJsonValue(op.value)) {
    throw new HistoryValidationError(`${txId} read ${op.key} requires a JSON value`);
  }
  if (!isNonEmptyString(op.from)) {
    throw new HistoryValidationError(`${txId} read ${op.key} requires from transaction id`);
  }
  if (op.predicate !== undefined) {
    validateReadPredicateEvidence(txId, op, opIndex);
  }
  void formatJsonValue(op.value);
}

function validateWrite(txId: string, op: WriteOp, opIndex: number): void {
  if (!isNonEmptyString(op.key)) {
    throw new HistoryValidationError(`${txId} op ${opIndex} requires key`);
  }
  if (!("value" in op) || !isJsonValue(op.value)) {
    throw new HistoryValidationError(`${txId} write ${op.key} requires a JSON value`);
  }
  validateRelationalWrite(txId, op, opIndex);
}

function validateReadPredicateEvidence(txId: string, op: ReadOp, opIndex: number): void {
  const evidence = op.predicate;
  if (!isRecord(evidence) || !isNonEmptyString(evidence.table) || !isNonEmptyString(evidence.where) || !isNonEmptyString(evidence.sourceSql)) {
    throw new HistoryValidationError(`${txId} read ${op.key} predicate evidence at op ${opIndex} requires table, where, rowId, and sourceSql`);
  }
  if (!("rowId" in evidence) || !isJsonValue(evidence.rowId)) {
    throw new HistoryValidationError(`${txId} read ${op.key} predicate evidence at op ${opIndex} requires rowId`);
  }
}

function validateRelationalWrite(txId: string, op: WriteOp, opIndex: number): void {
  const hasAny =
    op.table !== undefined ||
    op.rowId !== undefined ||
    op.fields !== undefined ||
    op.mutation !== undefined ||
    op.rowBefore !== undefined ||
    op.rowAfter !== undefined;
  if (!hasAny) return;
  if (!isNonEmptyString(op.table)) {
    throw new HistoryValidationError(`${txId} write ${op.key} relational metadata at op ${opIndex} requires table`);
  }
  if (!("rowId" in op) || !isJsonValue(op.rowId)) {
    throw new HistoryValidationError(`${txId} write ${op.key} relational metadata at op ${opIndex} requires rowId`);
  }
  if (op.mutation !== undefined && !isWriteMutation(op.mutation)) {
    throw new HistoryValidationError(`${txId} write ${op.key} relational metadata at op ${opIndex} has invalid mutation`);
  }
  const fields = op.fields === undefined ? undefined : validateRowObject(txId, op.key, "fields", op.fields, opIndex, op.rowId);
  const rowBefore = op.rowBefore === undefined || op.rowBefore === null ? op.rowBefore : validateRowObject(txId, op.key, "rowBefore", op.rowBefore, opIndex, op.rowId);
  const rowAfter = op.rowAfter === undefined || op.rowAfter === null ? op.rowAfter : validateRowObject(txId, op.key, "rowAfter", op.rowAfter, opIndex, op.rowId);

  if (op.mutation === "delete") {
    if (rowBefore === undefined || rowBefore === null) {
      throw new HistoryValidationError(`${txId} write ${op.key} delete metadata at op ${opIndex} requires rowBefore`);
    }
    if (rowAfter !== undefined && rowAfter !== null) {
      throw new HistoryValidationError(`${txId} write ${op.key} delete metadata at op ${opIndex} requires rowAfter to be null or absent`);
    }
    if (fields !== undefined) {
      throw new HistoryValidationError(`${txId} write ${op.key} delete metadata at op ${opIndex} must not include fields`);
    }
    return;
  }

  if (op.mutation === "insert" || op.mutation === "update") {
    if (fields === undefined && (rowAfter === undefined || rowAfter === null)) {
      throw new HistoryValidationError(`${txId} write ${op.key} ${op.mutation} metadata at op ${opIndex} requires fields or rowAfter`);
    }
  } else if (fields === undefined) {
    throw new HistoryValidationError(`${txId} write ${op.key} relational metadata at op ${opIndex} requires fields`);
  }

  if (fields !== undefined && rowAfter !== undefined && rowAfter !== null) {
    rejectConflictingRowEvidence(txId, op.key, fields, rowAfter, opIndex);
  }
}

function validatePredicateRead(txId: string, op: PredicateReadOp, opIndex: number): void {
  if (!isNonEmptyString(op.table)) {
    throw new HistoryValidationError(`${txId} predicate-read at op ${opIndex} requires table`);
  }
  validatePredicate(txId, op.predicate, opIndex);
  if (!Array.isArray(op.returnedRows)) {
    throw new HistoryValidationError(`${txId} predicate-read at op ${opIndex} requires returnedRows[]`);
  }
  if (op.sourceSql !== undefined && typeof op.sourceSql !== "string") {
    throw new HistoryValidationError(`${txId} predicate-read at op ${opIndex} sourceSql must be a string`);
  }
  if (op.note !== undefined && typeof op.note !== "string") {
    throw new HistoryValidationError(`${txId} predicate-read at op ${opIndex} note must be a string`);
  }
  for (const row of op.returnedRows) {
    if (!isRecord(row)) {
      throw new HistoryValidationError(`${txId} predicate-read ${op.table} returned row must be an object`);
    }
    if (!("id" in row) || !isJsonValue(row.id)) {
      throw new HistoryValidationError(`${txId} predicate-read ${op.table} returned row requires id`);
    }
    for (const [field, value] of Object.entries(row)) {
      if (!isNonEmptyString(field) || !isJsonValue(value)) {
        throw new HistoryValidationError(`${txId} predicate-read ${op.table} row field ${field} must be a JSON value`);
      }
    }
    if (evaluatePredicateTruth(row as Record<string, JsonValue>, op.predicate) !== true) {
      throw new HistoryValidationError(
        `${txId} predicate-read ${op.table} row ${formatJsonValue(row.id)} does not satisfy predicate ${formatPredicate(op.predicate)}`,
      );
    }
  }
}

function validatePredicate(txId: string, predicate: PredicateExpression, opIndex: number): void {
  if (!isRecord(predicate)) {
    throw new HistoryValidationError(`${txId} predicate-read at op ${opIndex} requires predicate object`);
  }
  const forms = [isRecord(predicate) && "column" in predicate, "all" in predicate, "any" in predicate, "not" in predicate].filter(Boolean).length;
  if (forms !== 1) {
    throw new HistoryValidationError(`${txId} predicate-read at op ${opIndex} must use exactly one predicate form`);
  }
  if ("all" in predicate) {
    if (!Array.isArray(predicate.all) || predicate.all.length === 0) {
      throw new HistoryValidationError(`${txId} predicate-read at op ${opIndex} requires non-empty predicate.all`);
    }
    predicate.all.forEach((child) => validatePredicate(txId, child, opIndex));
    return;
  }
  if ("any" in predicate) {
    if (!Array.isArray(predicate.any) || predicate.any.length === 0) {
      throw new HistoryValidationError(`${txId} predicate-read at op ${opIndex} requires non-empty predicate.any`);
    }
    predicate.any.forEach((child) => validatePredicate(txId, child, opIndex));
    return;
  }
  if ("not" in predicate) {
    validatePredicate(txId, predicate.not as PredicateExpression, opIndex);
    return;
  }
  if (!isNonEmptyString(predicate.column)) {
    throw new HistoryValidationError(`${txId} predicate-read at op ${opIndex} requires predicate.column`);
  }
  if (!isPredicateOperator(predicate.op)) {
    throw new HistoryValidationError(`${txId} predicate-read at op ${opIndex} has unsupported predicate op ${String(predicate.op)}`);
  }
  if (!("value" in predicate) || !isJsonValue(predicate.value)) {
    throw new HistoryValidationError(`${txId} predicate-read at op ${opIndex} requires predicate.value`);
  }
}

function isPredicateOperator(value: unknown): value is PredicateOperator {
  return value === "=" || value === "!=" || value === "<" || value === "<=" || value === ">" || value === ">=";
}

function isWriteMutation(value: unknown): value is WriteMutation {
  return value === "insert" || value === "update" || value === "delete";
}

function validateRowObject(
  txId: string,
  key: string,
  label: string,
  value: unknown,
  opIndex: number,
  rowId: JsonValue,
): Record<string, JsonValue> {
  if (!isRecord(value)) {
    throw new HistoryValidationError(`${txId} write ${key} ${label} at op ${opIndex} must be an object`);
  }
  const row: Record<string, JsonValue> = {};
  for (const [field, fieldValue] of Object.entries(value)) {
    if (!isNonEmptyString(field) || !isJsonValue(fieldValue)) {
      throw new HistoryValidationError(`${txId} write ${key} ${label}.${field} at op ${opIndex} must be a JSON value`);
    }
    row[field] = fieldValue;
  }
  if ("id" in row && !jsonEqual(row.id, rowId)) {
    throw new HistoryValidationError(`${txId} write ${key} ${label}.id at op ${opIndex} must match rowId`);
  }
  return row;
}

function rejectConflictingRowEvidence(
  txId: string,
  key: string,
  fields: Record<string, JsonValue>,
  rowAfter: Record<string, JsonValue>,
  opIndex: number,
): void {
  for (const [field, value] of Object.entries(fields)) {
    if (field in rowAfter && !jsonEqual(value, rowAfter[field] as JsonValue)) {
      throw new HistoryValidationError(`${txId} write ${key} fields.${field} conflicts with rowAfter.${field} at op ${opIndex}`);
    }
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
