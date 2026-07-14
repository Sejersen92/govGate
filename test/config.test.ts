import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, loadFileMappings, resolveConfig } from "../src/config.js";

let dir: string;
const savedEnv = { ...process.env };

// Writes govgate/config.json under baseDir (creating the govgate/ folder).
function writeConfig(baseDir: string, obj: unknown): void {
  const govDir = join(baseDir, "govgate");
  mkdirSync(govDir, { recursive: true });
  writeFileSync(join(govDir, "config.json"), JSON.stringify(obj));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mtcli-"));
  delete process.env.GOVGATE_URL;
  delete process.env.GOVGATE_API_KEY;
});

afterEach(() => {
  process.env = { ...savedEnv };
});

describe("resolveConfig", () => {
  it("reads govgate/config.json found upward from cwd", () => {
    writeConfig(dir, { suite: "s1", defaultEnvironment: "dev", mappings: { "3": ["*x*"] } });
    const nested = join(dir, "a", "b");
    mkdirSync(nested, { recursive: true });
    process.env.GOVGATE_URL = "https://tool.example/";
    process.env.GOVGATE_API_KEY = "mtk_test";

    const cfg = resolveConfig({}, nested);
    expect(cfg.suite).toBe("s1");
    expect(cfg.environment).toBe("dev");
    expect(cfg.mappings).toEqual({ "3": ["*x*"] });
    expect(cfg.url).toBe("https://tool.example"); // trailing slash stripped
  });

  it("flags override env and file", () => {
    writeConfig(dir, { suite: "file-suite" });
    process.env.GOVGATE_URL = "https://env.example";
    process.env.GOVGATE_API_KEY = "mtk_env";

    const cfg = resolveConfig({ suite: "flag-suite", url: "https://flag.example" }, dir);
    expect(cfg.suite).toBe("flag-suite");
    expect(cfg.url).toBe("https://flag.example");
    expect(cfg.apiKey).toBe("mtk_env");
  });

  it("throws actionable errors for missing url/key/suite", () => {
    expect(() => resolveConfig({}, dir)).toThrow(ConfigError);
    process.env.GOVGATE_URL = "https://x";
    expect(() => resolveConfig({}, dir)).toThrow(/API key/);
    process.env.GOVGATE_API_KEY = "mtk_x";
    expect(() => resolveConfig({}, dir)).toThrow(/Suite/);
  });

  it("rejects malformed mappings", () => {
    writeConfig(dir, { suite: "s", mappings: { abc: ["x"] } });
    process.env.GOVGATE_URL = "https://x";
    process.env.GOVGATE_API_KEY = "mtk_x";
    expect(() => resolveConfig({}, dir)).toThrow(/case number/);
  });
});

describe("loadFileMappings (dry-run, credential-free)", () => {
  it("loads mappings from govgate/config.json with NO url/apiKey set", () => {
    // Regression: --dry-run must resolve mappings offline. Previously it went
    // through resolveConfig, which threw on the missing API key and left every
    // test 'unmapped' — silently defeating the dry run's purpose.
    writeConfig(dir, {
      suite: "development",
      defaultEnvironment: "learnerservice-dev",
      mappings: { "5": ["*Duplicate_Active_Email*"], "28": ["*SoftDelete_Resolves*"] },
    });
    // deliberately no GOVGATE_URL / _API_KEY in env (cleared in beforeEach)
    const cfg = loadFileMappings({}, dir);
    expect(cfg.mappings).toEqual({
      "5": ["*Duplicate_Active_Email*"],
      "28": ["*SoftDelete_Resolves*"],
    });
    expect(cfg.suite).toBe("development");
    expect(cfg.environment).toBe("learnerservice-dev");
  });

  it("returns empty mappings (not a throw) when no config file exists", () => {
    const cfg = loadFileMappings({}, dir);
    expect(cfg.mappings).toEqual({});
    expect(cfg.suite).toBeUndefined();
  });
});
