# ASAP Bot — How Riley Self-Improves

```mermaid
flowchart TB
    %% ── Discord Layer ──
    User(["👤 Jordan\nsends message in\n#💬-groupchat"])

    subgraph Discord["🎮 Discord Server"]
        direction LR
        subgraph AgentChannels["Agent Channels"]
            direction TB
            Riley["📋 Riley\nOrchestrator\nCustom tools"]
            Ace["💻 Ace\nTool Master\n72 tools"]
            subgraph FullTools["🟢 Full Access"]
                Jude["🚀 Jude · DevOps"]
                Mia["🍎 Mia · iOS"]
                Leo["🤖 Leo · Android"]
            end
            subgraph ReviewTools["⚪ Review Only"]
                Max["🧪 Max · QA"]
                Sophie["🎨 Sophie · UX"]
                Kane["🔒 Kane · Security"]
                Raj["📡 Raj · API"]
                Elena["🗄️ Elena · DBA"]
                Kai["⚡ Kai · Perf"]
                Liv["✍️ Liv · Copy"]
                Harper["⚖️ Harper · Legal"]
            end
        end
        subgraph OpsChannels["Ops Channels"]
            terminal["💻 terminal"]
            limits["📊 limits"]
            cost["💸 cost"]
            github_ch["📦 github"]
            upgrades["🆙 upgrades"]
            errors["🚨 errors"]
        end
    end

    %% ── Message Routing ──
    User --> Riley
    Riley -->|"handoff.ts\ntask + context"| Ace
    Ace -->|"@mention in response"| FullTools
    Ace -->|"@mention for review"| ReviewTools
    ReviewTools -->|"feedback"| Ace
    FullTools -->|"results"| Ace
    Ace -->|"result summary"| Riley

    %% ── LLM Core ──
    subgraph LLM["🧠 claude.ts — agentRespond()"]
        direction TB
        InputGuard["1. Input Guardrail\nguardrails.ts · Gemini Flash"]
        MemRecall["2. Memory Recall\nvectorMemory.ts · cosine search"]
        ModelSelect["3. Model Selection\nmodelHealth.ts · fallback chains"]
        CacheCheck["4. Cache Check\ncontextCache.ts · save 50-75% tokens"]
        BudgetCheck["5. Budget Check\nusage.ts · 8M tokens / $250 daily"]
        APICall["6. API Call\nClaude Opus 4.6 / Sonnet 4\nGemini Flash / Pro"]
        ToolLoop["7. Tool Loop\ntools.ts · up to maxToolRounds"]
        OutputGuard["8. Output Guardrail\nguardrails.ts"]
        UsageRecord["9. Record\nusage.ts + tracing.ts"]

        InputGuard --> MemRecall --> ModelSelect --> CacheCheck --> BudgetCheck --> APICall
        APICall --> ToolLoop
        ToolLoop -->|"tool results"| APICall
        ToolLoop --> OutputGuard --> UsageRecord
    end

    Riley --> LLM
    Ace --> LLM
    FullTools --> LLM
    ReviewTools --> LLM
    UsageRecord -.->|"dashboards"| OpsChannels

    %% ── Tool System ──
    subgraph ToolSystem["🔧 72 Tools"]
        direction LR
        FileOps["📁 File/Code\nread · write · edit\nrun_command\nrun_tests · typecheck"]
        GitOps["🐙 GitHub\nbranch · PR · merge\nreview · search"]
        GCPOps["☁️ GCP\ndeploy · build · rollback\nsecrets · logs"]
        DBOps["🗃️ Database\ndb_query · db_schema\nmemory_read/write"]
        DiscOps["💬 Discord\nsend · read messages\nchannels · threads"]
    end

    ToolLoop --> ToolSystem

    %% ── Self-Improvement Loop ──
    subgraph SelfImprove["🔄 Self-Improvement Loop"]
        direction LR
        Identify["1. Riley spots\nbug or gap"]
        Delegate["2. Delegate\nvia handoff.ts"]
        WriteCode["3. Ace writes\ncode via tools"]
        RunTests["4. Test\nJest (unit)\ntester.ts (smoke)"]
        CreatePR["5. PR + Review\n6 agents review"]
        Ship["6. Deploy\nmerge → build\n→ Cloud Run"]

        Identify --> Delegate --> WriteCode --> RunTests --> CreatePR --> Ship
        Ship -->|"observe & learn\nrecordAgentDecision()"| Identify
    end

    Riley -.->|"triggers"| SelfImprove
    WriteCode --> FileOps
    CreatePR --> GitOps
    Ship --> GCPOps

    %% ── Persistence Layer ──
    subgraph Storage["💾 Persistence"]
        direction LR
        PGMemory[("PostgreSQL\nagent_memory\nhistory + usage")]
        PGVector[("pgvector\nagent_embeddings\n768-dim vectors")]
        PGTrace[("PostgreSQL\ntrace_spans\n7-day retention")]
        GitHubStore[("GitHub\nbranches & PRs")]
        GCPStore[("Cloud Run\ndeploy & secrets")]
    end

    DBOps --> PGMemory
    DBOps --> PGVector
    UsageRecord --> PGTrace
    GitOps --> GitHubStore
    GCPOps --> GCPStore
    MemRecall -.->|"embed & search"| PGVector

    %% ── Styles ──
    style Discord fill:#1a1f36,stroke:#5865F2,stroke-width:2px,color:#fff
    style AgentChannels fill:#1a1f36,stroke:#5865F2,stroke-width:1px,color:#fff
    style OpsChannels fill:#1a1f36,stroke:#484f58,stroke-width:1px,color:#fff
    style FullTools fill:#0d1f0d,stroke:#2ea043,stroke-width:1px,color:#fff
    style ReviewTools fill:#1a1a1a,stroke:#484f58,stroke-width:1px,color:#fff
    style LLM fill:#1f1a00,stroke:#d29922,stroke-width:2px,color:#fff
    style ToolSystem fill:#0d1a1f,stroke:#388bfd,stroke-width:2px,color:#fff
    style SelfImprove fill:#1a1040,stroke:#8957e5,stroke-width:2px,color:#fff
    style Storage fill:#1a1a1a,stroke:#484f58,stroke-width:2px,color:#fff
```

## Key Files

| Layer | File | Purpose |
|-------|------|---------|
| **Entry** | `bot.ts`, `setup.ts` | Discord client, channel provisioning |
| **Routing** | `handlers/groupchat.ts`, `handlers/textChannel.ts` | Message handling, queues, threads |
| **Core** | `claude.ts`, `agents.ts` | LLM orchestration, 13 agent definitions |
| **Tools** | `tools.ts`, `toolsDb.ts`, `toolsGcp.ts` | 72 tools, SQL safety, GCP ops |
| **Safety** | `guardrails.ts`, `circuitBreaker.ts` | I/O classification, resilience |
| **Memory** | `memory.ts`, `vectorMemory.ts` | Conversation persistence, semantic search |
| **Infra** | `handoff.ts`, `modelHealth.ts`, `contextCache.ts`, `usage.ts`, `tracing.ts` | Delegation, health, caching, cost, traces |
| **Testing** | `tester.ts`, `test-definitions.ts` | Smoke tests, test catalog |
| **Services** | `services/github.ts`, `services/cloudrun.ts` | GitHub PRs, GCP deploy |
