import { XMLParser } from "fast-xml-parser";
import type { ParsedTest } from "./types.js";

type XmlNode = Record<string, unknown>;

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function text(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  const obj = node as XmlNode;
  const parts = [obj["@_message"], obj["@_type"], obj["#text"]]
    .filter((v) => v != null && v !== "")
    .map(String);
  return parts.join(" — ");
}

function parseTestcase(tc: XmlNode): ParsedTest {
  const name = String(tc["@_name"] ?? "(unnamed test)");
  const classname = tc["@_classname"] ? String(tc["@_classname"]) : undefined;
  const file = tc["@_file"] ? String(tc["@_file"]) : undefined;

  let status: ParsedTest["status"] = "pass";
  let message: string | undefined;

  const failure = asArray(tc.failure as XmlNode | XmlNode[])[0];
  const error = asArray(tc.error as XmlNode | XmlNode[])[0];
  if (failure !== undefined || error !== undefined) {
    status = "fail";
    message = text(failure ?? error).trim() || "Test failed (no message in report)";
  } else if (tc.skipped !== undefined) {
    status = "skipped";
  }

  const scope = file ?? classname;
  return {
    id: scope ? `${scope}::${name}` : name,
    name,
    classname,
    file,
    status,
    message,
    timeSec: tc["@_time"] !== undefined ? Number(tc["@_time"]) : undefined,
  };
}

function collectSuites(node: XmlNode, out: XmlNode[]) {
  for (const suite of asArray(node.testsuite as XmlNode | XmlNode[])) {
    out.push(suite);
    collectSuites(suite, out); // nested <testsuite> elements
  }
}

// Parses a JUnit XML document (root <testsuites> or a single <testsuite>).
export function parseJUnitXml(xml: string): ParsedTest[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    parseAttributeValue: false,
    parseTagValue: false,
  });
  const doc = parser.parse(xml) as XmlNode;

  const suites: XmlNode[] = [];
  const root = (doc.testsuites ?? doc) as XmlNode;
  if (doc.testsuites !== undefined) collectSuites(root, suites);
  else if (doc.testsuite !== undefined) collectSuites(doc, suites);

  const tests: ParsedTest[] = [];
  for (const suite of suites) {
    for (const tc of asArray(suite.testcase as XmlNode | XmlNode[])) {
      tests.push(parseTestcase(tc));
    }
  }
  return tests;
}
