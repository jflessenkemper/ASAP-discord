# ASAP Bot - Cortana-Centric Architecture

> **⚠️ This document describes the aspirational target architecture, not the current runtime.**
> For the actual running system (model routing, loop inventory, data layer, and agent delegation), see [README.md](../README.md#architecture). The README diagram is the single source of truth for what the code does today.

Key differences between this target and the current runtime:
- **"Cortana Haiku"** does not exist — all user-facing routing goes through Cortana EA on Sonnet (`CORTANA_PLANNING_MODEL`).
- **Opus is a model choice, not a separate agent.** `resolveModelForAgent()` selects Opus for code-heavy agents on high-stakes prompts. Cortana EA delegates to specialists directly via `handleSubAgents()`.
- **There is no separate "Agent Manager" entity.** Cortana EA's JSON envelope includes `delegateAgents`; the handoff protocol dispatches and aggregates results.
- **11 loops** run in production (this doc lists 9 — missing anomaly-detection and self-improvement-worker).
- **4 Postgres tables** are in production: `agent_memory`, `agent_activity_log`, `agent_learnings`, `self_improvement_jobs`.

An animated walkthrough lives in [assets/architecture-runtime-animated.html](../assets/architecture-runtime-animated.html).

Today, the runtime still has some Cortana paths locked to Opus. The intended direction is stricter separation: Cortana Haiku owns the user-facing conversation layer, voice-call reasoning, and response restructuring, while Cortana Sonnet owns planning and escalation into work. Opus owns implementation, execution routing, loop invocation, and completion assessment before anything is returned through Haiku to the user.

Discord-visible communication now has a stricter contract too: Cortana Haiku is the Anthropic-fast restructuring layer for anything user-facing. She applies the user's rules to replies, handles voice-call reasoning through the ElevenLabs relay, escalates to Cortana Sonnet only when work needs to be done, and keeps tool use collapsed into one-line status logs in the acting agent's own channel instead of a shared tools surface.

## System Context

```mermaid
flowchart LR
    User[User]
    Groupchat[Groupchat channel\ndirect reply or compact completion]
    Workspace[Workspace thread\ntask work]
    ToolLogs["Agent channel\none-line tool logs"]

    subgraph FrontDoor[Front Door]
        CortanaHaiku["Cortana (Haiku) user-facing rules, restructure, voice reasoning"]
        Cortana["Cortana (Sonnet) plans, decides, escalates work"]
        Voice[ElevenLabs speech relay]
    end

    Opus["Cortana (Opus) execution and completion"]

    subgraph AgentManager["Cortana (Sonnet) agent manager"]
        direction TB
        AgentManagerCore[Agent manager core]
        SelfImproveEngine[Self improvement engine]
        StewardQueue[Durable stewardship outbox]
        AgentManagerCore --> SelfImproveEngine
        SelfImproveEngine --> StewardQueue
    end

    QAAgent[QA]
    UXAgent[UX Reviewer]
    SecurityAgent[Security Auditor]
    APIAgent[API Reviewer]
    DBAAgent[DBA]
    PerformanceAgent[Performance]
    DevOpsAgent[DevOps]
    CopywriterAgent[Copywriter]
    LawyerAgent[Lawyer]
    IOSAgent[iOS Engineer]
    AndroidAgent[Android Engineer]

    subgraph AgentChannels[Agent channels]
        QAChan["🧪 QA channel"]
        UXChan["🎨 UX Reviewer channel"]
        SecurityChan["🔒 Security Auditor channel"]
        APIChan["📡 API Reviewer channel"]
        DBAChan["🗄️ DBA channel"]
        PerformanceChan["⚡ Performance channel"]
        DevOpsChan["🚀 DevOps channel"]
        CopywriterChan["✍️ Copywriter channel"]
        LawyerChan["⚖️ Lawyer channel"]
        IOSChan["🍎 iOS Engineer channel"]
        AndroidChan["🤖 Android Engineer channel"]
    end

    subgraph LoopBox[Independent loops]
        TestEngine[Test engine]
        LoggingEngine[Logging engine]
        MemoryLoop[Memory]
        DatabaseAudit[Database audit]
        ChannelHeartbeat[Channel heartbeat]
        UpgradesTriage[Upgrades triage]
        VoiceSession[Voice session]
        GoalWatchdog[Goal and thread watchdog]
    end

    subgraph OpsChannels[Ops channels]
        OpsHub(( ))
        TerminalCh[Terminal]
        ErrorsCh[Errors]
        LimitsCh[Limits]
        HealthCh[Health]
        VoiceCh[Voice]
        LoopsCh[Loops]
    end

    User -->|text| CortanaHaiku
    User -->|voice| Voice
    Voice --> CortanaHaiku
    CortanaHaiku -->|needs real work| Cortana
    Cortana -->|execute| Opus
    Opus <--> AgentManagerCore
    AgentManagerCore <--> QAAgent
    AgentManagerCore <--> UXAgent
    AgentManagerCore <--> SecurityAgent
    AgentManagerCore <--> APIAgent
    AgentManagerCore <--> DBAAgent
    AgentManagerCore <--> PerformanceAgent
    AgentManagerCore <--> DevOpsAgent
    AgentManagerCore <--> CopywriterAgent
    AgentManagerCore <--> LawyerAgent
    AgentManagerCore <--> IOSAgent
    AgentManagerCore <--> AndroidAgent
    QAAgent --> QAChan
    UXAgent --> UXChan
    SecurityAgent --> SecurityChan
    APIAgent --> APIChan
    DBAAgent --> DBAChan
    PerformanceAgent --> PerformanceChan
    DevOpsAgent --> DevOpsChan
    CopywriterAgent --> CopywriterChan
    LawyerAgent --> LawyerChan
    IOSAgent --> IOSChan
    AndroidAgent --> AndroidChan
    Opus -->|execution outcome| AgentManagerCore
    TestEngine --> SelfImproveEngine
    LoggingEngine --> SelfImproveEngine
    MemoryLoop --> SelfImproveEngine
    DatabaseAudit --> SelfImproveEngine
    ChannelHeartbeat --> SelfImproveEngine
    UpgradesTriage --> SelfImproveEngine
    VoiceSession --> SelfImproveEngine
    GoalWatchdog --> SelfImproveEngine
    StewardQueue -->|background stewardship| OpsHub
    SelfImproveEngine -->|ops updates| OpsHub
    Opus -->|done| Cortana
    Cortana -->|handoff final answer| CortanaHaiku
    CortanaHaiku -->|short direct reply| Groupchat
    CortanaHaiku -->|task reply| Workspace
    CortanaHaiku -->|spoken reply| Voice
    Workspace -->|optional compact completion| Groupchat
    AgentManagerCore -->|tool summaries| ToolLogs
    QAAgent -->|tool summaries| ToolLogs
    UXAgent -->|tool summaries| ToolLogs
    SecurityAgent -->|tool summaries| ToolLogs
    APIAgent -->|tool summaries| ToolLogs
    DBAAgent -->|tool summaries| ToolLogs
    PerformanceAgent -->|tool summaries| ToolLogs
    DevOpsAgent -->|tool summaries| ToolLogs
    CopywriterAgent -->|tool summaries| ToolLogs
    LawyerAgent -->|tool summaries| ToolLogs
    IOSAgent -->|tool summaries| ToolLogs
    AndroidAgent -->|tool summaries| ToolLogs
    Cortana -->|if in voice| Voice
    Voice -->|spoken update| User
    Cortana -->|if in text| Workspace
    Groupchat -->|tag user| User

    classDef user fill:#4f8fcb,stroke:#2f6ea3,color:#ffffff,stroke-width:2px;
    classDef cortana fill:#4ea56b,stroke:#2f7a49,color:#ffffff,stroke-width:2px;
    classDef opus fill:#d9822b,stroke:#9a5416,color:#ffffff,stroke-width:2px;
    classDef surface fill:#7b8794,stroke:#56616d,color:#ffffff,stroke-width:2px;
    classDef voice fill:#7b4fd6,stroke:#5934a5,color:#ffffff,stroke-width:2px;
    classDef hidden fill:transparent,stroke:transparent,color:transparent;

    class User user;
    class CortanaHaiku,Cortana cortana;
    class Groupchat,Workspace,ToolLogs,SelfImproveEngine,QAAgent,UXAgent,SecurityAgent,APIAgent,DBAAgent,PerformanceAgent,DevOpsAgent,CopywriterAgent,LawyerAgent,IOSAgent,AndroidAgent,QAChan,UXChan,SecurityChan,APIChan,DBAChan,PerformanceChan,DevOpsChan,CopywriterChan,LawyerChan,IOSChan,AndroidChan,TestEngine,LoggingEngine,MemoryLoop,DatabaseAudit,ChannelHeartbeat,UpgradesTriage,VoiceSession,GoalWatchdog,TerminalCh,ErrorsCh,LimitsCh,HealthCh,VoiceCh,LoopsCh surface;
    class Voice voice;
    class Opus opus;
    class AgentManagerCore cortana;
    class OpsHub hidden;
```

## Voice Path

```mermaid
flowchart LR
    UserVoice[User speaks in Discord voice]
    VoiceSession[Discord voice session]
    SpeakerGate[Single-speaker gate]
    SpeechIO[ElevenLabs speech I/O and transcript pipeline]
    CortanaHaiku["Cortana (Haiku) voice reasoning and user-facing rules"]
    Cortana["Cortana (Sonnet) plans and escalates work"]
    Workspace[Workspace thread]
    ToolLogs["Agent channel\none-line tool logs"]
    ExecutionFabric[Specialists, tools, and loop adapters]
    StewardQueue[Durable stewardship outbox]
    OpsSteward["Cortana (Operations Manager)\nstewardship worker"]
    Opus["Cortana (Opus) executes and checks completion"]
    UserHears[User hears Cortana's response]

    subgraph AgentManager[Agent manager]
        direction TB
        AgentManagerCore[Agent manager core]
        SelfImproveEngine[Self-improvement engine]
        AgentManagerCore --> SelfImproveEngine
    end

    UserVoice --> VoiceSession --> SpeakerGate --> SpeechIO --> CortanaHaiku
    CortanaHaiku -->|keep reasoning in voice| SpeechIO
    CortanaHaiku -->|execution needed| Cortana
    Cortana -->|manager handoff| AgentManager
    Cortana -->|handoff work context| Workspace
    Workspace --> Opus
    Opus --> ExecutionFabric
    ExecutionFabric --> Opus
    Opus -->|execution outcome| AgentManagerCore
    AgentManagerCore -->|manage self-improvement path| SelfImproveEngine
    SelfImproveEngine -->|write stewardship job| StewardQueue
    StewardQueue -->|background work| OpsSteward
    OpsSteward -->|workspace updates and ops logs| Workspace
    ExecutionFabric -->|tool summaries| ToolLogs
    OpsSteward -->|stewardship report| SelfImproveEngine
    Opus -->|completed result| Cortana
    Cortana -->|handoff final answer| CortanaHaiku
    CortanaHaiku -->|workspace text reply| Workspace
    CortanaHaiku -->|spoken reply| SpeechIO --> VoiceSession --> UserHears

    classDef user fill:#4f8fcb,stroke:#2f6ea3,color:#ffffff,stroke-width:2px;
    classDef cortana fill:#4ea56b,stroke:#2f7a49,color:#ffffff,stroke-width:2px;
    classDef opus fill:#d9822b,stroke:#9a5416,color:#ffffff,stroke-width:2px;
    classDef surface fill:#7b8794,stroke:#56616d,color:#ffffff,stroke-width:2px;
    classDef voice fill:#7b4fd6,stroke:#5934a5,color:#ffffff,stroke-width:2px;

    class UserVoice,UserHears user;
    class CortanaHaiku,Cortana cortana;
    class VoiceSession,SpeechIO,SpeakerGate voice;
    class Opus opus;
    class Workspace,ToolLogs,ExecutionFabric,SelfImproveEngine,StewardQueue surface;
    class AgentManagerCore cortana;
    class OpsSteward cortana;
```

## Execution Path

```mermaid
flowchart TB
    Request[Request reaches Cortana Haiku]
    CortanaHaiku["Cortana (Haiku) user-facing rules and restructure"]
    Cortana["Cortana (Sonnet) plans, decides, and tracks the goal"]
    Workspace[Workspace thread and agent channels]
    ToolLogs["Agent channel\none-line tool logs"]
    Opus["Cortana (Opus) executes the plan and checks completion"]
    Specialists[Agent manager and specialist reports]
    Tools[Tools and integrations]
    ExecutionOutcome[Execution outcome summary]
    StewardQueue[Durable stewardship outbox]
    OpsSteward["Cortana (Operations Manager)\nstewardship worker"]
    LoopAdapters[Callable loop adapters]
    LoopReports[Loop reports, ops lines, and evidence]
    OpsChannels[Ops channels]
    WorkspaceUpdates[Workspace-first progress updates]
    OpusReturn["Opus execution summary and completion decision"]
    FinalAnswer[Cortana gives final answer]

    subgraph AgentManager[Agent manager]
        direction TB
        AgentManagerCore[Agent manager core]
        SelfImproveEngine[Self-improvement engine]
        AgentManagerCore --> SelfImproveEngine
    end

    Request --> CortanaHaiku
    CortanaHaiku -->|needs real work| Cortana
    Cortana -->|execution plan after any decision gate| Opus
    Cortana -->|manager handoff| AgentManager
    Opus --> Specialists
    Specialists --> Workspace
    Workspace --> Specialists
    Specialists --> Opus
    Opus --> Tools --> Opus
    Specialists -->|tool summaries| ToolLogs
    Tools -->|tool summaries| ToolLogs
    Opus --> ExecutionOutcome --> AgentManagerCore
    AgentManagerCore -->|manage engine| SelfImproveEngine
    SelfImproveEngine -->|persist job| StewardQueue --> OpsSteward
    OpsSteward --> LoopAdapters --> LoopReports --> SelfImproveEngine
    SelfImproveEngine --> OpsChannels
    OpsSteward --> WorkspaceUpdates --> Workspace
    Opus --> OpusReturn
    OpusReturn --> Cortana
    Cortana -->|handoff final answer| CortanaHaiku
    CortanaHaiku --> Workspace
    Workspace --> FinalAnswer

    classDef user fill:#4f8fcb,stroke:#2f6ea3,color:#ffffff,stroke-width:2px;
    classDef cortana fill:#4ea56b,stroke:#2f7a49,color:#ffffff,stroke-width:2px;
    classDef opus fill:#d9822b,stroke:#9a5416,color:#ffffff,stroke-width:2px;
    classDef surface fill:#7b8794,stroke:#56616d,color:#ffffff,stroke-width:2px;

    class Request,FinalAnswer user;
    class CortanaHaiku,Cortana,AgentManagerCore cortana;
    class Opus,OpusReturn opus;
    class Workspace,ToolLogs,Specialists,Tools,SelfImproveEngine,ExecutionOutcome,StewardQueue,LoopAdapters,LoopReports,OpsChannels,WorkspaceUpdates surface;
    class OpsSteward cortana;
```

## Runtime Note

The current runtime now persists self-improvement work off the main groupchat execution path in a Postgres-backed outbox and drains it with a background worker. That removes loop adapters and operations stewardship from the user-facing critical path while surviving process restarts. Retry policy and stale-claim recovery are now part of that worker path.

## Loop Internals

```mermaid
flowchart TB
    Opus[Opus execution summary]
    OpsSteward[Operations manager]
    LoopAdapter[Loop adapter layer]
    LoopOutputs[Loop reports + ops lines + workspace updates]

    Opus -->|steward requests| OpsSteward -->|invoke loops| LoopAdapter

    subgraph RuntimeLoops[All runtime loops in one view]
        subgraph TestLoop[Test engine]
            Test1[Map changed files or regression need]
            Test2[Run readiness or smoke profile]
            Test3[Return pass or fail evidence]
            Test1 --> Test2 --> Test3
        end

        subgraph LoggingLoop[Logging engine]
            Log1[Read recent activity log rows]
            Log2[Read latest ops-channel signals]
            Log3[Publish condensed logging report]
            Log1 --> Log2 --> Log3
        end

        subgraph MemoryLoop[Memory consolidation]
            Memory1[Collect durable insights and repeated failures]
            Memory2[Consolidate useful learnings]
            Memory3[Record learning under operations-manager]
            Memory1 --> Memory2 --> Memory3
        end

        subgraph DbLoop[Database audit]
            Db1[Check expected runtime tables]
            Db2[Check migration and legacy-table state]
            Db3[Return audit result and warnings]
            Db1 --> Db2 --> Db3
        end

        subgraph HeartbeatLoop[Channel heartbeat]
            Heart1[Check status feeds for staleness]
            Heart2[Record loop health and heal if needed]
            Heart3[Post heartbeat result]
            Heart1 --> Heart2 --> Heart3
        end

        subgraph UpgradeLoop[Upgrades triage]
            Up1[Collect upgrade suggestions]
            Up2[Group and rank operational follow-ups]
            Up3[Post triage summary]
            Up1 --> Up2 --> Up3
        end

        subgraph ThreadLoop[Thread status reporter]
            Thread1[Snapshot active workspaces and statuses]
            Thread2[Build condensed thread status line]
            Thread3[Post thread status report]
            Thread1 --> Thread2 --> Thread3
        end

        subgraph WatchdogLoop[Goal and thread watchdog]
            Watch1[Watch long-running goals for stalls]
            Watch2[Attempt recovery or escalate]
            Watch3[Return stall and recovery evidence]
            Watch1 --> Watch2 --> Watch3
        end

        subgraph VoiceLoop[Voice session]
            Voice1[Track active call and current speaker]
            Voice2[Gate to one speaker turn at a time]
            Voice3[Return session health and voice evidence]
            Voice1 --> Voice2 --> Voice3
        end
    end

    LoopAdapter --> Test1
    LoopAdapter --> Log1
    LoopAdapter --> Memory1
    LoopAdapter --> Db1
    LoopAdapter --> Heart1
    LoopAdapter --> Up1
    LoopAdapter --> Thread1
    LoopAdapter -. event-driven .-> Watch1
    LoopAdapter -. event-driven .-> Voice1

    Test3 --> LoopOutputs
    Log3 --> LoopOutputs
    Memory3 --> LoopOutputs
    Db3 --> LoopOutputs
    Heart3 --> LoopOutputs
    Up3 --> LoopOutputs
    Thread3 --> LoopOutputs
    Watch3 --> LoopOutputs
    Voice3 --> LoopOutputs

    LoopOutputs --> Opus

    classDef cortana fill:#4ea56b,stroke:#2f7a49,color:#ffffff,stroke-width:2px;
    classDef opus fill:#d9822b,stroke:#9a5416,color:#ffffff,stroke-width:2px;
    classDef surface fill:#7b8794,stroke:#56616d,color:#ffffff,stroke-width:2px;

    class OpsSteward cortana;
    class Opus opus;
    class LoopAdapter,LoopOutputs,Test1,Test2,Test3,Log1,Log2,Log3,Memory1,Memory2,Memory3,Db1,Db2,Db3,Heart1,Heart2,Heart3,Up1,Up2,Up3,Thread1,Thread2,Thread3,Watch1,Watch2,Watch3,Voice1,Voice2,Voice3 surface;
```

## Core Idea

This file describes the intended Cortana-centric control flow for the system.

Cortana is the front door to the system.

You interact with Cortana in only two ways:

1. Text in Discord.
2. Voice in Discord.

From there, Cortana decides what should happen next with Sonnet, tracks the goal inside Cortana's own working context, pauses for any required user decision in the right surface, hands execution to Opus only after that gate is satisfied, and then synthesizes the completed result that Opus returns back into one user-facing answer.

## End-To-End Control Flow

1. You speak or type to Cortana.
2. Cortana receives the request as the single human-facing orchestrator.
3. Cortana uses Sonnet internally to decide whether the answer is immediate, requires implementation, or requires one specific loop.
4. For voice, the Discord voice session, speaker gate, and speech I/O pipeline carry the live turn into Cortana.
5. If Cortana needs a user decision during a live call, Cortana asks in voice first; otherwise Cortana can still tag the user in the decisions channel and wait for the reply.
6. When execution is needed and any required decision has been received, Cortana passes the plan into Opus and keeps the workspace thread active.
7. Opus performs implementation work by calling Cortana's Sonnet agent manager, tools, or the loop adapter layer.
8. The agent manager delegates to sub-agents and receives structured JSON reports back from them, including any issues they encountered while doing the work.
9. Opus derives self-improvement requests when logging, memory, regression coverage, or ops reporting follow-up is needed.
10. Cortana's Sonnet-side self-improvement manager curates that packet, invokes callable loops, feeds the resulting stewardship data back to Opus, and uses the same engine output to update the ops channels.
11. Agent channels, tools, and loops feed evidence and outcomes back into Opus, and Opus assesses whether the requested work was completed successfully.
12. Opus returns the completed result to Cortana.
13. Cortana combines that result with user context and chooses the best way to tell the user about completion: voice if they are still in voice, otherwise Cortana tags the user in groupchat.

## Workspace Model

The workspace model is Cortana-first, Opus-mediated, and agent-second.

1. Cortana owns Sonnet-based planning, coordination, and synthesis.
2. Opus owns execution routing once Cortana decides work should be carried out.
3. Each agent works in its own dedicated channel or thread, not in one shared execution stream.
4. Agents report their findings, deliverables, or blockers back to Opus through the execution path.
5. Opus decides whether the implementation succeeded and what still remains open.
6. Cortana uses the completed result that Opus returns to frame the user-facing response.
7. Cortana blocks before Opus execution whenever a tagged user decision is required.

This keeps the human interface simple while still allowing specialized parallel execution behind Cortana.

## Voice Model

Voice is not a separate product surface. It is the same Cortana control plane expressed through speech.

1. You talk to Cortana in voice.
2. The live voice path uses a Discord voice session, a one-speaker gate, and a speech I/O pipeline.
3. Cortana plans the response internally with Sonnet before you hear anything back.
4. Cortana uses Opus only when execution work is needed.
5. If Cortana needs a human decision before execution and the call is still active, Cortana should ask in voice first instead of deferring immediately to a text-only decision channel.
6. Opus receives the execution evidence, stewardship reports, and loop results, checks whether the work is complete, and only then returns a result to Cortana.
7. When execution completes, Cortana decides the best completion channel for the user.
8. If the voice call is still active for the user, Cortana can mention the completion in voice.
9. If the user is not in voice, Cortana should tag the user in groupchat instead.
10. Cortana should be able to continue the same task across voice and text without changing ownership of the task.

The important architectural rule is that voice should not bypass Cortana. Voice still enters through Cortana, Cortana still owns the work, and Cortana should only handle one active speaker turn at a time.

Discord already gives the runtime separate speaker streams by member, so distinguishing speakers is feasible today. The missing behavior is orchestration policy: if multiple people speak at once, Cortana should tell them she can only handle one speaker at a time and ask them to wait.

## Operations And ASAP Categories

Cortana should communicate system state into Discord, not keep it hidden in model responses.

1. Operations channels hold runtime state, logs, alerts, budgets, and loop telemetry.
2. ASAP workspaces hold execution, delegation, and agent collaboration.
3. Cortana should surface meaningful status into those categories while work is happening.
4. Cortana should use those surfaces to maintain visibility, not just for post-hoc reporting.
5. Final user-facing answers still come from Cortana, not directly from workspaces, loops, or Opus.

## Independent Loops

Loops should be independently callable.

They should not all run at once just because Cortana is active.

Instead:

1. Cortana or Opus decides whether loop execution is needed.
2. Opus derives the needed stewardship request and hands it to Cortana (Operations Manager).
3. Operations Manager invokes one specific callable loop through the loop adapter layer.
4. That loop runs independently of the others and posts visible state into Operations surfaces.
5. When the loop completes, it returns a structured report through the execution path back into Opus.
6. Operations Manager can mirror useful progress into the active workspace thread while the loop is running.
7. Opus decides whether that loop result satisfies the goal or whether more execution is needed.
8. Cortana uses the completed result that Opus returns to make user-facing decisions or trigger follow-up work.

This makes loops operationally visible and keeps them from becoming an opaque background process.

## Loop Channel Requirements

A dedicated loop channel in Operations should exist for at least these purposes:

1. Show which loop Opus started on Cortana's behalf.
2. Show that the loop ran independently.
3. Show whether the loop finished, warned, or failed.
4. Capture the loop's final report in an Opus-readable form.
5. Mirror the most useful progress and outcomes back into the active workspace thread when appropriate.
6. Give Cortana a stable reporting surface after Opus has assessed the result.

## Decision Model

Cortana remains the human-facing decision point even when other agents or loops contribute.

1. Cortana plans and decides.
2. Opus executes, routes work, and decides whether the execution goal was completed successfully.
3. Agents do implementation work inside execution surfaces.
4. Loops produce reports as independent execution units.
5. Cortana decides what matters to the user, what to ignore, what to ask you, and how to present the outcome.

That means the system should not respond to you as a loose collection of agents. It should respond as Cortana, using the rest of the system as her execution fabric.

## Runtime Surfaces

The architecture depends on these surfaces being explicit:

1. Human interface: groupchat and voice.
2. Voice relay: Discord voice session plus speech I/O.
3. Planning surface: Cortana using Sonnet internally.
4. Execution router: Opus.
5. Coordination surface: Cortana workspace.
6. Execution surfaces: dedicated agent channels, tools, operations-manager stewardship, and independent loops.
7. Operations visibility: terminal, errors, limits, health, voice, loops, and thread-status channels.
8. Completion surface: Opus taking incoming execution evidence and deciding whether the goal is done.
9. Synthesis surface: Cortana taking the completed result and returning one coherent answer.

## Key Files

| Layer | File | Purpose |
|-------|------|---------|
| Entry | `src/index.ts`, `src/discord/bot.ts` | Runtime startup, Discord wiring, top-level event flow |
| Cortana routing | `src/discord/handlers/groupchat.ts`, `src/discord/cortanaInteraction.ts` | Cortana-first planning, interaction policy, and synthesis |
| Voice | `src/discord/handlers/callSession.ts`, `src/discord/voice/connection.ts`, `src/discord/voice/tts.ts` | Voice intake, live session control, single-speaker gating, and speech I/O |
| Model execution | `src/discord/claude.ts`, `src/discord/opusExecution.ts` | Cortana planning model selection plus Opus execution routing, stewardship derivation, and completion assessment |
| Agent channels | `src/discord/agents.ts`, `src/discord/handoff.ts` | Agent identities, execution delegation, and channel handoff logic |
| Discord output contract | `src/discord/services/discordOutputSanitizer.ts`, `src/discord/handlers/textChannel.ts` | Cortana Haiku user-facing restructuring, voice-call reply shaping, and one-line tool log formatting |
| Tools | `src/discord/tools.ts`, `src/discord/toolsDb.ts`, `src/discord/toolsGcp.ts` | Execution surfaces used by Cortana and agents |
| Loop orchestration | `src/discord/operationsSteward.ts`, `src/discord/loopAdapters.ts` | Stewardship request derivation and callable loop execution |
| Loop visibility | `src/discord/loopHealth.ts`, `src/discord/loggingEngine.ts` | Loop state tracking, reporting, thread-status, and ops-facing visibility |
| Memory | `src/discord/memory.ts`, `src/discord/vectorMemory.ts` | Cortana memory, recall, agent learnings with 30-day TTL, and self-improvement inputs |
| Self-improvement | `src/discord/selfImprovementQueue.ts` | Durable job queue backed by `self_improvement_jobs` table with retry/backoff |
| Anomaly detection | `src/discord/anomalyDetection.ts` | Error-rate, token-cost, latency, and rate-limit anomaly detection loop |
| Data layer | `src/db/runtimeSchema.ts`, `src/db/migrations/` | Schema expectations for 4 tables: `agent_memory`, `agent_activity_log`, `agent_learnings`, `self_improvement_jobs` |

## Architectural Rule Of Thumb

If a task starts with you and ends with a result back to you, Cortana should own the full chain:

1. intake,
2. planning,
3. handing execution to Opus when needed,
4. synthesis,
5. response.

Everything else exists to help Cortana execute that chain more effectively.
