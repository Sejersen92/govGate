import type { StatusCounts } from "./gate.js";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export type CreateRunResponse = {
  runId: string;
  suite: string;
  environment: string | null;
  totalCases: number;
  autoNa: number;
};

export type RunSummary = {
  runId: string;
  name: string;
  status: string;
  source: string;
  environment: string | null;
  counts: StatusCounts;
  executedPercent: number;
};

export type ResultPayload = {
  caseNumber: number;
  status: "pass" | "fail";
  notes?: string;
  actor?: string;
};

const BATCH_SIZE = 500;

export class ApiClient {
  constructor(
    private baseUrl: string,
    private apiKey: string,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new ApiError(`Could not reach ${this.baseUrl}: ${(e as Error).message}`, 0);
    }
    const text = await res.text();
    if (!res.ok) {
      let detail = text;
      try {
        detail = (JSON.parse(text) as { error?: string }).error ?? text;
      } catch {
        // non-JSON error body
      }
      throw new ApiError(`${method} ${path} -> ${res.status}: ${detail}`, res.status);
    }
    return JSON.parse(text) as T;
  }

  createRun(input: {
    suiteSlug: string;
    environmentSlug?: string;
    name: string;
    buildVersion?: string;
    externalUrl?: string;
  }): Promise<CreateRunResponse> {
    return this.request("POST", "/api/v1/runs", { ...input, source: "ci" });
  }

  async postResults(
    runId: string,
    results: ResultPayload[],
  ): Promise<{ updated: number; unknownCaseNumbers: number[] }> {
    let updated = 0;
    const unknownCaseNumbers: number[] = [];
    for (let i = 0; i < results.length; i += BATCH_SIZE) {
      const batch = results.slice(i, i + BATCH_SIZE);
      const res = await this.request<{ updated: number; unknownCaseNumbers: number[] }>(
        "POST",
        `/api/v1/runs/${runId}/results`,
        { results: batch },
      );
      updated += res.updated;
      unknownCaseNumbers.push(...res.unknownCaseNumbers);
    }
    return { updated, unknownCaseNumbers };
  }

  completeRun(runId: string): Promise<{ runId: string; status: string }> {
    return this.request("PATCH", `/api/v1/runs/${runId}`, { status: "completed" });
  }

  getSummary(runId: string): Promise<RunSummary> {
    return this.request("GET", `/api/v1/runs/${runId}/summary`);
  }

  getSuiteCases(slug: string): Promise<{ cases: { caseNumber: number; title: string }[] }> {
    return this.request("GET", `/api/v1/suites/${slug}/cases`);
  }
}
