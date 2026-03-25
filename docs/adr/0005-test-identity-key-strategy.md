# ADR 0005: Test Identity Key Strategy (Framework-Specific)

- **Date:** 2026-03-24
- **Author:** Joe Peters
- **Status:** Accepted

## Context

`TestCase.identityKey` is the canonical cross-reference for deduplicating tests across builds, frameworks, and ingestion runs. It must be:

- **Stable:** the same test produces the same key across builds
- **Unique:** two different tests never produce the same key
- **Deterministic:** the key can be recomputed from the test artifact alone (no central registry needed)

Two frameworks are in use with fundamentally different metadata structures:

- **JUnit (Selenium/pytest):** XML attributes `classname` and `name` (method name); already in production
- **Playwright:** JSON includes `spec.id` (file path), `title` (test name), and an array of ancestor `describe()` titles

## Decision

**JUnit/pytest identity key:** `md5(className#methodName)`

The hash was chosen for backwards compatibility with an existing production dataset where the hash was already the primary key format. Changing it would orphan all existing `JiraAutomationLink` and `AutomationTestRailLink` rows.

**Playwright identity key:** `"{filePath}::{describePath.join(' > ')}"` (human-readable, no hashing)

Example: `src/tests/checkout.spec.ts::Checkout Flow > with promo code`

This uses Playwright's native `spec.id` structure. It is human-readable in logs, queries, and the Metabase UI. It is stable as long as the test file path and `describe()` hierarchy do not change.

## Consequences

**Positive (Playwright):**

- Developers can read the identity key in error messages and query results without decoding a hash
- The key encodes structural information (file + describe nesting) useful for grouping in Metabase
- No central registry or sequencing needed — key is derivable from the JSON artifact

**Positive (JUnit):**

- Backwards compatible with the existing production dataset
- Hash format prevents key length issues with very long classname + methodname combinations

**Negative:**

- Test renames break the Playwright identity key — historical results for the renamed test are orphaned (no automatic re-linking)
- File moves break the key (classname-equivalent change in Playwright)
- Two different key formats create inconsistency; developers must know which format applies to which framework

**Mitigations:**

- Test renames are infrequent; when they occur, an analyst can update `TestCase.identityKey` directly or re-run inference scripts with `--full-sync`
- The JUnit format is documented as legacy; new frameworks should use the Playwright readable-string pattern
- `TestCase` table has a `framework` column so queries can apply the correct deduplication logic
