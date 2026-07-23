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

  it("throws actionable errors for missing url/key", () => {
    expect(() => resolveConfig({}, dir)).toThrow(ConfigError);
    process.env.GOVGATE_URL = "https://x";
    expect(() => resolveConfig({}, dir)).toThrow(/API key/);
  });

  it("distinguishes 'no config found' from 'config found but no suite'", () => {
    process.env.GOVGATE_URL = "https://x";
    process.env.GOVGATE_API_KEY = "mtk_x";

    // Nothing at, above, or below cwd → point the user at the working directory,
    // not at editing a file that does not exist.
    expect(() => resolveConfig({}, dir)).toThrow(/No govgate\/config\.json found/);
    expect(() => resolveConfig({}, dir)).toThrow(new RegExp(dir.replace(/\\/g, "\\\\")));

    // Config exists but omits suite → name the file to edit.
    writeConfig(dir, { defaultEnvironment: "dev" });
    expect(() => resolveConfig({}, dir)).toThrow(/Suite missing in .*config\.json/);
  });

  it("falls back to a config in a SUBFOLDER when none is found upward (release-drop layout)", () => {
    // Mirrors a release drop: govgate/config.json lands under a nested folder and
    // the CI step runs from the drop root, one level above it.
    const drop = join(dir, "_Customer Service", "drop");
    writeConfig(drop, { suite: "customerservice-core", defaultEnvironment: "dev" });
    process.env.GOVGATE_URL = "https://x";
    process.env.GOVGATE_API_KEY = "mtk_x";

    const cfg = resolveConfig({}, dir);
    expect(cfg.suite).toBe("customerservice-core");
    expect(cfg.configPath).toBe(join(drop, "govgate", "config.json"));
  });

  it("prefers an upward config over a downward one", () => {
    writeConfig(dir, { suite: "root-suite" });
    writeConfig(join(dir, "sub"), { suite: "sub-suite" });
    process.env.GOVGATE_URL = "https://x";
    process.env.GOVGATE_API_KEY = "mtk_x";

    // From the root, the upward (nearest) config wins; the subfolder is not scanned.
    expect(resolveConfig({}, dir).suite).toBe("root-suite");
  });

  it("refuses to guess when downward search finds multiple configs (double-suite guard)", () => {
    writeConfig(join(dir, "one"), { suite: "suite-one" });
    writeConfig(join(dir, "two"), { suite: "suite-two" });
    process.env.GOVGATE_URL = "https://x";
    process.env.GOVGATE_API_KEY = "mtk_x";

    expect(() => resolveConfig({}, dir)).toThrow(/Ambiguous config/);
    expect(() => resolveConfig({}, dir)).toThrow(/found 2 govgate\/config\.json/);
  });

  it("rejects malformed mappings", () => {
    writeConfig(dir, { suite: "s", mappings: { abc: ["x"] } });
    process.env.GOVGATE_URL = "https://x";
    process.env.GOVGATE_API_KEY = "mtk_x";
    expect(() => resolveConfig({}, dir)).toThrow(/case number/);
  });
});

describe("environments declaration (code-first catalog)", () => {
  beforeEach(() => {
    process.env.GOVGATE_URL = "https://x";
    process.env.GOVGATE_API_KEY = "mtk_x";
  });

  it("parses a full environments block and exposes it on the resolved config", () => {
    writeConfig(dir, {
      suite: "s",
      defaultEnvironment: "dev",
      environments: [
        { slug: "dev", name: "DEV", baseUrl: "https://dev.example", notes: "sandbox" },
        { slug: "uat", name: "UAT" },
        { slug: "prod", name: "PROD", baseUrl: "https://www.example" },
      ],
    });
    const cfg = resolveConfig({}, dir);
    expect(cfg.environments).toEqual([
      { slug: "dev", name: "DEV", baseUrl: "https://dev.example", notes: "sandbox" },
      { slug: "uat", name: "UAT" },
      { slug: "prod", name: "PROD", baseUrl: "https://www.example" },
    ]);
  });

  it("is optional — configs without the block resolve with environments undefined", () => {
    writeConfig(dir, { suite: "s" });
    expect(resolveConfig({}, dir).environments).toBeUndefined();
  });

  it("rejects a non-array environments value", () => {
    writeConfig(dir, { suite: "s", environments: { dev: "DEV" } });
    expect(() => resolveConfig({}, dir)).toThrow(/"environments" must be an array/);
  });

  it("rejects invalid slugs (uppercase, leading hyphen, non-string)", () => {
    for (const slug of ["DEV", "-dev", 7]) {
      writeConfig(dir, { suite: "s", environments: [{ slug, name: "DEV" }] });
      expect(() => resolveConfig({}, dir)).toThrow(/environments\[0\]\.slug/);
    }
  });

  it("rejects duplicate slugs — the whole point is one row per environment", () => {
    writeConfig(dir, {
      suite: "s",
      environments: [
        { slug: "dev", name: "DEV" },
        { slug: "dev", name: "DEV again" },
      ],
    });
    expect(() => resolveConfig({}, dir)).toThrow(/duplicate environment slug "dev"/);
  });

  it("rejects a missing or empty name", () => {
    writeConfig(dir, { suite: "s", environments: [{ slug: "dev" }] });
    expect(() => resolveConfig({}, dir)).toThrow(/environments\[0\]\.name/);
    writeConfig(dir, { suite: "s", environments: [{ slug: "dev", name: "  " }] });
    expect(() => resolveConfig({}, dir)).toThrow(/environments\[0\]\.name/);
  });

  it("rejects more than 20 entries (server-side PUT limit)", () => {
    writeConfig(dir, {
      suite: "s",
      environments: Array.from({ length: 21 }, (_, i) => ({ slug: `env-${i}`, name: `E${i}` })),
    });
    expect(() => resolveConfig({}, dir)).toThrow(/at most 20/);
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
