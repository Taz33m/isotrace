import type { History, JsonValue, Transaction, TxOp } from "../core/types";
import { HistoryValidationError } from "../core/validate";

interface TraceState {
  name: string;
  description: string;
  mode?: History["mode"];
  transactions: Map<string, Transaction>;
  order: string[];
}

interface SelectSql {
  columns: string[];
  table: string;
  where: string;
  rows: SelectRow[];
  sourceSql: string;
}

type SelectRow = Record<string, JsonValue> & { _from?: JsonValue; _id?: JsonValue };

const IDENTIFIER = "[A-Za-z_][A-Za-z0-9_./-]*";

export function parseSqlTrace(text: string, fallbackName = "sql_trace"): History {
  const state: TraceState = {
    name: fallbackName.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_-]+/g, "_") || "sql_trace",
    description: "Imported from constrained IsoTrace SQL trace syntax.",
    transactions: new Map(),
    order: [],
  };

  for (const { line, lineNumber } of meaningfulLines(text)) {
    parseTraceLine(state, line, lineNumber);
  }

  if (state.order.length === 0) {
    throw new HistoryValidationError("SQL trace contains no transactions");
  }

  return {
    name: state.name,
    description: `${state.description} SELECT predicates are materialized only for returned rows that carry _from provenance; phantoms and non-returned range reads are not inferred.`,
    mode: state.mode,
    transactions: state.order.map((id) => state.transactions.get(id)).filter((tx): tx is Transaction => tx !== undefined),
  };
}

function parseTraceLine(state: TraceState, line: string, lineNumber: number): void {
  const name = line.match(/^NAME\s+(.+)$/i);
  if (name) {
    state.name = sanitizeName(name[1]?.trim() ?? "");
    return;
  }

  const description = line.match(/^DESCRIPTION\s+(.+)$/i);
  if (description) {
    state.description = description[1]?.trim() ?? state.description;
    return;
  }

  const mode = line.match(/^MODE\s+(serializable|strict-serializable)$/i);
  if (mode) {
    state.mode = requiredGroup(mode, 1, lineNumber).toLowerCase() as History["mode"];
    return;
  }

  const begin = line.match(new RegExp(`^BEGIN\\s+(${IDENTIFIER})(?:\\s+AT\\s+(${numberPattern()}))?(?:\\s+PROCESS\\s+(${IDENTIFIER}))?$`, "i"));
  if (begin) {
    const tx = ensureTransaction(state, requiredGroup(begin, 1, lineNumber));
    if (begin[2] !== undefined) tx.begin = parseNumber(begin[2], lineNumber);
    if (begin[3] !== undefined) tx.process = begin[3];
    return;
  }

  const end = line.match(new RegExp(`^(COMMIT|ROLLBACK)\\s+(${IDENTIFIER})(?:\\s+AT\\s+(${numberPattern()}))?$`, "i"));
  if (end) {
    const tx = ensureTransaction(state, requiredGroup(end, 2, lineNumber));
    tx.status = end[1]?.toUpperCase() === "ROLLBACK" ? "aborted" : "committed";
    if (end[3] !== undefined) tx.commit = parseNumber(end[3], lineNumber);
    return;
  }

  const statement = line.match(new RegExp(`^(${IDENTIFIER}):\\s*(.+)$`, "is"));
  if (!statement) {
    throw new HistoryValidationError(`SQL trace line ${lineNumber} is not recognized`);
  }

  const tx = ensureTransaction(state, requiredGroup(statement, 1, lineNumber));
  const sql = requiredGroup(statement, 2, lineNumber).trim();
  tx.ops.push(...parseSqlStatement(sql, lineNumber));
}

function parseSqlStatement(sql: string, lineNumber: number): TxOp[] {
  if (/^SELECT\b/i.test(sql)) return parseSelect(sql, lineNumber);
  if (/^UPDATE\b/i.test(sql)) return [parseUpdate(sql, lineNumber)];
  if (/^INSERT\b/i.test(sql)) return parseInsert(sql, lineNumber);
  throw new HistoryValidationError(`SQL trace line ${lineNumber} supports SELECT, UPDATE, and INSERT only`);
}

function parseSelect(sql: string, lineNumber: number): TxOp[] {
  const [selectSql, rowsJson] = splitArrow(sql, lineNumber);
  const select = selectSql.match(new RegExp(`^SELECT\\s+(.+?)\\s+FROM\\s+(${IDENTIFIER})\\s+WHERE\\s+(.+)$`, "i"));
  if (!select) {
    throw new HistoryValidationError(`SQL trace line ${lineNumber} SELECT must be: SELECT cols FROM table WHERE predicate -> rows`);
  }

  const columns = splitCsv(requiredGroup(select, 1, lineNumber)).map((column) => column.trim()).filter(Boolean);
  if (columns.length === 0 || columns.includes("*")) {
    throw new HistoryValidationError(`SQL trace line ${lineNumber} SELECT must list concrete columns, not *`);
  }
  const table = requiredGroup(select, 2, lineNumber);
  const where = requiredGroup(select, 3, lineNumber).trim();
  const rows = parseRows(rowsJson, lineNumber);
  const parsed: SelectSql = { columns, table, where, rows, sourceSql: selectSql.trim() };

  return rows.flatMap((row) => rowToReads(parsed, row, lineNumber));
}

function parseUpdate(sql: string, lineNumber: number): TxOp {
  const update = sql.match(new RegExp(`^UPDATE\\s+(${IDENTIFIER})\\s+SET\\s+(${IDENTIFIER})\\s*=\\s*(.+?)\\s+WHERE\\s+id\\s*=\\s*(.+)$`, "i"));
  if (!update) {
    throw new HistoryValidationError(`SQL trace line ${lineNumber} UPDATE must be: UPDATE table SET column = value WHERE id = value`);
  }
  const table = requiredGroup(update, 1, lineNumber);
  const column = requiredGroup(update, 2, lineNumber);
  const value = parseSqlLiteral(requiredGroup(update, 3, lineNumber), lineNumber);
  const rowId = parseSqlLiteral(requiredGroup(update, 4, lineNumber), lineNumber);
  return {
    type: "write",
    key: rowKey(table, rowId, column),
    value,
  };
}

function parseInsert(sql: string, lineNumber: number): TxOp[] {
  const insert = sql.match(new RegExp(`^INSERT\\s+INTO\\s+(${IDENTIFIER})\\s*\\((.+?)\\)\\s+VALUES\\s*\\((.+?)\\)$`, "i"));
  if (!insert) {
    throw new HistoryValidationError(`SQL trace line ${lineNumber} INSERT must be: INSERT INTO table (id, col) VALUES (id, value)`);
  }
  const table = requiredGroup(insert, 1, lineNumber);
  const columns = splitCsv(requiredGroup(insert, 2, lineNumber)).map((column) => column.trim());
  const values = splitCsv(requiredGroup(insert, 3, lineNumber)).map((value) => parseSqlLiteral(value, lineNumber));
  if (columns.length !== values.length) {
    throw new HistoryValidationError(`SQL trace line ${lineNumber} INSERT column/value count mismatch`);
  }
  const idIndex = columns.findIndex((column) => column.toLowerCase() === "id");
  if (idIndex < 0) {
    throw new HistoryValidationError(`SQL trace line ${lineNumber} INSERT requires an id column`);
  }
  const rowId = values[idIndex];
  return columns.flatMap((column, index): TxOp[] => {
    if (column.toLowerCase() === "id") return [];
    return [{ type: "write", key: rowKey(table, rowId, column), value: values[index] as JsonValue }];
  });
}

function rowToReads(select: SelectSql, row: SelectRow, lineNumber: number): TxOp[] {
  const from = row._from;
  if (typeof from !== "string" || from.length === 0) {
    throw new HistoryValidationError(`SQL trace line ${lineNumber} SELECT rows require string _from provenance`);
  }
  const rowId = row._id ?? row.id;
  if (!isRowKeyValue(rowId)) {
    throw new HistoryValidationError(`SQL trace line ${lineNumber} SELECT rows require id or _id`);
  }

  return select.columns.flatMap((column): TxOp[] => {
    if (column === "id" || column.startsWith("_")) return [];
    if (!(column in row)) {
      throw new HistoryValidationError(`SQL trace line ${lineNumber} SELECT row is missing column ${column}`);
    }
    const value = row[column];
    if (!isJsonValue(value)) {
      throw new HistoryValidationError(`SQL trace line ${lineNumber} SELECT row column ${column} is not a JSON value`);
    }
    return [
      {
        type: "read",
        key: rowKey(select.table, rowId, column),
        value,
        from,
        predicate: {
          table: select.table,
          where: select.where,
          rowId,
          sourceSql: select.sourceSql,
        },
      },
    ];
  });
}

function ensureTransaction(state: TraceState, id: string): Transaction {
  const existing = state.transactions.get(id);
  if (existing) return existing;
  const tx: Transaction = { id, ops: [] };
  state.transactions.set(id, tx);
  state.order.push(id);
  return tx;
}

function meaningfulLines(text: string): Array<{ line: string; lineNumber: number }> {
  return text
    .split(/\r?\n/)
    .map((raw, index) => ({ line: stripComment(raw).trim(), lineNumber: index + 1 }))
    .filter(({ line }) => line.length > 0);
}

function stripComment(line: string): string {
  let inString = false;
  for (let index = 0; index < line.length - 1; index += 1) {
    const char = line[index];
    if (char === "'") {
      if (inString && line[index + 1] === "'") {
        index += 1;
      } else {
        inString = !inString;
      }
    }
    if (!inString && line[index] === "-" && line[index + 1] === "-") {
      return line.slice(0, index);
    }
  }
  return line;
}

function splitArrow(sql: string, lineNumber: number): [string, string] {
  const index = sql.indexOf("->");
  if (index < 0) {
    throw new HistoryValidationError(`SQL trace line ${lineNumber} SELECT must include -> JSON rows`);
  }
  return [sql.slice(0, index), sql.slice(index + 2).trim()];
}

function parseRows(text: string, lineNumber: number): SelectRow[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new HistoryValidationError(`SQL trace line ${lineNumber} SELECT rows are not valid JSON: ${message}`);
  }
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw new HistoryValidationError(`SQL trace line ${lineNumber} SELECT rows must be a JSON array of objects`);
  }
  return value as SelectRow[];
}

function splitCsv(text: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "'") {
      current += char;
      if (inString && text[index + 1] === "'") {
        current += text[index + 1];
        index += 1;
      } else {
        inString = !inString;
      }
      continue;
    }
    if (char === "," && !inString) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim().length > 0) parts.push(current.trim());
  return parts;
}

function parseSqlLiteral(text: string, lineNumber: number): JsonValue {
  const value = text.trim();
  if (/^'.*'$/s.test(value)) return value.slice(1, -1).replace(/''/g, "'");
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (/^true$/i.test(value)) return true;
  if (/^false$/i.test(value)) return false;
  if (/^null$/i.test(value)) return null;
  throw new HistoryValidationError(`SQL trace line ${lineNumber} has unsupported SQL literal ${value}`);
}

function rowKey(table: string, rowId: JsonValue, column: string): string {
  return `${table}/${String(rowId)}/${column}`;
}

function parseNumber(text: string, lineNumber: number): number {
  const value = Number(text);
  if (!Number.isFinite(value)) {
    throw new HistoryValidationError(`SQL trace line ${lineNumber} has invalid number ${text}`);
  }
  return value;
}

function sanitizeName(name: string): string {
  const sanitized = name.trim().replace(/[^A-Za-z0-9_-]+/g, "_");
  if (sanitized.length === 0) {
    throw new HistoryValidationError("SQL trace NAME must not be empty");
  }
  return sanitized;
}

function requiredGroup(match: RegExpMatchArray, index: number, lineNumber: number): string {
  const value = match[index];
  if (value === undefined || value.length === 0) {
    throw new HistoryValidationError(`SQL trace line ${lineNumber} is missing parser group ${index}`);
  }
  return value;
}

function numberPattern(): string {
  return "-?\\d+(?:\\.\\d+)?";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function isRowKeyValue(value: unknown): value is JsonValue {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}
