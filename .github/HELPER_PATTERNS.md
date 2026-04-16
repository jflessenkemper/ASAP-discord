# Helper Patterns Registry

Extracted helpers that replace repeated inline code. **Use these instead of raw patterns.**
Riley: read this file during `identify-blocker` and `dedup-discipline` checks to enforce compliance.

## Error Handling

| Helper | File | Replaces | Max allowed raw occurrences |
|--------|------|----------|-----------------------------|
| `errMsg(err)` | `src/utils/errors.ts` | `err instanceof Error ? err.message : 'Unknown'` and variants | 35 (intentional: stack-trace variants using `.stack \|\| .message`, custom fallbacks like `'permission denied'`, `'startup failure'`, and `new Error(String(err))` wrappers) |

**Rule:** Every new `catch` block should use `errMsg(err)` unless a custom fallback string is required.

## Memory CRUD

| Helper | File | Replaces |
|--------|------|----------|
| `upsertMemory(fileName, content)` | `src/discord/memory.ts` | `INSERT INTO agent_memory ... ON CONFLICT DO UPDATE SET content = $2` |
| `appendMemoryRow(fileName, content)` | `src/discord/memory.ts` | `INSERT INTO agent_memory ... ON CONFLICT DO UPDATE SET content = content \|\| '\n' \|\| $2` |
| `readMemoryRow(fileName)` | `src/discord/memory.ts` | `SELECT content FROM agent_memory WHERE file_name = $1` |

**Rule:** New memory persistence should normally use the helpers above. The current intentional raw `agent_memory` writes are limited to the helper layer plus a few runtime-specific persistence sites such as tooling and dynamic-agent registry state.

## General Deduplication Rule

> If a code pattern appears **3 or more times**, extract it into a shared helper.
> Document the helper in this file so Riley can enforce it.
