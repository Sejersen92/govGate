# govgate

Pipeline-step CLI for Governance OS: parses standard test output (JUnit XML),
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
| `--url <url>` | `GOVGATE_URL` | Tool deployment URL |
| `--api-key <key>` | `GOVGATE_API_KEY` | API key (env var strongly preferred) |
| `--config <path>` | `govgate/config.json` searched upward | Config file |
| `--suite <slug>` | config `suite` | Target suite |
| `--env <slug>` | inferred, else config `defaultEnvironment` | Environment for the run (overrides inference) |
| `--base-url <url>` | `API_BASEURL` | Live app base URL; matched against the declared environments' `baseUrl`s to infer the environment |
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

### `govgate sync-env`

Upserts the environments declared in `govgate/config.json` to the tool. Idempotent by
slug: an existing `dev` is updated in place, never duplicated. Takes `--url`,
`--api-key`, `--config` (same resolution as `report`). `report` also runs this sync
automatically before creating a run when the block is present, so a brand-new stage
can never fail on an unknown environment — the explicit command exists for
onboarding-time provisioning and for verifying the catalog without reporting.

## Environment inference (v0.5.0+)

When `--env` is absent, `report` resolves the environment **from the deployment
under test**: the base URL (from `--base-url` or the `API_BASEURL` env var — the
same variable your smoke tests already use) is matched against the declared
environments' `baseUrl`s, and the matching slug wins. Falls back to
`defaultEnvironment` when nothing matches. Matching ignores scheme, casing, and
trailing slashes.

This makes one identical report step correct in every stage — no per-stage
`--env` variable to configure or mis-copy. The chosen slug is always printed to
the CI log.

```
npx govgate report "test-results/*.xml" --fail-on fail   # env inferred from API_BASEURL
```

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
3. **Config patterns** in `govgate/config.json`:

```jsonc
{
  "suite": "checkout-regression",
  "defaultEnvironment": "dev",
  // Code-first environment catalog (v0.4.0+): synced to the tool by slug
  // (existing slugs update in place — never duplicated). Slugs are scoped per
  // application, so the plain dev/uat/prod trio is safe for every service; add
  // more (test, pre-prod, demo, …) as needed, up to 20.
  "environments": [
    { "slug": "dev",  "name": "DEV",  "baseUrl": "https://dev.example.com" },
    { "slug": "uat",  "name": "UAT" },
    { "slug": "prod", "name": "PROD", "baseUrl": "https://www.example.com", "notes": "Live." }
  ],
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

Use the `map-tests` Governance OS skill (served by your deployment at
`${GOVGATE_URL}/api/v1/skills`) to generate the mapping semi-automatically, and
`--dry-run` to validate it.

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
- The full ADO runbook (variable groups, stage scoping, exact task configs) is the
  `onboard-repo` Governance OS skill (served at `${GOVGATE_URL}/api/v1/skills`) — run it,
  or read its `reference.md`.

## Multi-job pipelines

```bash
# job A — creates the run, leaves it open
govgate report unit-results.xml --no-complete       # emits GOVGATE_RUN_ID (GH output / ADO variable)

# job B — appends to the same run
govgate report e2e-results.xml --run-id $GOVGATE_RUN_ID --no-complete

# final job — completes + gates over everything
govgate complete --run-id $GOVGATE_RUN_ID --fail-on fail --min-executed 80
```

Full pipeline examples for GitHub Actions and Azure DevOps ship with your Governance OS
deployment (served alongside the skills at `${GOVGATE_URL}/api/v1/skills`).

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
