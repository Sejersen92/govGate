import { readFileSync } from "node:fs";
import { Command } from "commander";
import { glob } from "tinyglobby";
import { ApiClient, ApiError } from "./api.js";
import { detectCiContext, emitRunIdVariable } from "./ci-context.js";
import { ConfigError, loadFileMappings, resolveConfig, type ConfigFlags } from "./config.js";
import { evaluateGate, parseFailOn, type GateOptions } from "./gate.js";
import { mapTestsToCases } from "./mapping.js";
import { parseJUnitXml } from "./parsers/junit.js";
import type { ParsedTest } from "./parsers/types.js";
import {
  printCounts,
  printGate,
  printMappingTable,
  printRunUrl,
  printUnknownCases,
} from "./summary.js";

const EXIT_GATE_FAILED = 1;
const EXIT_USAGE = 2;
const EXIT_API = 3;

function fail(code: number, message: string): never {
  console.error(`Error: ${message}`);
  process.exit(code);
}

function handleError(e: unknown): never {
  if (e instanceof ConfigError) fail(EXIT_USAGE, e.message);
  if (e instanceof ApiError) fail(EXIT_API, e.message);
  fail(EXIT_API, e instanceof Error ? e.message : String(e));
}

function gateOptionsFrom(opts: { failOn: string; minExecuted?: string }): GateOptions {
  const gate: GateOptions = { failOn: parseFailOn(opts.failOn) };
  if (opts.minExecuted !== undefined) {
    const pct = Number(opts.minExecuted);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      throw new ConfigError("--min-executed must be a number between 0 and 100");
    }
    gate.minExecuted = pct;
  }
  return gate;
}

async function parseFiles(patterns: string[], format: string): Promise<ParsedTest[]> {
  if (format !== "junit") {
    throw new ConfigError(`Unsupported --format '${format}' (v1 supports: junit)`);
  }
  const files = await glob(patterns, { absolute: true });
  if (files.length === 0) {
    throw new ConfigError(`No files matched: ${patterns.join(", ")}`);
  }
  const tests: ParsedTest[] = [];
  for (const file of files) {
    tests.push(...parseJUnitXml(readFileSync(file, "utf8")));
  }
  if (tests.length === 0) {
    throw new ConfigError(`Parsed ${files.length} file(s) but found no test cases`);
  }
  return tests;
}

async function completeAndGate(api: ApiClient, url: string, runId: string, gate: GateOptions) {
  await api.completeRun(runId);
  const summary = await api.getSummary(runId);
  printCounts(summary.counts, summary.executedPercent);
  const verdict = evaluateGate(summary.counts, gate);
  printGate(verdict);
  printRunUrl(url, runId);
  if (!verdict.passed) process.exit(EXIT_GATE_FAILED);
}

const program = new Command()
  .name("govgate")
  .description("Report CI test results to your testing tool and gate releases on the outcome.");

program
  .command("report")
  .description("Parse test result files (JUnit XML), map tests to cases, and report a run")
  .argument("<files...>", "result files or globs, e.g. test-results/*.xml")
  .option("--url <url>", "tool URL (or GOVGATE_URL)")
  .option("--api-key <key>", "API key (prefer GOVGATE_API_KEY)")
  .option("--config <path>", "path to govgate/config.json (default: searched upward)")
  .option("--suite <slug>", "suite slug (overrides config)")
  .option("--env <slug>", "environment slug (overrides config and inference)")
  .option(
    "--base-url <url>",
    "base URL of the app under test; matched against the declared environments' baseUrls to infer the environment (default: API_BASEURL)",
  )
  .option("--name <name>", "run name (default: derived from CI context)")
  .option("--build-version <v>", "build version (default: short commit SHA from CI)")
  .option("--external-url <url>", "link to the build/PR (default: from CI context)")
  .option("--format <format>", "input format", "junit")
  .option("--run-id <uuid>", "append results to an existing run instead of creating one")
  .option("--no-complete", "leave the run in progress (multi-job pipelines); skips the gate")
  .option("--fail-on <list>", "statuses that fail the gate: fail | fail,blocked", "fail")
  .option("--min-executed <pct>", "minimum executed percentage required by the gate")
  .option("--actor <label>", "tested-by label on results", "govgate")
  .option("--dry-run", "parse and map only; post nothing")
  .action(async (files: string[], opts) => {
    try {
      const flags: ConfigFlags = {
        url: opts.url,
        apiKey: opts.apiKey,
        suite: opts.suite,
        env: opts.env,
        config: opts.config,
        baseUrl: opts.baseUrl,
      };
      const tests = await parseFiles(files, opts.format);
      const config = opts.dryRun
        ? tryResolveConfig(flags)
        : resolveConfig(flags);

      // In a dry run, mappings must load from govgate/config.json even when
      // credentials are absent — otherwise every test reports as "unmapped"
      // and the validation the dry run exists to provide is silently wrong.
      const mappings = config?.mappings ?? (opts.dryRun ? loadFileMappings(flags).mappings : {});
      const outcome = mapTestsToCases(tests, mappings);
      console.log(
        `Parsed ${tests.length} test(s) from ${files.join(", ")} — ${outcome.results.length} case(s) mapped, ${outcome.unmappedTests.length} unmapped test(s)`,
      );
      printMappingTable(outcome);

      if (opts.dryRun) {
        if (config) {
          const api = new ApiClient(config.url, config.apiKey);
          const suite = await api.getSuiteCases(config.suite);
          const known = new Set(suite.cases.map((c) => c.caseNumber));
          const unknown = outcome.results.map((r) => r.caseNumber).filter((n) => !known.has(n));
          printUnknownCases(unknown);
        } else {
          console.log("\n(dry run without credentials — case numbers not validated against the suite)");
        }
        console.log("\nDry run — nothing was posted.");
        return;
      }

      const gate = gateOptionsFrom(opts);
      const api = new ApiClient(config!.url, config!.apiKey);
      const ci = detectCiContext();

      let runId: string = opts.runId ?? "";
      if (!runId) {
        // Environments declared in config are ensured (idempotent upsert by
        // slug) before the run, so a brand-new stage can never 404 on an
        // unknown environment. A sync failure is a warning, not a run failure
        // — the environment may already exist server-side.
        if (config!.environments?.length) {
          try {
            const sync = await api.putEnvironments(config!.environments);
            if (sync.created > 0) {
              console.log(`Created ${sync.created} declared environment(s).`);
            }
          } catch (e) {
            console.error(
              `Warning: environment sync failed (${e instanceof Error ? e.message : String(e)}) — continuing.`,
            );
          }
        }
        const run = await api.createRun({
          suiteSlug: config!.suite,
          environmentSlug: config!.environment,
          name: opts.name ?? ci.defaultRunName,
          buildVersion: opts.buildVersion ?? ci.buildVersion,
          externalUrl: opts.externalUrl ?? ci.externalUrl,
        });
        runId = run.runId;
        console.log(
          `\nCreated run '${opts.name ?? ci.defaultRunName}' (${run.totalCases} cases, ${run.autoNa} auto-N/A)`,
        );
        emitRunIdVariable(runId, ci);
      }

      const { updated, unknownCaseNumbers } = await api.postResults(
        runId,
        outcome.results.map((r) => ({
          caseNumber: r.caseNumber,
          status: r.status,
          notes: r.notes,
          actor: opts.actor,
        })),
      );
      console.log(`Posted ${updated} result(s).`);
      printUnknownCases(unknownCaseNumbers);

      if (opts.complete) {
        await completeAndGate(api, config!.url, runId, gate);
      } else {
        console.log("\nRun left in progress (--no-complete). Finish with: govgate complete --run-id " + runId);
        printRunUrl(config!.url, runId);
      }
    } catch (e) {
      handleError(e);
    }
  });

// Dry runs should work without credentials; with them, we can validate cases.
function tryResolveConfig(flags: ConfigFlags) {
  try {
    return resolveConfig(flags);
  } catch {
    return undefined;
  }
}

program
  .command("sync-env")
  .description("Upsert the environments declared in govgate/config.json (idempotent by slug)")
  .option("--url <url>", "tool URL (or GOVGATE_URL)")
  .option("--api-key <key>", "API key (prefer GOVGATE_API_KEY)")
  .option("--config <path>", "path to govgate/config.json (default: searched upward)")
  .action(async (opts) => {
    try {
      const config = resolveConfig({
        url: opts.url,
        apiKey: opts.apiKey,
        suite: "unused", // environments sync does not involve a suite
        config: opts.config,
      });
      if (!config.environments?.length) {
        throw new ConfigError(
          `No "environments" declared in ${config.configPath ?? "govgate/config.json"}. ` +
            `Add e.g. { "environments": [{ "slug": "dev", "name": "DEV" }] } to that file.`,
        );
      }
      const api = new ApiClient(config.url, config.apiKey);
      const res = await api.putEnvironments(config.environments);
      console.log(`Environments synced: ${res.created} created, ${res.updated} updated.`);
      for (const e of res.environments) {
        console.log(`  ${e.slug}  ${e.name}${e.baseUrl ? `  ${e.baseUrl}` : ""}`);
      }
    } catch (e) {
      handleError(e);
    }
  });

program
  .command("complete")
  .description("Complete a run and evaluate the gate (final job of a multi-job pipeline)")
  .requiredOption("--run-id <uuid>", "run to complete")
  .option("--url <url>", "tool URL (or GOVGATE_URL)")
  .option("--api-key <key>", "API key (prefer GOVGATE_API_KEY)")
  .option("--config <path>", "path to govgate/config.json")
  .option("--suite <slug>", "suite slug (only used for config resolution)")
  .option("--fail-on <list>", "statuses that fail the gate: fail | fail,blocked", "fail")
  .option("--min-executed <pct>", "minimum executed percentage required by the gate")
  .action(async (opts) => {
    try {
      const config = resolveConfig({
        url: opts.url,
        apiKey: opts.apiKey,
        suite: opts.suite ?? "unused",
        config: opts.config,
      });
      const gate = gateOptionsFrom(opts);
      const api = new ApiClient(config.url, config.apiKey);
      await completeAndGate(api, config.url, opts.runId, gate);
    } catch (e) {
      handleError(e);
    }
  });

program.parseAsync().catch(handleError);
