# govgate

Pipeline-step CLI for the MT Testing Tool: parses standard test output (JUnit XML),
maps tests to test cases, reports a run, and **gates the release** via its exit code.
No SDK in application code — only the pipeline YAML changes.

```
npx govgate report test-results/junit.xml --env uat
```

Works identically in GitHub Actions and Azure DevOps. .NET is covered without a NuGet
package: `dotnet test --logger "junit"` (JunitXml.TestLogger) and point the CLI at the
output. Jest/Vitest/Playwright/pytest/NUnit/xUnit all emit JUnit XML natively or via a
standard reporter.

## Commands

### `govgate report <files-or-globs...>`

| Flag | Default | Meaning |
|---|---|---|
| `--url <url>` | `MT_TESTING_TOOL_URL` | Tool deployment URL |
| `--api-key <key>` | `MT_TESTING_TOOL_API_KEY` | API key (env var strongly preferred) |
| `--config <path>` | `.mt-testing.json` searched upward | Config file |
| `--suite <slug>` | config `suite` | Target suite |
| `--env <slug>` | config `defaultEnvironment` | Environment for the run |
| `--name <name>` | derived from CI context | Run name |
| `--build-version <v>` | short commit SHA from CI | Build version |
| `--external-url <url>` | CI build URL | "Build ↗" link on the run page |
| `--format junit` | `junit` | Input format (v1: junit only) |
| `--run-id <uuid>` | — | Append to an existing run (multi-job) |
| `--no-complete` | completes | Leave run in progress; skip the gate |
| `--fail-on <list>` | `fail` | Gate: `fail` or `fail,blocked` |
| `--min-executed <pct>` | — | Gate: minimum executed percentage |
| `--actor <label>` | `govgate` | Tested-by label |
| `--dry-run` | — | Parse + map + print; post nothing |

### `govgate complete --run-id <uuid> [--fail-on ...] [--min-executed ...]`

Completes a run left open by `--no-complete` and evaluates the gate over **all** results
in the run (including those posted by other jobs).

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success / gate passed |
| 1 | **Gate violated** — fail the pipeline step |
| 2 | Usage or configuration error |
| 3 | API / network error |

Unmapped tests and unknown case numbers are loud warnings, never non-zero exits.

## Mapping tests to cases

Resolution per test (results are unioned):

1. **Tags**: any `@mt-<caseNumber>` in the test name or classname —
   `it("completes checkout @mt-2", ...)`.
2. **Method-name tokens** (v0.2.0+): for identifier-style names (no whitespace — i.e.
   what .NET JUnit loggers emit), an underscore-delimited `Mt<n>` token maps the test:
   `Mt5_DuplicateEmail_Rejected`, `Profiles_Mt12_NotFound`, `Delete_Resolves_MT28`.
   Embedded substrings (`GMT5_…`, `Format2_…`) do not match.
3. **Config patterns** in `.mt-testing.json`:

```jsonc
{
  "suite": "checkout-regression",
  "defaultEnvironment": "dev",
  "mappings": {
    "4":  ["checkout.spec.ts::pays with saved card"],
    "7":  ["auth/*.spec.ts::*expired session*", "Login flow > redirects*"],
    "12": ["*newsletter*"]
  }
}
```

Pattern grammar: `*` is the only wildcard; matching is case-insensitive against the
bare test name, or against the full `file::name` id when the pattern contains `::`.

Aggregation per case is worst-status-wins: any failing mapped test → `fail`; otherwise
any passing → `pass`; all skipped → the case is not posted (stays pending — a skipped
test is a non-observation). Suite cases with no mapped tests stay pending and are
listed as "uncovered" in the summary.

Use the `map-tests` Claude Code skill (in the
[Maersk-Training/mt-testing-tool](https://github.com/Maersk-Training/mt-testing-tool)
repo under `skills/`) to generate the mapping semi-automatically, and `--dry-run` to
validate it.

## .NET specifics (learned the hard way)

- **Emit JUnit**: `dotnet add package JunitXml.TestLogger`, then
  `dotnet test --logger "junit;LogFilePath=test-results/junit.xml"`.
- **The logger writes method names, not `DisplayName`s** — `@mt` tags in DisplayNames
  never reach the XML. Use `Mt<n>` method tokens (above) or `mappings` patterns, and
  keep method names unique across the project. Verify with `--dry-run`.
- **Two-tier pattern**: `[Trait("Category","Unit")]` (mocked; build-pipeline gate) vs
  `[Trait("Category","Smoke")]` (HTTP against the deployed env; release pipeline,
  after deploy). Filter with `--filter "Category=Unit"` /
  `--TestCaseFilter:"Category=Smoke"`.
- **Classic Release has no source checkout**: `dotnet publish` the test project into
  the build artifact (`drop/tests/`) and run it with the ".NET Core" task using
  Command `custom` + `vstest` — the `run` command does NOT execute arbitrary commands.
- The full ADO runbook (variable groups, stage scoping, exact task configs) lives in
  `skills/onboard-repo/reference.md` in the
  [Maersk-Training/mt-testing-tool](https://github.com/Maersk-Training/mt-testing-tool)
  repo — or run the `onboard-repo` skill.

## Multi-job pipelines

```bash
# job A — creates the run, leaves it open
govgate report unit-results.xml --no-complete       # emits MT_RUN_ID (GH output / ADO variable)

# job B — appends to the same run
govgate report e2e-results.xml --run-id $MT_RUN_ID --no-complete

# final job — completes + gates over everything
govgate complete --run-id $MT_RUN_ID --fail-on fail --min-executed 80
```

See `docs/examples/github-actions-ci-report.yml` and
`docs/examples/azure-devops-ci-report.yml` in the
[Maersk-Training/mt-testing-tool](https://github.com/Maersk-Training/mt-testing-tool)
repo for full pipelines.

## Registry

Published **publicly on npmjs** as `govgate` — it contains no secrets or org-specific
logic, so any pipeline can `npx govgate …` with **zero registry config and zero
tokens**. (This deliberately replaced the earlier private GitHub Packages setup, which
taxed every consuming repo with `.npmrc` + `read:packages` token wiring.)

Releasing: push a `v<version>` tag (or run the *Publish* workflow manually). The
workflow authenticates to npm via **Trusted Publishing (OIDC)** — there is **no
`NPM_TOKEN` secret**; GitHub Actions mints a short-lived identity per run. One-time
setup: configure this repo + `publish-cli.yml` as a trusted publisher on the npm
package's *Settings → Trusted Publishing* page.

**No registry at all** (local/dev): run straight from a checkout —
`node <path-to>/govGate/dist/index.js report …` — or
`npm exec --package=<path-to>.tgz -- govgate …` after `npm pack`.
