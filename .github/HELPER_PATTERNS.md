# Helper Patterns Registry

Extracted helpers that replace repeated inline code. **Use these instead of raw patterns.**
Riley: read this file during `identify-blocker` and `dedup-discipline` checks to enforce compliance.

## Error Handling

| Helper | File | Replaces | Max allowed raw occurrences |
|--------|------|----------|-----------------------------|
| `errMsg(err)` | `src/utils/errors.ts` | `err instanceof Error ? err.message : 'Unknown'` and variants | 14 (intentional custom fallbacks like `'permission denied'`, `'startup failure'`) |

**Rule:** Every new `catch` block should use `errMsg(err)` unless a custom fallback string is required.

## Memory CRUD

| Helper | File | Replaces |
|--------|------|----------|
| `upsertMemory(fileName, content)` | `src/discord/memory.ts` | `INSERT INTO agent_memory ... ON CONFLICT DO UPDATE SET content = $2` |
| `appendMemoryRow(fileName, content)` | `src/discord/memory.ts` | `INSERT INTO agent_memory ... ON CONFLICT DO UPDATE SET content = content \|\| '\n' \|\| $2` |
| `readMemoryRow(fileName)` | `src/discord/memory.ts` | `SELECT content FROM agent_memory WHERE file_name = $1` |

**Rule:** No raw `INSERT INTO agent_memory` outside of `src/discord/memory.ts` and `src/discord/repoMemoryIndexer.ts` (transactional batch indexer is exempt).

## Job Timeline

| Helper | File | Replaces |
|--------|------|----------|
| `addTimelineEntry(jobId, eventType, description, createdByType, createdById, evidenceUrl?)` | `src/routes/jobs.ts` | `INSERT INTO job_timeline (job_id, event_type, description, created_by_type, created_by_id, evidence_url)` |

**Rule:** All new job timeline inserts in `src/routes/jobs.ts` must use `addTimelineEntry()`.

## General Deduplication Rule

> If a code pattern appears **3 or more times**, extract it into a shared helper.
> Document the helper in this file so Riley can enforce it.
