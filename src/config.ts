import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Mappings } from "./mapping.js";

// Code-first environment catalog: declared in govgate/config.json, upserted to
// the tool by slug (existing slugs are updated, never duplicated). The repo is
// the source of truth; the web app is for curation (notes, deleting unused).
export type EnvironmentDeclaration = {
  slug: string;
  name: string;
  baseUrl?: string;
  notes?: string;
};

export type FileConfig = {
  suite?: string;
  defaultEnvironment?: string;
  environments?: EnvironmentDeclaration[];
  mappings?: Mappings;
};

export type ResolvedConfig = {
  url: string;
  apiKey: string;
  suite: string;
  environment?: string;
  environments?: EnvironmentDeclaration[];
  mappings: Mappings;
  configPath?: string;
};

export class ConfigError extends Error {}

// Directories a downward search never needs to enter — build output, VCS, and
// dependency trees. Keeps the fallback scan cheap and avoids matching a
// govgate/config.json that got vendored into a dependency.
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".vs",
  ".vscode",
  ".idea",
  "dist",
  "build",
  "bin",
  "obj",
  "coverage",
  ".turbo",
  ".cache",
]);
const DOWNWARD_MAX_DEPTH = 6;

// Searches upward from startDir for govgate/config.json (repo-root convention).
function findConfigUpward(startDir: string): string | undefined {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, "govgate", "config.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

// Fallback for when the config sits in a SUBFOLDER of the working directory —
// e.g. a release drop where govgate/config.json lands under
// _<artifact>/drop/govgate/ and the CI step runs from the drop root. Bounded
// breadth-first scan; returns every govgate/config.json found (deduped, sorted)
// so the caller can refuse to guess when there is more than one.
function findConfigDownward(startDir: string): string[] {
  const root = resolve(startDir);
  const found: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

  while (queue.length > 0) {
    const { dir, depth } = queue.shift()!;

    const direct = join(dir, "govgate", "config.json");
    if (existsSync(direct)) found.push(direct);

    if (depth >= DOWNWARD_MAX_DEPTH) continue;

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable dir (permissions, race) — skip, don't fail discovery
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "govgate") continue; // already probed via `direct`
      if (SKIP_DIRS.has(entry.name)) continue;
      queue.push({ dir: join(dir, entry.name), depth: depth + 1 });
    }
  }

  return [...new Set(found)].sort();
}

// Resolves govgate/config.json. Precedence: explicit --config, then the
// repo-root convention (nearest config at or above cwd), then a bounded
// downward scan so the tool still works when run one level away from the
// config (the common release-drop case). A downward scan that finds MORE than
// one config refuses to guess — an ambiguous suite is reported, never silently
// picked.
export function findConfigFile(startDir: string, explicitPath?: string): string | undefined {
  if (explicitPath) {
    const p = resolve(startDir, explicitPath);
    if (!existsSync(p)) throw new ConfigError(`Config file not found: ${p}`);
    return p;
  }

  const upward = findConfigUpward(startDir);
  if (upward) return upward;

  const downward = findConfigDownward(startDir);
  if (downward.length === 1) {
    // Visible in CI logs so an unexpected auto-discovery is never silent.
    console.error(
      `govgate: no govgate/config.json at or above ${resolve(startDir)}; using discovered ${downward[0]}`,
    );
    return downward[0];
  }
  if (downward.length > 1) {
    throw new ConfigError(
      `Ambiguous config: found ${downward.length} govgate/config.json files under ${resolve(
        startDir,
      )} and none at or above it:\n${downward
        .map((p) => `  - ${p}`)
        .join(
          "\n",
        )}\nPick one with --config <path>, pass --suite <slug>, or run govgate from the intended directory.`,
    );
  }

  return undefined;
}

export function loadFileConfig(path: string): FileConfig {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new ConfigError(`Could not parse ${path}: ${(e as Error).message}`);
  }
  if (typeof data !== "object" || data === null) {
    throw new ConfigError(`${path} must contain a JSON object`);
  }
  const cfg = data as Record<string, unknown>;
  const out: FileConfig = {};
  if (cfg.suite !== undefined) {
    if (typeof cfg.suite !== "string") throw new ConfigError(`${path}: "suite" must be a string`);
    out.suite = cfg.suite;
  }
  if (cfg.defaultEnvironment !== undefined) {
    if (typeof cfg.defaultEnvironment !== "string")
      throw new ConfigError(`${path}: "defaultEnvironment" must be a string`);
    out.defaultEnvironment = cfg.defaultEnvironment;
  }
  if (cfg.environments !== undefined) {
    out.environments = parseEnvironments(path, cfg.environments);
  }
  if (cfg.mappings !== undefined) {
    if (typeof cfg.mappings !== "object" || cfg.mappings === null)
      throw new ConfigError(`${path}: "mappings" must be an object`);
    const mappings: Mappings = {};
    for (const [key, value] of Object.entries(cfg.mappings as Record<string, unknown>)) {
      if (!/^\d+$/.test(key))
        throw new ConfigError(`${path}: mapping key "${key}" must be a case number`);
      if (!Array.isArray(value) || value.some((v) => typeof v !== "string"))
        throw new ConfigError(`${path}: mappings["${key}"] must be an array of pattern strings`);
      mappings[key] = value as string[];
    }
    out.mappings = mappings;
  }
  return out;
}

// Server-side limit on PUT /api/v1/environments; validated here so a too-long
// catalog fails with a file-and-line message instead of an API 400.
const MAX_ENVIRONMENTS = 20;
// Matches the tool's slug rules (lowercase alphanumeric + hyphens).
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

function parseEnvironments(path: string, raw: unknown): EnvironmentDeclaration[] {
  if (!Array.isArray(raw)) throw new ConfigError(`${path}: "environments" must be an array`);
  if (raw.length > MAX_ENVIRONMENTS)
    throw new ConfigError(`${path}: "environments" supports at most ${MAX_ENVIRONMENTS} entries`);
  const seen = new Set<string>();
  const out: EnvironmentDeclaration[] = [];
  for (const [i, entry] of raw.entries()) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry))
      throw new ConfigError(`${path}: environments[${i}] must be an object`);
    const e = entry as Record<string, unknown>;
    if (typeof e.slug !== "string" || !SLUG_RE.test(e.slug))
      throw new ConfigError(
        `${path}: environments[${i}].slug must be a lowercase slug (a-z, 0-9, hyphens)`,
      );
    if (seen.has(e.slug))
      throw new ConfigError(`${path}: duplicate environment slug "${e.slug}"`);
    seen.add(e.slug);
    if (typeof e.name !== "string" || e.name.trim() === "")
      throw new ConfigError(`${path}: environments[${i}].name must be a non-empty string`);
    if (e.baseUrl !== undefined && typeof e.baseUrl !== "string")
      throw new ConfigError(`${path}: environments[${i}].baseUrl must be a string`);
    if (e.notes !== undefined && typeof e.notes !== "string")
      throw new ConfigError(`${path}: environments[${i}].notes must be a string`);
    const decl: EnvironmentDeclaration = { slug: e.slug, name: e.name };
    if (e.baseUrl !== undefined) decl.baseUrl = e.baseUrl;
    if (e.notes !== undefined) decl.notes = e.notes;
    out.push(decl);
  }
  return out;
}

export type ConfigFlags = {
  url?: string;
  apiKey?: string;
  suite?: string;
  env?: string;
  config?: string;
  baseUrl?: string;
};

// Normalizes a base URL for catalog comparison: scheme is ignored (http vs
// https never distinguishes environments), host and path are lowercased, and
// trailing slashes are stripped — so "https://App.example/" and
// "app.example" compare equal. Returns undefined for unparseable input.
export function normalizeBaseUrl(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return undefined;
  }
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.host}${path}`.toLowerCase();
}

// Code-first environment selection: matches the base URL of the app that was
// actually tested against the declared catalog's baseUrls and returns the
// matching slug. This is what lets one identical report step serve every
// stage — the environment is derived from the deployment under test instead
// of a per-stage variable that can be mis-copied.
export function inferEnvironment(
  environments: EnvironmentDeclaration[] | undefined,
  baseUrl: string | undefined,
): string | undefined {
  if (!baseUrl || !environments?.length) return undefined;
  const target = normalizeBaseUrl(baseUrl);
  if (!target) return undefined;
  for (const env of environments) {
    if (env.baseUrl && normalizeBaseUrl(env.baseUrl) === target) return env.slug;
  }
  return undefined;
}

export type FileMappingConfig = {
  mappings: Mappings;
  suite?: string;
  environment?: string;
  configPath?: string;
};

// Loads only the file-level config (mappings/suite/environment) from
// govgate/config.json — WITHOUT requiring url/apiKey. --dry-run uses this so that
// mapping resolution works offline (the whole point of a dry run); credentials
// gate only the suite-case validation, never the mapping itself.
export function loadFileMappings(
  flags: Pick<ConfigFlags, "config" | "suite" | "env">,
  cwd = process.cwd(),
): FileMappingConfig {
  const configPath = findConfigFile(cwd, flags.config);
  const file: FileConfig = configPath ? loadFileConfig(configPath) : {};
  return {
    mappings: file.mappings ?? {},
    suite: flags.suite ?? file.suite,
    environment: flags.env ?? file.defaultEnvironment,
    configPath,
  };
}

// Precedence: flags > environment variables > govgate/config.json.
// Environment specifically: --env > baseUrl inference (--base-url / API_BASEURL
// matched against the declared catalog) > defaultEnvironment.
export function resolveConfig(flags: ConfigFlags, cwd = process.cwd()): ResolvedConfig {
  const configPath = findConfigFile(cwd, flags.config);
  const file: FileConfig = configPath ? loadFileConfig(configPath) : {};

  const url = flags.url ?? process.env.GOVGATE_URL;
  const apiKey = flags.apiKey ?? process.env.GOVGATE_API_KEY;
  const suite = flags.suite ?? file.suite;

  let environment = flags.env;
  if (!environment) {
    const liveBaseUrl = flags.baseUrl ?? process.env.API_BASEURL;
    const inferred = inferEnvironment(file.environments, liveBaseUrl);
    if (inferred) {
      // Visible in CI logs so the run is never attached to a slug silently.
      console.error(`govgate: environment '${inferred}' inferred from base URL ${liveBaseUrl}`);
      environment = inferred;
    } else {
      if (liveBaseUrl && file.environments?.some((e) => e.baseUrl)) {
        console.error(
          `govgate: base URL ${liveBaseUrl} matches no declared environment baseUrl` +
            (file.defaultEnvironment
              ? `; falling back to defaultEnvironment '${file.defaultEnvironment}'`
              : " and no defaultEnvironment is set"),
        );
      }
      environment = file.defaultEnvironment;
    }
  }

  if (!url) {
    throw new ConfigError(
      "Tool URL missing. Set GOVGATE_URL or pass --url https://<your-deployment>",
    );
  }
  if (!apiKey) {
    throw new ConfigError(
      "API key missing. Set GOVGATE_API_KEY (create one in the tool: Admin -> API keys, scoped to this application).",
    );
  }
  if (!suite) {
    if (!configPath) {
      throw new ConfigError(
        `No govgate/config.json found (searched upward from ${resolve(
          cwd,
        )}, then downward). Run govgate from your repo root or the artifact/drop folder that contains govgate/, pass --config <path>, or pass --suite <slug>.`,
      );
    }
    throw new ConfigError(
      `Suite missing in ${configPath}. Add { "suite": "<slug>" } to that file or pass --suite <slug>.`,
    );
  }

  return {
    url: url.replace(/\/+$/, ""),
    apiKey,
    suite,
    environment,
    environments: file.environments,
    mappings: file.mappings ?? {},
    configPath,
  };
}
