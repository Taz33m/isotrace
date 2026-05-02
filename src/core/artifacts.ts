import type Ajv from "ajv";
import { type ErrorObject, type ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020";
import historySchema from "../../schemas/history.schema.json";
import reportSchema from "../../schemas/report.schema.json";
import type { AnalysisReport } from "./report";
import type { History } from "./types";
import { HistoryValidationError, type NormalizedHistory, normalizeHistory } from "./validate";

interface HistoryArtifact {
  history: History;
  normalized: NormalizedHistory;
}

interface HistoryArtifactOptions {
  strict?: boolean;
}

let historyValidator: ValidateFunction | null = null;
let reportValidator: ValidateFunction | null = null;

export function parseHistoryJson(text: string, options: HistoryArtifactOptions = {}): HistoryArtifact {
  return validateHistoryArtifact(parseJson(text, "history JSON"), options);
}

export function validateHistoryArtifact(value: unknown, options: HistoryArtifactOptions = {}): HistoryArtifact {
  const validate = getHistoryValidator();
  if (!validate(value)) {
    throw new HistoryValidationError(formatSchemaErrors("history", validate.errors ?? []));
  }
  const history = value as History;
  const normalized = normalizeHistory(history);
  if (options.strict || history.mode === "strict-serializable") {
    validateStrictTimestamps(normalized);
  }
  return {
    history,
    normalized,
  };
}

export function validateAnalysisReportArtifact(value: unknown): AnalysisReport {
  const validate = getReportValidator();
  if (!validate(value)) {
    throw new HistoryValidationError(formatSchemaErrors("analysis report", validate.errors ?? []));
  }
  const report = value as AnalysisReport;
  validateHistoryArtifact(report.result.history, { strict: report.result.mode === "strict-serializable" });
  return report;
}

function validateStrictTimestamps(normalized: NormalizedHistory): void {
  for (const tx of normalized.committed) {
    if (tx.id === "T0") continue;
    if (typeof tx.begin !== "number" || typeof tx.commit !== "number") {
      throw new HistoryValidationError(`${tx.id} requires numeric begin and commit timestamps for strict-serializable analysis`);
    }
  }
}

function parseJson(text: string, subject: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new HistoryValidationError(`${subject} is not valid JSON: ${message}`);
  }
}

function getHistoryValidator(): ValidateFunction {
  historyValidator ??= createAjv().compile(historySchema);
  return historyValidator;
}

function getReportValidator(): ValidateFunction {
  if (!reportValidator) {
    const ajv = createAjv();
    ajv.addSchema(historySchema);
    reportValidator = ajv.compile(reportSchema);
  }
  return reportValidator;
}

function createAjv(): Ajv {
  return new Ajv2020({ allErrors: true, strict: false });
}

function formatSchemaErrors(subject: string, errors: ErrorObject[]): string {
  const messages = errors.map(formatSchemaError).filter(Boolean);
  const unique = Array.from(new Set(messages));
  return `${subject} schema violation: ${unique.slice(0, 3).join("; ")}`;
}

function formatSchemaError(error: ErrorObject): string {
  if (error.keyword === "if" || error.keyword === "oneOf") {
    return "";
  }
  const path = error.instancePath || "/";
  if (error.keyword === "required" && isRecord(error.params) && typeof error.params.missingProperty === "string") {
    return `${path} requires property ${error.params.missingProperty}`;
  }
  if (error.keyword === "additionalProperties" && isRecord(error.params) && typeof error.params.additionalProperty === "string") {
    return `${path} does not allow property ${error.params.additionalProperty}`;
  }
  if (error.keyword === "enum" && Array.isArray(error.schema)) {
    return `${path} must be one of ${error.schema.join(", ")}`;
  }
  if (error.keyword === "const") {
    return `${path} must equal ${String(error.schema)}`;
  }
  if (error.keyword === "type") {
    return `${path} ${error.message ?? "has invalid type"}`;
  }
  if (error.keyword === "minLength") {
    return `${path} ${error.message ?? "is too short"}`;
  }
  if (error.keyword === "pattern") {
    return `${path} ${error.message ?? "does not match required pattern"}`;
  }
  if (error.keyword === "not") {
    return `${path} has a property combination that is not allowed`;
  }
  return `${path} ${error.message ?? error.keyword}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
