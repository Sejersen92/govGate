import { appendFileSync } from "node:fs";
import { hostname } from "node:os";

export type CiContext = {
  provider: "github" | "azure-devops" | "generic";
  defaultRunName: string;
  buildVersion?: string;
  externalUrl?: string;
};

export function detectCiContext(env = process.env): CiContext {
  if (env.GITHUB_ACTIONS === "true") {
    const repo = env.GITHUB_REPOSITORY;
    return {
      provider: "github",
      defaultRunName: `CI — ${env.GITHUB_WORKFLOW ?? "workflow"} #${env.GITHUB_RUN_NUMBER ?? "?"} — ${env.GITHUB_REF_NAME ?? "?"}`,
      buildVersion: env.GITHUB_SHA?.slice(0, 8),
      externalUrl:
        repo && env.GITHUB_RUN_ID
          ? `${env.GITHUB_SERVER_URL ?? "https://github.com"}/${repo}/actions/runs/${env.GITHUB_RUN_ID}`
          : undefined,
    };
  }
  if (env.TF_BUILD === "True") {
    const collection = env.SYSTEM_COLLECTIONURI;
    const project = env.SYSTEM_TEAMPROJECT;
    return {
      provider: "azure-devops",
      defaultRunName: `CI — ${env.BUILD_DEFINITIONNAME ?? "pipeline"} #${env.BUILD_BUILDNUMBER ?? "?"} — ${env.BUILD_SOURCEBRANCHNAME ?? "?"}`,
      buildVersion: env.BUILD_SOURCEVERSION?.slice(0, 8),
      externalUrl:
        collection && project && env.BUILD_BUILDID
          ? `${collection}${encodeURIComponent(project)}/_build/results?buildId=${env.BUILD_BUILDID}`
          : undefined,
    };
  }
  return {
    provider: "generic",
    defaultRunName: `CI — ${hostname()} — ${new Date().toISOString()}`,
  };
}

// Makes the run id available to later pipeline jobs/steps.
export function emitRunIdVariable(runId: string, ctx: CiContext, env = process.env) {
  console.log(`GOVGATE_RUN_ID=${runId}`);
  if (ctx.provider === "github" && env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, `run-id=${runId}\n`);
  } else if (ctx.provider === "azure-devops") {
    console.log(`##vso[task.setvariable variable=GOVGATE_RUN_ID;isOutput=true]${runId}`);
  }
}
