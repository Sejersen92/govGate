import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Mappings } from "./mapping.js";

export type FileConfig = {
  suite?: string;
  defaultEnvironment?: string;
  mappings?: Mappings;
};

export type ResolvedConfig = {
  url: string;
  apiKey: string;
  suite: string;
  environment?: string;
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

export type ConfigFlags = {
  url?: string;
  apiKey?: string;
  suite?: string;
  env?: string;
  config?: string;
};

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
export function resolveConfig(flags: ConfigFlags, cwd = process.cwd()): ResolvedConfig {
  const configPath = findConfigFile(cwd, flags.config);
  const file: FileConfig = configPath ? loadFileConfig(configPath) : {};

  const url = flags.url ?? process.env.GOVGATE_URL;
  const apiKey = flags.apiKey ?? process.env.GOVGATE_API_KEY;
  const suite = flags.suite ?? file.suite;
  const environment = flags.env ?? file.defaultEnvironment;

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
    mappings: file.mappings ?? {},
    configPath,
  };
}
