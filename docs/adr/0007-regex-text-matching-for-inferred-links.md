# ADR 0007: Regex Text-Matching for Inferred Links (No LLM)

- **Date:** 2026-03-24
- **Author:** Joe Peters
- **Status:** Accepted

## Context

Trapeze needs to automatically discover links between automated tests and Jira issues / TestRail cases where developers have not written explicit tags. Without inference, coverage analysis is only as complete as developers' discipline in tagging tests — typically 20–40% of the actual coverage.

Several inference strategies were possible:

1. **Regex on structured identifiers** — scan test names and tags for patterns like `QAA-123` (Jira) or `C4567` (TestRail)
2. **Full-text keyword overlap** — compare test name tokens against Jira issue summaries/descriptions
3. **Embedding similarity (LLM/vector)** — embed test names and Jira summaries; link pairs above a cosine threshold
4. **Manual analyst review only** — no automation; analysts create `MANUAL` links directly

## Decision

Use **deterministic regex pattern matching** as the sole inference mechanism:

- Jira keys: `[A-Z][A-Z0-9]{1,9}-\d+` in test names, class names, tags, and JUnit XML `<property>` elements
- TestRail case IDs: `[Cc]\d+` in the same locations
- Title similarity: normalized edit-distance comparison between test name tokens and Jira summary tokens (configurable threshold, default 0.75)

No LLM or embedding model is used. All inference is deterministic and reproducible: the same input always produces the same output.

Results are stored with `provenance=INFERRED, confidence=LOW` (or `MED` for high-similarity title matches). Analysts review and promote to `MANUAL HIGH` as needed.

## Consequences

**Positive:**

- **Deterministic and auditable:** same input → same links; every inferred link has a traceable evidence field (the matched regex capture or similarity score)
- **Fast:** inference over 10,000 tests completes in seconds; no API calls, no GPU, no external service
- **Safe:** low confidence by default prevents false-positive links from corrupting coverage reports
- **Understandable:** any engineer can inspect the regex and understand why a link was or was not created
- **No external dependency:** runs fully offline; no OpenAI/Anthropic API key needed

**Negative:**

- **False negatives:** tests that reference Jira issues in comments, docstrings, or via ticket titles (not IDs) will be missed
- **Pattern sensitivity:** test names like `test_fix_for_QAA_123` may fail the regex if underscores replace hyphens (handled by normalisation pass)
- **Title similarity limits:** generic test names like `test_loads` will not meaningfully match any Jira issue

**Mitigations:**

- `EXPLICIT` links from source code annotations catch what regex misses
- Analysts can add `MANUAL` links for tests that are genuinely hard to match automatically
- The inference threshold is configurable via `--similarity-threshold` flag; teams can tune for precision vs. recall
- False negatives are preferable to false positives in coverage reporting — undercounting coverage is safer than overcounting
