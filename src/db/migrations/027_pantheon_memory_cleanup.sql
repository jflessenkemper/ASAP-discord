-- 027: One-time memory hygiene — rewrite legacy specialist names that
-- survived the Riley→Cortana + pre-pantheon→pantheon rename in stored
-- memory summaries. These ghost names ("Ace", "Kai", "Jude", "Riley") leak
-- back into Cortana's context after compression and cause her to mention
-- agents that no longer exist.
--
-- Idempotent: re-running is safe; rewrites only land on rows that still
-- contain the legacy tokens.

-- Display-name remapping (whole-word). Order matters: the more specific
-- "Riley (" must run before bare "Riley" so the parenthetical role label
-- gets stripped cleanly.
UPDATE agent_memory
   SET content = regexp_replace(
                   regexp_replace(
                     regexp_replace(
                       regexp_replace(
                         regexp_replace(content, '\yRiley \(Executive Assistant\)\y', 'Cortana (Executive Assistant)', 'g'),
                       '\yRiley\y', 'Cortana', 'g'),
                     '\yAce\y', 'Cortana', 'g'),
                   '\yKai\y', 'Aphrodite', 'g'),
                 '\yJude\y', 'Themis', 'g')
 WHERE content ~ '\y(Riley|Ace|Kai|Jude)\y';

-- Same scrub for groupchat history rows persisted as JSON in agent_memory
-- with role='system' summary entries, which carry the compressed transcript
-- and most often hold the ghost names.

-- Vector-stored learnings: the pattern column is denormalized prose, so
-- the same regex pass applies.
UPDATE agent_learnings
   SET pattern = regexp_replace(
                   regexp_replace(
                     regexp_replace(
                       regexp_replace(
                         regexp_replace(pattern, '\yRiley \(Executive Assistant\)\y', 'Cortana (Executive Assistant)', 'g'),
                       '\yRiley\y', 'Cortana', 'g'),
                     '\yAce\y', 'Cortana', 'g'),
                   '\yKai\y', 'Aphrodite', 'g'),
                 '\yJude\y', 'Themis', 'g')
 WHERE pattern ~ '\y(Riley|Ace|Kai|Jude)\y';
