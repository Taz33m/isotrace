import { formatJsonValue } from "./format";
import type { JsonValue, PredicateExpression, PredicateOperator, PredicateReadRow } from "./types";

export type PredicateTruth = true | false | "unknown";

export function evaluatePredicate(row: Record<string, JsonValue>, predicate: PredicateExpression): boolean {
  return evaluatePredicateTruth(row, predicate) === true;
}

export function evaluatePredicateTruth(row: Record<string, JsonValue>, predicate: PredicateExpression): PredicateTruth {
  if ("all" in predicate) {
    let sawUnknown = false;
    for (const child of predicate.all) {
      const result = evaluatePredicateTruth(row, child);
      if (result === false) return false;
      if (result === "unknown") sawUnknown = true;
    }
    return sawUnknown ? "unknown" : true;
  }
  if ("any" in predicate) {
    let sawUnknown = false;
    for (const child of predicate.any) {
      const result = evaluatePredicateTruth(row, child);
      if (result === true) return true;
      if (result === "unknown") sawUnknown = true;
    }
    return sawUnknown ? "unknown" : false;
  }
  if ("not" in predicate) {
    const result = evaluatePredicateTruth(row, predicate.not);
    if (result === "unknown") return "unknown";
    return !result;
  }

  const left = row[predicate.column];
  if (left === undefined) return "unknown";

  if (predicate.op === "=") return jsonEqual(left, predicate.value);
  if (predicate.op === "!=") return !jsonEqual(left, predicate.value);

  if (typeof left === "number" && typeof predicate.value === "number") {
    return compareOrdered(left, predicate.op, predicate.value);
  }
  if (typeof left === "string" && typeof predicate.value === "string") {
    return compareOrdered(left, predicate.op, predicate.value);
  }
  return false;
}

export function formatPredicate(predicate: PredicateExpression): string {
  if ("all" in predicate) return `(${predicate.all.map(formatPredicate).join(" AND ")})`;
  if ("any" in predicate) return `(${predicate.any.map(formatPredicate).join(" OR ")})`;
  if ("not" in predicate) return `NOT ${formatPredicate(predicate.not)}`;
  return `${predicate.column} ${predicate.op} ${formatJsonValue(predicate.value)}`;
}

export function predicateRowId(row: PredicateReadRow): JsonValue {
  return row.id;
}

export function predicateRowIdentity(value: JsonValue): string {
  return formatJsonValue(value);
}

function compareOrdered(left: number | string, op: PredicateOperator, right: number | string): boolean {
  if (op === "<") return left < right;
  if (op === "<=") return left <= right;
  if (op === ">") return left > right;
  if (op === ">=") return left >= right;
  return false;
}

export function jsonEqual(left: JsonValue, right: JsonValue): boolean {
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

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
