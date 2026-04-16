# Riley Architecture Prompt Pack

Use this pack to test the current ASAP Discord architecture through Riley.

This is not a synthetic unit test. It is an operator-level validation pack designed to prove that the main runtime behaviors work together in a live Discord environment.

## What This Pack Covers

This pack is designed to exercise or verify:

1. Riley as the primary text interface in groupchat.
2. Delegation from Riley to Ace and specialist-review routing.
3. Tool-backed execution across code, GitHub, database, cloud, Discord, and lifecycle surfaces.
4. Loop visibility: status, loops, health, and monitoring surfaces.
5. Decision handling in groupchat and the queued/offline decision path.
6. Budget, token, and cost awareness.
7. Memory and database audit visibility.
8. Voice-specific behavior during a live call.
9. Event-driven behavior such as smoke-test follow-through and ops updates.

## What One Prompt Cannot Honestly Prove

No single text message can fully prove:

1. Live voice handling during an active call.
2. Real post-merge callbacks that depend on an actual PR merge.
3. Long-running background loop timing without waiting for those loops to run.

That is why this is a prompt pack instead of one oversized message.

## Preconditions

Before using these prompts, make sure:

1. The bot is live in Discord.
2. Groupchat, decisions, limits, cost, thread-status, agent-errors, and voice-related channels are accessible.
3. The database is reachable and migrations are current.
4. Voice Prompt 2 is only used during an active voice session.
5. Prompt 3 is run in an environment where ops channels and smoke-test behavior can be observed.

---

## Prompt 1: Master Text Drill

Paste this to Riley in `#💬-groupchat`.

```text
Riley, run a full architecture validation drill for the current ASAP Discord runtime.

Treat this as a real operator request, not a theoretical explanation.

Goal:
Plan and begin a small but realistic improvement to the ASAP system: improve the public-facing README and architecture guidance for a new operator so it is easier to understand what Riley, Ace, the specialists, the loops, and the voice mode actually do.

Your job in this drill:
1. Break the work into numbered steps.
2. Route execution through Ace.
3. Pull in specialist review only if needed and explain why.
4. Show me current status, loop health, cost or budget awareness, and any relevant risks.
5. Tell me which architecture surfaces you are exercising as you go.
6. If a major decision is required, ask me directly here in groupchat the way the live system is supposed to.
7. At the end, give me a concise validation summary with:
   - what was tested directly
   - what was only validated indirectly through status or ops evidence
   - what still requires a live voice call or real merge event

Important constraints:
- Use the real runtime behavior.
- Do not just describe the architecture from memory.
- If you can verify something through current status, loops, ops evidence, tools, or live task execution, do that.
- If you cannot honestly prove something from this text interaction, say so explicitly.
```

### Expected Success Signals

1. Riley behaves as the front door and does not answer only as a passive explainer.
2. Riley creates a clear numbered plan.
3. Riley routes execution through Ace instead of delegating directly to specialists for implementation.
4. Riley exposes status and loop-health information in plain language.
5. Riley references cost, budget, limits, or token efficiency where relevant.
6. Riley distinguishes direct proof from indirect proof.
7. If a major decision is needed, Riley asks for it directly in groupchat instead of hiding it.

### Failure Signals

1. Riley only gives a static essay about the architecture.
2. Riley skips Ace and delegates implementation directly to specialists.
3. Riley cannot surface status, loops, or ops-aware progress.
4. Riley claims to have tested voice or merge-trigger behavior without live evidence.
5. Riley ignores budget, cost, or runtime risk framing.

---

## Prompt 2: Live Voice Drill

Say this to Riley during an active voice session.

```text
Riley, this is a live voice architecture test.

I want you to do three things in voice only:
1. Tell me briefly what you think the current top-priority system task should be.
2. Suggest the next concrete step you want the team to take.
3. If you need a major decision from me, ask me directly here in voice right now rather than sending me to the decisions channel.

Keep your answer short and natural like a real live call.

After I respond, continue the conversation the same way so we can prove voice guidance and direct decision handling both work.
```

### Expected Success Signals

1. Riley answers briefly and naturally.
2. Riley suggests a concrete next step instead of speaking vaguely.
3. If a major decision is needed, Riley asks directly in voice.
4. Riley does not defer live-call decisions to the decisions channel.
5. Voice-related logs or call telemetry should be observable in the relevant ops surfaces.

### Failure Signals

1. Riley responds with long text-chat style paragraphs.
2. Riley pushes the decision into the decisions channel during the call.
3. Riley does not suggest an actual next action.
4. The voice session appears disconnected from ops visibility or loop tracking.

---

## Prompt 3: Event And Ops Drill

Paste this to Riley in `#💬-groupchat` when you want the ops-facing validation pass.

```text
Riley, run an ops and event-driven architecture validation pass.

I want you to verify the parts of the system that depend on monitoring, background loops, or external triggers.

Please do the following:
1. Show me the current loop-health view and explain which loops are healthy, idle, warning, or blocked.
2. Show me the current status of cost, limits, and runtime monitoring.
3. Tell me whether the database audit surface looks healthy and what it is currently proving.
4. Tell me what evidence exists for smoke-test or test-engine behavior right now.
5. Tell me what would require a real merge event to validate fully instead of just a status check.
6. If you find anything stale, risky, or incomplete, say exactly what follow-up check should be run next.

Do not bluff. Separate direct evidence from assumptions.
```

### Expected Success Signals

1. Riley surfaces loop-health information clearly.
2. Riley can explain cost, limits, and monitoring without losing the operational meaning.
3. Riley can describe database audit status based on real runtime evidence.
4. Riley can point to smoke-test or test-engine evidence if it exists.
5. Riley clearly states what still needs a real merge or live event.

### Failure Signals

1. Riley only restates documentation instead of checking live evidence.
2. Riley claims post-merge behavior was tested when no merge happened.
3. Riley cannot separate what is healthy from what is merely configured.
4. Riley cannot identify a next validation step if the evidence is incomplete.

---

## Recommended Run Order

1. Start with Prompt 1 in groupchat.
2. Run Prompt 2 during a live voice session.
3. Finish with Prompt 3 to inspect ops, loops, and event-driven evidence.

## Maximum Stress Test Mode

Use this only after the normal pass succeeds. This is intended to push Riley harder across planning, delegation, monitoring, honesty about evidence, and operator-facing reporting.

### Stress Add-On For Prompt 1

Append this block to Prompt 1 if you want the harder version:

```text
Stress mode requirements:
1. Do not give me a generic architecture summary.
2. I want at least one concrete action taken, one live status surface checked, and one real risk or uncertainty called out.
3. I want you to tell me which parts of the architecture were directly exercised versus only inferred.
4. I want you to identify at least one thing that would fail this validation if the runtime were misconfigured.
5. If you can expose cost, limits, loop health, or database audit evidence during this drill, do it.
```

### Stress Add-On For Prompt 3

Append this block to Prompt 3 if you want the harder ops check:

```text
Stress mode requirements:
1. Separate healthy, stale, missing, and unproven signals.
2. Do not treat configuration as proof of runtime behavior.
3. If the evidence is incomplete, tell me the exact next operator action needed to complete the check.
4. If merge-trigger behavior cannot be proven right now, say exactly what event needs to happen and what I should watch for when it does.
```

## Anthropic Usage And Cost Reporting For A Test

If you want a before-and-after Anthropic report for a Riley test run, use the included Admin API helper in this repo.

### Important Limitation

Anthropic's documented Admin API provides usage and cost reporting, but not a simple remaining-credit balance endpoint. That means you can measure how much a test used, but not directly ask Anthropic for a live `credits remaining` number through the standard API docs.

### Requirements

1. `ANTHROPIC_ADMIN_API_KEY` must be set.
2. The key must be an Anthropic Admin API key, not a normal inference key.
3. If you want cleaner attribution, pass `--api-key-ids` or `--workspace-ids` to filter the report.

### Example Workflow

Capture a baseline:

```bash
npm run anthropic:usage:snapshot -- --label before-riley-test
```

Run your Riley architecture test.

Capture the after snapshot:

```bash
npm run anthropic:usage:snapshot -- --label after-riley-test
```

Diff the two snapshots:

```bash
npm run anthropic:usage:report -- --before reports/anthropic-usage/<before-file>.json --after reports/anthropic-usage/<after-file>.json
```

### What The Report Shows

1. Estimated Anthropic cost delta during the test.
2. Uncached input tokens used.
3. Cached input tokens used.
4. Cache creation tokens used.
5. Output tokens used.
6. Server tool and web-search counts if present.
7. Token deltas by model.

## Quick Operator Rubric

If the architecture is behaving correctly, you should see:

1. Riley acting as the operator surface.
2. Ace being used for execution.
3. Specialist involvement only when justified.
4. Status, loop, and ops visibility available on request.
5. Decisions handled in the right place for the context.
6. Voice behaving differently from text in the expected way.
7. Honest boundaries on what still requires real-world triggers.

## Related Docs

1. `ARCHITECTURE.md` for the full technical map.
2. `README.md` for the non-technical product summary.
3. `TEST_MAP.md` for the code-level test coverage map.