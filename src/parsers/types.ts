export type ParsedTestStatus = "pass" | "fail" | "skipped";

export type ParsedTest = {
  /** Stable identity used in mapping patterns and summaries: "<file-or-classname>::<name>". */
  id: string;
  name: string;
  classname?: string;
  file?: string;
  status: ParsedTestStatus;
  /** Failure/error message + first lines of the details block, when present. */
  message?: string;
  timeSec?: number;
};
