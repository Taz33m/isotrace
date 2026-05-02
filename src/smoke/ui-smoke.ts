import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import type { Browser, BrowserType, Page } from "playwright";

class BrowserUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserUnavailableError";
  }
}

async function main(): Promise<void> {
  runCliProofSmoke();

  try {
    await runBrowserSmoke();
    console.log("smoke:ui browser checks passed");
  } catch (error) {
    if (error instanceof BrowserUnavailableError) {
      console.warn(`smoke:ui browser checks skipped: ${error.message}`);
      console.warn("smoke:ui CLI proof fallback passed");
      return;
    }
    throw error;
  }
}

function runCliProofSmoke(): void {
  const demo = runIsoTraceCli(["fixtures/write_skew_doctors.json"]);
  assertIncludes(demo, "Result: VIOLATION", "write-skew demo reports a violation");
  assertIncludes(demo, "Anomaly: Write skew [write-skew]", "write-skew demo reports semantic anomaly label");
  assertIncludes(demo, "Implicated transactions: T1, T2", "write-skew demo reports implicated transactions");
  assertIncludes(demo, "Version order uses commit timestamps", "write-skew demo explains version-order mode");
  assertIncludes(demo, "Serializable order is impossible", "write-skew demo prints a cycle witness");

  const strict = runIsoTraceCli(["fixtures/stale_read_strict.json", "--strict"]);
  assertIncludes(strict, "Anomaly: Strict stale read [strict-stale-read]", "strict demo reports stale-read anomaly label");
  assertIncludes(strict, "Strict serializability is violated", "strict demo prints a strict cycle witness");
  assertIncludes(strict, "[rt/realtime]", "strict demo includes realtime edge proof");

  const json = JSON.parse(runIsoTraceCli(["fixtures/write_skew_doctors.json", "--json"])) as {
    report?: { schema?: string };
    result?: { validationNotes?: string[]; cycles?: unknown[] };
  };
  if (json.report?.schema !== "isotrace.report.v1") {
    throw new Error("JSON CLI smoke expected isotrace.report.v1 report schema");
  }
  if (!json.result?.validationNotes?.some((note) => note.includes("Version order uses commit timestamps"))) {
    throw new Error("JSON CLI smoke expected version-order validation note");
  }
  if ((json.result.cycles ?? []).length === 0) {
    throw new Error("JSON CLI smoke expected at least one cycle witness");
  }

  console.log("smoke:ui CLI proof checks passed");
}

function runIsoTraceCli(args: string[]): string {
  return execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function runBrowserSmoke(): Promise<void> {
  let playwright: typeof import("playwright");
  try {
    playwright = await import("playwright");
  } catch (error) {
    throw new BrowserUnavailableError(error instanceof Error ? error.message : String(error));
  }

  const server = await resolveSmokeTarget();

  try {
    const browser = await launchBrowser(playwright.chromium);
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      await verifyWorkbench(page, server.url);
    } finally {
      await browser.close();
    }
  } finally {
    if (server.process) {
      await stopProcess(server.process);
    }
  }
}

async function resolveSmokeTarget(): Promise<{ process: ChildProcessWithoutNullStreams | null; url: string }> {
  if (process.env.ISOTRACE_SMOKE_URL) {
    return { process: null, url: process.env.ISOTRACE_SMOKE_URL };
  }
  try {
    return await startViteServer();
  } catch (error) {
    if (isLocalBackendUnavailable(error)) {
      throw new BrowserUnavailableError(error instanceof Error ? error.message : String(error));
    }
    throw error;
  }
}

async function startViteServer(): Promise<{ process: ChildProcessWithoutNullStreams; url: string }> {
  const port = await getFreePort();
  const url = `http://127.0.0.1:${port}/`;
  const child = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end();
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  try {
    await waitForHttpOk(url, child, () => output);
    return { process: child, url };
  } catch (error) {
    await stopProcess(child);
    throw error;
  }
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("could not allocate a local TCP port")));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

function isLocalBackendUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = "code" in error ? String(error.code) : "";
  return code === "EPERM" || code === "EACCES" || /listen (EPERM|EACCES)/.test(error.message);
}

async function waitForHttpOk(url: string, child: ChildProcessWithoutNullStreams, output: () => string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Vite smoke server exited before becoming ready:\n${output()}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }
    await delay(150);
  }
  throw new Error(`Timed out waiting for Vite smoke server at ${url}:\n${output()}`);
}

async function stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 2_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill();
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function launchBrowser(chromium: BrowserType): Promise<Browser> {
  const launchErrors: string[] = [];
  for (const options of [{ headless: true }, { headless: true, channel: "chrome" }]) {
    try {
      return await chromium.launch(options);
    } catch (error) {
      launchErrors.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new BrowserUnavailableError(launchErrors.join("\n"));
}

async function expectClassContains(page: Page, testId: string, className: string, label: string): Promise<void> {
  const actual = await page.getByTestId(testId).getAttribute("class");
  if (!actual?.includes(className)) {
    throw new Error(`UI smoke expected ${label}: ${testId} did not include ${className}`);
  }
}

async function verifyWorkbench(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: "networkidle" });
  await page.getByTestId("app-shell").waitFor({ state: "visible", timeout: 10_000 });
  await page.getByRole("heading", { name: "IsoTrace" }).waitFor({ state: "visible" });

  await page.getByTestId("scenario-serial_stock_decrement").click();
  await page.getByRole("heading", { name: "serial_stock_decrement" }).waitFor({ state: "visible" });
  await page.getByTestId("verdict-panel").filter({ hasText: "Valid serial history" }).waitFor({ state: "visible" });
  await page.getByTestId("verdict-panel").filter({ hasText: "valid-serial-history" }).waitFor({ state: "visible" });
  await page.getByText("No dependency cycle was found under serializable").waitFor({ state: "visible" });

  await page.getByTestId("scenario-write_skew_doctors").click();
  await page.getByRole("heading", { name: "write_skew_doctors" }).waitFor({ state: "visible" });
  await page.getByTestId("verdict-panel").filter({ hasText: "Write skew" }).waitFor({ state: "visible" });
  await page.getByTestId("verdict-panel").filter({ hasText: "write-skew" }).waitFor({ state: "visible" });
  await page.getByTestId("verdict-panel").filter({ hasText: "T1, T2" }).waitFor({ state: "visible" });
  const firstVerdictEdge = page.locator("[data-testid^='verdict-edge-']").first();
  await firstVerdictEdge.waitFor({ state: "visible" });
  await firstVerdictEdge.click();
  const selectedVerdictEdgeId = (await firstVerdictEdge.getAttribute("data-testid"))?.replace("verdict-edge-", "");
  if (!selectedVerdictEdgeId) {
    throw new Error("UI smoke expected a selectable verdict proof edge");
  }
  await page.getByTestId("selected-edge").filter({ hasText: selectedVerdictEdgeId }).waitFor({ state: "visible" });
  await expectClassContains(page, "history-row-T1", "selectedTxRow", "source transaction row is highlighted");
  await expectClassContains(page, "history-row-T2", "selectedTxRow", "target transaction row is highlighted");
  await expectClassContains(page, "history-op-T1-1", "edgeSourceOp", "source read operation is highlighted");
  await expectClassContains(page, "history-op-T2-2", "edgeTargetOp", "target write operation is highlighted");
  await page
    .locator("[data-testid='cycle-card']")
    .filter({ hasText: "Serializable order is impossible" })
    .first()
    .waitFor({ state: "visible" });
  const firstCycleEdge = page.locator("[data-testid^='cycle-edge-']").first();
  await firstCycleEdge.click();
  const selectedEdgeId = (await firstCycleEdge.getAttribute("data-testid"))?.replace("cycle-edge-", "");
  if (!selectedEdgeId) {
    throw new Error("UI smoke expected a selectable cycle edge");
  }
  await page.getByTestId("selected-edge").filter({ hasText: selectedEdgeId }).waitFor({ state: "visible" });
  const selectedEdgeRowClass = await page.getByTestId(`edge-row-${selectedEdgeId}`).getAttribute("class");
  if (!selectedEdgeRowClass?.includes("selectedEdgeRow")) {
    throw new Error(`UI smoke expected edge row ${selectedEdgeId} to be selected`);
  }
  const selectedGraphEdgeClass = await page.getByTestId(`graph-edge-${selectedEdgeId}`).getAttribute("class");
  if (!selectedGraphEdgeClass?.includes("selected")) {
    throw new Error(`UI smoke expected graph edge ${selectedEdgeId} to be selected`);
  }

  const validHistory = {
    name: "ui_smoke_custom",
    description: "valid custom import for the smoke harness",
    transactions: [
      { id: "T0", commit: 0, ops: [{ type: "write", key: "x", value: 0 }] },
      { id: "T1", begin: 1, commit: 2, ops: [{ type: "read", key: "x", value: 0, from: "T0" }] },
    ],
  };
  await page.getByTestId("custom-history-input").fill(JSON.stringify(validHistory, null, 2));
  await page.getByTestId("analyze-custom-history").click();
  await page.getByRole("heading", { name: "ui_smoke_custom" }).waitFor({ state: "visible" });
  await page.getByTestId("scenario-custom").waitFor({ state: "visible" });

  await page.getByTestId("custom-history-input").fill("{");
  await page.getByTestId("analyze-custom-history").click();
  await page.getByTestId("custom-history-error").waitFor({ state: "visible" });

  const invalidHistory = {
    name: "ui_smoke_invalid",
    description: "invalid custom history for the smoke harness",
    transactions: [{ id: "T0", ops: [{ type: "read", key: "x", value: 1, from: "missing" }] }],
  };
  await page.getByTestId("custom-history-input").fill(JSON.stringify(invalidHistory, null, 2));
  await page.getByTestId("analyze-custom-history").click();
  await page.getByText("reads x from unknown transaction missing").waitFor({ state: "visible" });
}

function assertIncludes(haystack: string, needle: string, label: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(`Expected ${label}: missing "${needle}"`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
