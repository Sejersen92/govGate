import { readFileSync, existsSync } from "node:fs";
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

// Searches upward from cwd for .mt-testing.json (repo-root convention).
export function findConfigFile(startDir: string, explicitPath?: string): string | undefined {
  if (explicitPath) {
    const p = resolve(startDir, explicitPath);
    if (!existsSync(p)) throw new ConfigError(`Config file not found: ${p}`);
    return p;
  }
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, ".mt-testing.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
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
// .mt-testing.json — WITHOUT requiring url/apiKey. --dry-run uses this so that
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

// Precedence: flags > environment variables > .mt-testing.json.
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
    throw new ConfigError(
      'Suite missing. Pass --suite <slug> or add { "suite": "<slug>" } to .mt-testing.json in the repo root.',
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
