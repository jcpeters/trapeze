#!/usr/bin/env node
import "dotenv/config";

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { z } from "zod";

import { prisma } from "./db/prisma";
import { uploadFile, buildKey } from "./storage.js";

// ---------------------------
// Types
// ---------------------------
type ParsedCase = {
  identityKey: string;
  title: string;
  suiteName?: string | null;
  filePath?: string | null;
  status: "PASSED" | "FAILED" | "SKIPPED" | "ERROR";
  durationMs?: number | null;
  errorMessage?: string | null;
  stackTrace?: string | null;
  properties?: any;
  /** Jira issue keys extracted from <properties> elements (e.g. QAA-123). */
  jiraKeys: JiraKeyMatch[];
};

/** A Jira key extracted from a specific <property> element. */
type JiraKeyMatch = {
  issueKey: string;
  propertyName: string; // e.g. "jira", "allure.link.issue"
};

type ParsedRun = {
  suiteName: string;
  totalCount: number;
  passCount: number;
  failCount: number;
  skipCount: number;
  errorCount: number;
  durationMs?: number | null;
  cases: ParsedCase[];
};

// ---------------------------
// Input schema + defaults
// ---------------------------
const IngestArgsSchema = z.object({
  junitPath: z.string().min(1),
  ciProvider: z.string().default("jenkins"),
  jobName: z.string().min(1),
  buildNumber: z.coerce.number().int().nonnegative(),

  suiteName: z.string().optional(),
  framework: z.string().optional(),

  // metadata (optional)
  buildUrl: z.string().optional(),
  gitSha: z.string().optional(),
  branch: z.string().optional(),
  environment: z.string().optional(),
  startedAt: z.coerce.date().optional(),
  finishedAt: z.coerce.date().optional(),

  // Jira link extraction from <properties>
  // Comma-separated list of <property name="..."> values to scan for Jira keys.
  // The property value is scanned with a Jira key regex (PROJECT-123).
  // Set to "" or use --skip-jira-links to disable link writing.
  jiraPropertyNames: z
    .string()
    .default("jira,jira.issue,jira.key,allure.link.issue,allure.link.tms"),
  skipJiraLinks: z.boolean().default(false),

  // TestRail explicit link extraction from <properties>
  // Comma-separated list of <property name="..."> values to scan for TestRail case IDs (C1234).
  // Set to "" or use --skip-tr-links to disable.
  trPropertyNames: z
    .string()
    .default("testrail.case,testrail_case,testrail,tr.case"),
  skipTrLinks: z.boolean().default(false),

  // new flags
  dryRun: z.boolean().default(false),
  explain: z.boolean().default(false),
});

type IngestArgs = z.infer<typeof IngestArgsSchema>;

// ---------------------------
// Helpers
// ---------------------------
function sha256File(absPath: string) {
  const buf = fs.readFileSync(absPath);
  const hash = crypto.createHash("sha256").update(buf).digest("hex");
  return { hash, bytes: buf.length, buf };
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    throw new Error(
      `Invalid JSON argument. If you are passing a path, use positional mode instead.\n` +
        `Error: ${msg}\n` +
        `Got: ${JSON.stringify(s)}`
    );
  }
}

/**
 * Accepts:
 *  - JSON blob as single arg: '{...}'
 *  - JSON blob after --: -- '{...}'
 *  - (fallback) find first token starting with '{'
 */
function tryExtractJsonArg(argv: string[]): unknown | null {
  const cleaned = argv[0] === "--" ? argv.slice(1) : argv;
  if (cleaned.length === 1) {
    const s = cleaned[0].trim();
    if (s.startsWith("{") && s.endsWith("}")) return safeJsonParse(s);
  }
  const candidate = cleaned.find((a) => a.trim().startsWith("{"));
  if (candidate) return safeJsonParse(candidate);
  return null;
}

function toMs(secondsStr?: string | null): number | null {
  if (!secondsStr) return null;
  const n = Number(secondsStr);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 1000);
}

// ---------------------------
// JUnit <properties> extraction
// ---------------------------

/**
 * Parse <property name="..." value="..."/> elements from the body of a
 * <testcase> element. Handles:
 *   - <property name="jira" value="QAA-123"/>       (self-closing)
 *   - <property name="jira">QAA-123</property>       (text body)
 *
 * Looks inside an optional <properties>…</properties> wrapper first;
 * falls back to scanning the raw inner text if no wrapper is present.
 */
function parseTestcaseProperties(
  innerXml: string
): Array<{ name: string; value: string }> {
  const props: Array<{ name: string; value: string }> = [];

  // If there's a <properties> wrapper, limit search to its content.
  const block = innerXml.match(
    /<properties\b[^>]*>([\s\S]*?)<\/properties>/
  );
  const xml = block ? block[1] : innerXml;

  // Match each <property .../> or <property ...>body</property>
  const re = /<property\b([^>]*?)(?:\/>|>([\s\S]*?)<\/property>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1];
    const body = (m[2] ?? "").trim();
    const nameMatch = attrs.match(/\bname="([^"]*)"/);
    const valueMatch = attrs.match(/\bvalue="([^"]*)"/);
    if (nameMatch) {
      props.push({ name: nameMatch[1], value: valueMatch ? valueMatch[1] : body });
    }
  }

  return props;
}

// Matches standard Jira issue keys: PROJECT-123
// Project key: 2–10 uppercase alphanumeric chars starting with a letter.
const JIRA_KEY_RE = /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/g;

function extractJiraKeysFromValue(value: string): string[] {
  const keys: string[] = [];
  let m: RegExpExecArray | null;
  JIRA_KEY_RE.lastIndex = 0;
  while ((m = JIRA_KEY_RE.exec(value)) !== null) keys.push(m[1]);
  return keys;
}

/**
 * Walk the parsed property list and return every Jira key found in a
 * property whose name is in `nameSet` (case-insensitive comparison).
 * Each returned entry records which property it came from (for the evidence
 * string written to jira_automation_link).
 */
function getJiraKeysForCase(
  properties: Array<{ name: string; value: string }>,
  nameSet: Set<string>
): JiraKeyMatch[] {
  const seen = new Set<string>(); // deduplicate keys
  const results: JiraKeyMatch[] = [];

  for (const prop of properties) {
    if (!nameSet.has(prop.name.toLowerCase())) continue;
    for (const issueKey of extractJiraKeysFromValue(prop.value)) {
      if (!seen.has(issueKey)) {
        seen.add(issueKey);
        results.push({ issueKey, propertyName: prop.name });
      }
    }
  }

  return results;
}

// ---------------------------
// JUnit parsing (minimal but robust enough for pytest output)
// ---------------------------
function parseJUnitXml(
  xmlText: string,
  suiteNameFallback?: string,
  propertyNames?: Set<string>
): ParsedRun {
  // NOTE: This is a deliberately lightweight parser for typical pytest junitxml.
  // If you later want richer parsing (properties/system-out/etc), swap this to fast-xml-parser.
  const suiteName = suiteNameFallback ?? "default";

  // find testsuite attributes (first testsuite)
  const testsuiteMatch = xmlText.match(/<testsuite\b[^>]*>/);
  let totalCount = 0,
    failCount = 0,
    skipCount = 0,
    errorCount = 0,
    durationMs: number | null = null;

  if (testsuiteMatch) {
    const tag = testsuiteMatch[0];
    const getAttr = (name: string) => {
      const m = tag.match(new RegExp(`${name}="([^"]*)"`));
      return m ? m[1] : null;
    };
    totalCount = Number(getAttr("tests") ?? "0") || 0;
    failCount = Number(getAttr("failures") ?? "0") || 0;
    skipCount = Number(getAttr("skipped") ?? "0") || 0;
    errorCount = Number(getAttr("errors") ?? "0") || 0;
    durationMs = toMs(getAttr("time"));
  }

  // Parse testcases (regex-based)
  const cases: ParsedCase[] = [];
  const testcaseRe = /<testcase\b([^>]*)>([\s\S]*?)<\/testcase>|<testcase\b([^>]*)\/>/g;

  const attrGet = (attrBlob: string, name: string) => {
    const m = attrBlob.match(new RegExp(`${name}="([^"]*)"`));
    return m ? m[1] : null;
  };

  let m: RegExpExecArray | null;
  while ((m = testcaseRe.exec(xmlText)) !== null) {
    const attrs = (m[1] ?? m[3] ?? "").trim();
    const inner = m[2] ?? "";

    const classname = attrGet(attrs, "classname") ?? "";
    const name = attrGet(attrs, "name") ?? "";
    const time = attrGet(attrs, "time");
    const filePath = null; // pytest doesn't provide file path as attribute; it embeds in <skipped> text sometimes.

    const identityKey = `${classname}::${name}`.trim();
    const title = name || identityKey;

    // determine status
    let status: ParsedCase["status"] = "PASSED";
    let errorMessage: string | null = null;
    let stackTrace: string | null = null;

    if (inner.includes("<skipped")) {
      status = "SKIPPED";
      // capture skipped message attr if present
      const sm = inner.match(/<skipped\b[^>]*message="([^"]*)"/);
      if (sm) errorMessage = sm[1];
    } else if (inner.includes("<failure")) {
      status = "FAILED";
      const fm = inner.match(/<failure\b[^>]*message="([^"]*)"/);
      if (fm) errorMessage = fm[1];
      const body = inner.match(/<failure\b[^>]*>([\s\S]*?)<\/failure>/);
      if (body) stackTrace = body[1].trim() || null;
    } else if (inner.includes("<error")) {
      status = "ERROR";
      const em = inner.match(/<error\b[^>]*message="([^"]*)"/);
      if (em) errorMessage = em[1];
      const body = inner.match(/<error\b[^>]*>([\s\S]*?)<\/error>/);
      if (body) stackTrace = body[1].trim() || null;
    }

    // Extract Jira keys from <properties> if a name set was provided.
    const props = propertyNames
      ? parseTestcaseProperties(inner)
      : [];
    const jiraKeys = propertyNames
      ? getJiraKeysForCase(props, propertyNames)
      : [];

    cases.push({
      identityKey,
      title,
      suiteName,
      filePath,
      status,
      durationMs: toMs(time),
      errorMessage,
      stackTrace,
      properties: null,
      jiraKeys,
    });
  }

  const passCount = Math.max(0, totalCount - failCount - skipCount - errorCount);

  return {
    suiteName,
    totalCount,
    passCount,
    failCount,
    skipCount,
    errorCount,
    durationMs,
    cases,
  };
}

// ---------------------------
// CLI parsing
// ---------------------------
async function parseArgs(argv: string[]): Promise<IngestArgs> {
  const json = tryExtractJsonArg(argv);

  // Mode A: JSON blob
  if (json) return IngestArgsSchema.parse(json);

  // Mode B: positional + flags (recommended)
  const y = await yargs(hideBin(process.argv))
    .scriptName("ingest-junit")
    .usage("$0 <junitPath> --job <jobName> --build <buildNumber> [options]")
    .positional("junitPath", { type: "string", describe: "Path to JUnit XML file" })
    .option("job", { type: "string", demandOption: true, describe: "Jenkins job full name" })
    .option("build", { type: "number", demandOption: true, describe: "Build number" })
    .option("ci", { type: "string", default: "jenkins", describe: "CI provider" })
    .option("suite", { type: "string", describe: "Suite name override" })
    .option("framework", { type: "string", describe: "Framework (pytest/playwright/etc)" })
    .option("buildUrl", { type: "string" })
    .option("gitSha", { type: "string" })
    .option("branch", { type: "string" })
    .option("environment", { type: "string" })
    .option("startedAt", { type: "string", describe: "ISO date/time" })
    .option("finishedAt", { type: "string", describe: "ISO date/time" })
    .option("dryRun", { type: "boolean", default: false, describe: "Parse only, do not write to DB" })
    .option("explain", { type: "boolean", default: false, describe: "Verbose logging" })
    .option("jiraPropertyNames", {
      type: "string",
      default: "jira,jira.issue,jira.key,allure.link.issue,allure.link.tms",
      describe:
        "Comma-separated <property name=...> values to scan for Jira keys (PROJECT-123)",
    })
    .option("skipJiraLinks", {
      type: "boolean",
      default: false,
      describe: "Skip writing jira_automation_link rows even if keys are found",
    })
    .option("trPropertyNames", {
      type: "string",
      default: "testrail.case,testrail_case,testrail,tr.case",
      describe:
        "Comma-separated <property name=...> values to scan for TestRail case IDs (C1234)",
    })
    .option("skipTrLinks", {
      type: "boolean",
      default: false,
      describe: "Skip writing automation_testrail_link rows even if C-IDs are found",
    })
    .help()
    .parse();

  const junitPath = (y._[0] as string | undefined) ?? "";
  const startedAt = y.startedAt ? new Date(y.startedAt) : undefined;
  const finishedAt = y.finishedAt ? new Date(y.finishedAt) : undefined;

  return IngestArgsSchema.parse({
    junitPath,
    ciProvider: y.ci,
    jobName: y.job,
    buildNumber: y.build,
    suiteName: y.suite,
    framework: y.framework,
    buildUrl: y.buildUrl,
    gitSha: y.gitSha,
    branch: y.branch,
    environment: y.environment,
    startedAt,
    finishedAt,
    jiraPropertyNames: y.jiraPropertyNames,
    skipJiraLinks: y.skipJiraLinks,
    trPropertyNames: y.trPropertyNames,
    skipTrLinks: y.skipTrLinks,
    dryRun: y.dryRun,
    explain: y.explain,
  });
}

// ---------------------------
// Main
// ---------------------------
async function main() {
  const args = await parseArgs(process.argv.slice(2));

  const absPath = path.resolve(args.junitPath);
  if (!fs.existsSync(absPath)) {
    throw new Error(`JUnit file not found: ${absPath}`);
  }

  const { hash: fileSha, bytes, buf } = sha256File(absPath);
  const xmlText = buf.toString("utf-8");

  // Build the set of property names to scan for Jira keys (lower-cased for
  // case-insensitive matching; empty string disables property extraction).
  const propertyNameSet: Set<string> | undefined =
    args.skipJiraLinks || !args.jiraPropertyNames.trim()
      ? undefined
      : new Set(
          args.jiraPropertyNames
            .split(",")
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean)
        );

  const parsed = parseJUnitXml(xmlText, args.suiteName, propertyNameSet);

  if (args.explain) {
    console.log(`[explain] junitPath=${absPath}`);
    console.log(`[explain] sha256=${fileSha} bytes=${bytes}`);
    console.log(
      `[explain] parsed suite=${parsed.suiteName} total=${parsed.totalCount} pass=${parsed.passCount} fail=${parsed.failCount} skip=${parsed.skipCount} error=${parsed.errorCount}`
    );
    if (propertyNameSet) {
      console.log(
        `[explain] jiraPropertyNames=${[...propertyNameSet].join(",")}`
      );
    } else {
      console.log("[explain] Jira link extraction disabled (--skip-jira-links)");
    }
  }

  if (args.dryRun) {
    console.log("[dry-run] Parsed JUnit file successfully");
    console.log(`[dry-run] build=${args.jobName} #${args.buildNumber} ci=${args.ciProvider}`);
    console.log(`[dry-run] suite=${parsed.suiteName} framework=${args.framework ?? "unknown"}`);
    console.log(
      `[dry-run] tests=${parsed.totalCount} pass=${parsed.passCount} fail=${parsed.failCount} skip=${parsed.skipCount} error=${parsed.errorCount}`
    );
    console.log(`[dry-run] casesParsed=${parsed.cases.length}`);
    // Show which Jira links would be written
    const allLinks = parsed.cases.flatMap((c) =>
      c.jiraKeys.map((k) => `${c.identityKey} → ${k.issueKey} (${k.propertyName})`)
    );
    if (allLinks.length > 0) {
      console.log(`[dry-run] jiraLinks that would be written (${allLinks.length}):`);
      for (const l of allLinks) console.log(`  ${l}`);
    } else if (propertyNameSet) {
      console.log("[dry-run] No Jira keys found in <properties>.");
    }
    return;
  }

  // Upsert Build
  const build = await prisma.build.upsert({
    where: {
      build_unique_ci_job_number: {
        ciProvider: args.ciProvider,
        jobName: args.jobName,
        buildNumber: args.buildNumber,
      },
    },
    create: {
      ciProvider: args.ciProvider,
      jobName: args.jobName,
      buildNumber: args.buildNumber,
      buildUrl: args.buildUrl,
      gitSha: args.gitSha,
      branch: args.branch,
      environment: args.environment,
      startedAt: args.startedAt,
      finishedAt: args.finishedAt,
    },
    update: {
      buildUrl: args.buildUrl ?? undefined,
      gitSha: args.gitSha ?? undefined,
      branch: args.branch ?? undefined,
      environment: args.environment ?? undefined,
      startedAt: args.startedAt ?? undefined,
      finishedAt: args.finishedAt ?? undefined,
    },
  });

  // Upload source XML to GCS then record the artifact with its permanent gs:// URI.
  // Upload happens before the DB write so we never store a URI that doesn't exist.
  const gcsKey = buildKey(build.id, "source/junit-xml", path.basename(absPath));
  const { gcsUri } = await uploadFile(absPath, gcsKey);

  const artifact = await prisma.rawArtifact.create({
    data: {
      buildId: build.id,
      artifactType: "junit-xml",
      storageUri: gcsUri,
      sha256: fileSha,
      bytes,
    },
  });

  // Create suite row
  const suite = await prisma.testSuite.create({
    data: {
      buildId: build.id,
      suiteName: parsed.suiteName,
      framework: args.framework ?? null,
      durationMs: parsed.durationMs ?? null,
    },
  });

  // Pre-load known Jira issue keys so we can filter links to avoid FK violations.
  // Only needed if we're actually going to write links.
  const knownJiraKeys: Set<string> = propertyNameSet
    ? new Set(
        (await prisma.jiraIssue.findMany({ select: { issueKey: true } })).map(
          (r) => r.issueKey
        )
      )
    : new Set();

  if (args.explain && propertyNameSet) {
    console.log(`[explain] ${knownJiraKeys.size} Jira issue keys in DB for link filtering`);
  }

  // Pre-load known TestRail case IDs for FK safety
  const trPropertyNameSet = args.skipTrLinks
    ? null
    : new Set(args.trPropertyNames.split(",").map((s) => s.trim()).filter(Boolean));

  const knownTrCaseIds: Set<bigint> = trPropertyNameSet
    ? new Set(
        (await prisma.testRailCase.findMany({ select: { trCaseId: true } })).map(
          (r) => r.trCaseId
        )
      )
    : new Set();

  if (args.explain && trPropertyNameSet) {
    console.log(`[explain] ${knownTrCaseIds.size} TestRail case IDs in DB for link filtering`);
    console.log(`[explain] trPropertyNames=${[...trPropertyNameSet].join(",")}`);
  }

  // Upsert test cases + insert results
  let inserted = 0;
  let linksWritten = 0;
  let linksSkipped = 0; // keys found but not in jira_issue yet
  let trLinksWritten = 0;
  let trLinksSkipped = 0; // C-IDs found but not in testrail_case yet

  for (const tc of parsed.cases) {
    const testCase = await prisma.testCase.upsert({
      where: { identityKey: tc.identityKey },
      create: {
        identityKey: tc.identityKey,
        title: tc.title,
        suiteName: tc.suiteName ?? null,
        filePath: tc.filePath ?? null,
        tags: [],
      },
      update: {
        title: tc.title,
        suiteName: tc.suiteName ?? undefined,
        filePath: tc.filePath ?? undefined,
      },
    });

    // Avoid duplicate insert for same (build, testCase, attempt=1) by using upsert-like pattern:
    // Prisma doesn't support composite unique unless you define it; so we "create" and tolerate conflicts later if needed.
    // If you want strict idempotency, add @@unique([buildId, testCaseId, attempt]) to TestCaseResult model.
    await prisma.testCaseResult.create({
      data: {
        testCaseId: testCase.id,
        buildId: build.id,
        suiteId: suite.id,

        executionType: "AUTOMATED",
        status: tc.status,
        durationMs: tc.durationMs ?? null,
        errorMessage: tc.errorMessage ?? null,
        stackTrace: tc.stackTrace ?? null,

        startedAt: args.startedAt ?? null,
        finishedAt: args.finishedAt ?? null,
        attempt: 1,
        properties: tc.properties ?? null,
      },
    });

    inserted += 1;

    // Write jira_automation_link rows for any Jira keys found in <properties>.
    for (const { issueKey, propertyName } of tc.jiraKeys) {
      if (!knownJiraKeys.has(issueKey)) {
        if (args.explain) {
          console.log(
            `[explain] ${tc.identityKey}: Jira key ${issueKey} not in jira_issue — skipping link`
          );
        }
        linksSkipped++;
        continue;
      }

      await prisma.jiraAutomationLink.upsert({
        where: {
          issueKey_testCaseId_provenance: {
            issueKey,
            testCaseId: testCase.id,
            provenance: "EXPLICIT",
          },
        },
        create: {
          issueKey,
          testCaseId: testCase.id,
          provenance: "EXPLICIT",
          confidence: "HIGH",
          evidence: `<property name="${propertyName}"> in JUnit XML`,
          source: "junit-properties",
        },
        update: {
          confidence: "HIGH",
          evidence: `<property name="${propertyName}"> in JUnit XML`,
        },
      });

      if (args.explain) {
        console.log(
          `[explain] Linked ${tc.identityKey} → ${issueKey} (${propertyName})`
        );
      }
      linksWritten++;
    }

    // Write automation_testrail_link rows for any TestRail C-IDs found in <properties>.
    if (trPropertyNameSet) {
      for (const prop of tc.properties ? Object.entries(tc.properties as Record<string, unknown>) : []) {
        const [propName, propValue] = prop;
        if (!trPropertyNameSet.has(propName)) continue;
        if (!propValue) continue;

        // Extract C1234 patterns from the property value
        const re = /(?:@|TR-)?[Cc](\d+)(?!\d)/g;
        const valueStr = String(propValue);
        let m: RegExpExecArray | null;
        while ((m = re.exec(valueStr)) !== null) {
          const trCaseId = BigInt(m[1]);

          if (!knownTrCaseIds.has(trCaseId)) {
            if (args.explain) {
              console.log(
                `[explain] ${tc.identityKey}: TestRail C${trCaseId} not in testrail_case — skipping link`
              );
            }
            trLinksSkipped++;
            continue;
          }

          await prisma.automationTestRailLink.upsert({
            where: {
              testCaseId_trCaseId_provenance: {
                testCaseId: testCase.id,
                trCaseId,
                provenance: "EXPLICIT",
              },
            },
            create: {
              testCaseId: testCase.id,
              trCaseId,
              provenance: "EXPLICIT",
              confidence: "HIGH",
              evidence: `<property name="${propName}"> in JUnit XML`,
              source: "testrail-property",
            },
            update: {
              confidence: "HIGH",
              evidence: `<property name="${propName}"> in JUnit XML`,
            },
          });

          if (args.explain) {
            console.log(
              `[explain] TR Linked ${tc.identityKey} → C${trCaseId} (${propName})`
            );
          }
          trLinksWritten++;
        }
      }
    }
  }

  const linkSummary =
    propertyNameSet
      ? ` jiraLinksWritten=${linksWritten} jiraLinksSkipped=${linksSkipped}`
      : "";

  const trLinkSummary =
    trPropertyNameSet
      ? ` trLinksWritten=${trLinksWritten} trLinksSkipped=${trLinksSkipped}`
      : "";

  console.log(
    `Ingest complete: build=${args.jobName} #${args.buildNumber} suite=${parsed.suiteName} resultsInserted=${inserted}${linkSummary}${trLinkSummary} artifact=${artifact.id}`
  );
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
