#!/usr/bin/env node
/**
 * apply-views.ts
 *
 * Applies scripts/sql/coverage-views.sql to the configured Postgres database
 * using Prisma's $executeRawUnsafe — no external psql binary required.
 *
 * All views are CREATE OR REPLACE, so this is safe to re-run at any time.
 *
 * Usage:
 *   npm run db:views
 */

import "dotenv/config";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { prisma } from "./db/prisma";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── Load SQL file ────────────────────────────────────────────────────────────

const sqlFile = path.join(__dirname, "sql", "coverage-views.sql");
const sql     = fs.readFileSync(sqlFile, "utf8");

// ── Parse into individual view statements ────────────────────────────────────
//
// Strategy: split on any line that begins with "CREATE OR REPLACE VIEW".
// Each resulting chunk that starts with that keyword is one statement.
// Trim trailing comments and whitespace by slicing up to the last semicolon.

function parseViewStatements(source: string): { name: string; sql: string }[] {
  const chunks = source.split(/\n(?=CREATE OR REPLACE VIEW )/);

  return chunks
    .filter((chunk) => chunk.trimStart().startsWith("CREATE OR REPLACE VIEW "))
    .map((chunk) => {
      // Everything up to and including the final ';' in this block
      const semiIdx = chunk.lastIndexOf(";");
      const stmt    = semiIdx >= 0 ? chunk.slice(0, semiIdx + 1).trim() : chunk.trim();

      // Extract view name for logging
      const nameMatch = stmt.match(/^CREATE OR REPLACE VIEW (\w+)/);
      const name      = nameMatch?.[1] ?? "(unknown)";

      return { name, sql: stmt };
    });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const views = parseViewStatements(sql);

  if (views.length === 0) {
    console.error("No CREATE OR REPLACE VIEW statements found in SQL file.");
    process.exit(1);
  }

  console.log(`Applying ${views.length} coverage views...\n`);

  let ok    = 0;
  let failed = 0;

  for (const view of views) {
    try {
      await prisma.$executeRawUnsafe(view.sql);
      console.log(`  ✓  ${view.name}`);
      ok++;
    } catch (err) {
      const msg = (err as Error).message ?? "";

      // PostgreSQL restricts CREATE OR REPLACE in two ways that require
      // a drop-and-recreate workaround:
      //   1. Cannot rename existing columns → "cannot change name of view column"
      //   2. Cannot remove columns          → "cannot drop columns from view"
      // Drop the view with CASCADE (clears dependent views — they'll be
      // recreated as we continue down the dependency-ordered list) then retry.
      if (
        msg.includes("cannot change name of view column") ||
        msg.includes("cannot drop columns from view")
      ) {
        try {
          await prisma.$executeRawUnsafe(
            `DROP VIEW IF EXISTS ${view.name} CASCADE`
          );
          await prisma.$executeRawUnsafe(view.sql);
          const reason = msg.includes("cannot drop columns from view")
            ? "column removal"
            : "column rename";
          console.log(`  ✓  ${view.name}  (drop-recreated: ${reason})`);
          ok++;
        } catch (retryErr) {
          console.error(
            `  ✗  ${view.name}: ${(retryErr as Error).message}`
          );
          failed++;
        }
      } else {
        console.error(`  ✗  ${view.name}: ${msg}`);
        failed++;
        // Continue so we see all errors at once; exit non-zero at the end.
      }
    }
  }

  console.log(`\n${ok} succeeded, ${failed} failed.`);

  if (failed > 0) process.exit(1);
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
