import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, loadFileMappings, resolveConfig } from "../src/config.js";

let dir: string;
const savedEnv = { ...process.env };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mtcli-"));
  delete process.env.MT_TESTING_TOOL_URL;
  delete process.env.MT_TESTING_TOOL_API_KEY;
});

afterEach(() => {
  process.env = { ...savedEnv };
});

describe("resolveConfig", () => {
  it("reads .mt-testing.json found upward from cwd", () => {
    writeFileSync(
      join(dir, ".mt-testing.json"),
      JSON.stringify({ suite: "s1", defaultEnvironment: "dev", mappings: { "3": ["*x*"] } }),
    );
    const nested = join(dir, "a", "b");
    mkdirSync(nested, { recursive: true });
    process.env.MT_TESTING_TOOL_URL = "https://tool.example/";
    process.env.MT_TESTING_TOOL_API_KEY = "mtk_test";

    const cfg = resolveConfig({}, nested);
    expect(cfg.suite).toBe("s1");
    expect(cfg.environment).toBe("dev");
    expect(cfg.mappings).toEqual({ "3": ["*x*"] });
    expect(cfg.url).toBe("https://tool.example"); // trailing slash stripped
  });

  it("flags override env and file", () => {
    writeFileSync(join(dir, ".mt-testing.json"), JSON.stringify({ suite: "file-suite" }));
    process.env.MT_TESTING_TOOL_URL = "https://env.example";
    process.env.MT_TESTING_TOOL_API_KEY = "mtk_env";

    const cfg = resolveConfig({ suite: "flag-suite", url: "https://flag.example" }, dir);
    expect(cfg.suite).toBe("flag-suite");
    expect(cfg.url).toBe("https://flag.example");
    expect(cfg.apiKey).toBe("mtk_env");
  });

  it("throws actionable errors for missing url/key/suite", () => {
    expect(() => resolveConfig({}, dir)).toThrow(ConfigError);
    process.env.MT_TESTING_TOOL_URL = "https://x";
    expect(() => resolveConfig({}, dir)).toThrow(/API key/);
    process.env.MT_TESTING_TOOL_API_KEY = "mtk_x";
    expect(() => resolveConfig({}, dir)).toThrow(/Suite/);
  });

  it("rejects malformed mappings", () => {
    writeFileSync(
      join(dir, ".mt-testing.json"),
      JSON.stringify({ suite: "s", mappings: { abc: ["x"] } }),
    );
    process.env.MT_TESTING_TOOL_URL = "https://x";
    process.env.MT_TESTING_TOOL_API_KEY = "mtk_x";
    expect(() => resolveConfig({}, dir)).toThrow(/case number/);
  });
});

describe("loadFileMappings (dry-run, credential-free)", () => {
  it("loads mappings from .mt-testing.json with NO url/apiKey set", () => {
    // Regression: --dry-run must resolve mappings offline. Previously it went
    // through resolveConfig, which threw on the missing API key and left every
    // test 'unmapped' — silently defeating the dry run's purpose.
    writeFileSync(
      join(dir, ".mt-testing.json"),
      JSON.stringify({
        suite: "development",
        defaultEnvironment: "learnerservice-dev",
        mappings: { "5": ["*Duplicate_Active_Email*"], "28": ["*SoftDelete_Resolves*"] },
      }),
    );
    // deliberately no MT_TESTING_TOOL_URL / _API_KEY in env (cleared in beforeEach)
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
