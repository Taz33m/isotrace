# Repository Guidance

Build serious technical artifacts, not generic apps. The public repo should make a strong engineer see the working core quickly: a simulator, checker, profiler, debugger, evaluator, benchmark harness, visualizer, analyzer, constrained engine, or comparable technical system.

Build the hard core before the UI. User-facing surfaces should expose real computation, traces, failures, proofs, or benchmarks from the engine. Do not wrap a fake core in a polished shell.

Prefer deterministic logic where possible. Make seeds, fixtures, parameters, and outputs reproducible. When nondeterminism is unavoidable, record enough provenance to rerun and explain the result.

Tests, benchmarks, or evals are required product proof. Every meaningful claim in the README should be backed by a command, fixture, test, benchmark, or visibly inspectable output.

No fake data, fake metrics, fake integrations, or fake claims. Sample fixtures may be synthetic only when they are clearly labeled and technically representative. Do not imply production adoption, live telemetry, or external integrations that do not exist.

Internal planning belongs in `.codex-work/`. Keep it gitignored. Public Markdown should stay minimal: `README.md`, this `AGENTS.md`, and only concise architecture docs when truly useful.

The README must be honest. Explain the technical seam, what the tool does, what it does not do, how to run it, how to test it, and what limitations remain. Avoid hype and overclaiming.

If a browser UI exists, browser/demo verification is required before release. Check that the demo path loads, the core output is visible, errors are understandable, and layout does not hide the hard part.

The final artifact must be GitHub-ready: clean git status or intentional staged/committed changes, reproducible setup, useful examples, passing checks where available, and no private planning files in the public tree.
