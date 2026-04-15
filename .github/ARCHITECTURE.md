# ASAP Bot — How Riley Self-Improves

## High-Level Architecture

```mermaid
flowchart TB
    subgraph Discord["🎮 Discord Server"]
        direction LR
        GC["💬 #groupchat\n(Riley receives all messages)"]
        subgraph Agents["Agent Channels"]
            direction LR
            R["📋 Riley"]
            A["💻 Ace"]
            MX["🧪 Max"]
            SO["🎨 Sophie"]
            KN["🔒 Kane"]
            RJ["📡 Raj"]
            EL["🗄️ Elena"]
            KI["⚡ Kai"]
            JU["🚀 Jude"]
            LV["✍️ Liv"]
            HA["⚖️ Harper"]
            MI["🍎 Mia"]
            LE["🤖 Leo"]
        end
        subgraph Ops["Ops Channels"]
            direction LR
            T["💻 terminal"]
            L["📊 limits"]
            C["💸 cost"]
            GH["📦 github"]
            UP["🆙 upgrades"]
            AE["🚨 agent-errors"]
        end
    end

    subgraph Routing["📨 Message Routing"]
        GCH["groupchat.ts\nSerialize requests\nRoute agent mentions\nManage workspace threads"]
        TCH["textChannel.ts\nPer-channel queues\nConversation history (20 msgs)\nComplexity classification"]
    end

    subgraph Core["🧠 LLM Orchestration — claude.ts → agentRespond()"]
        direction TB
        G1["1. Input Guardrail\nguardrails.ts"]
        VM["2. Memory Recall\nvectorMemory.ts"]
        MH["3. Model Selection\nmodelHealth.ts"]
        CC["4. Cache Check\ncontextCache.ts"]
        BC["5. Budget Check\nusage.ts"]
        API["6. API Call\nClaude Opus / Sonnet / Gemini"]
        TL["7. Tool Loop (up to maxToolRounds)\ntools.ts — 72 tools"]
        G2["8. Output Guardrail\nguardrails.ts"]
        UR["9. Usage Recording\nusage.ts + tracing.ts"]

        G1 --> VM --> MH --> CC --> BC --> API --> TL
        TL -->|"tool results"| API
        TL --> G2 --> UR
    end

    subgraph Tools["🔧 Tool System"]
        direction LR
        subgraph FileTools["File/Code"]
            FT["read_file\nwrite_file\nedit_file\nrun_command\nrun_tests"]
        end
        subgraph GitTools["GitHub"]
            GT["create_branch\ncreate_pr\nmerge_pr\ngithub_search"]
        end
        subgraph GCPTools["GCP"]
            GCPT["deploy\nbuild_image\nsecrets\nlogs\nrollback"]
        end
        subgraph DBTools["Database"]
            DT["db_query\ndb_schema\nmemory_read\nmemory_write"]
        end
        subgraph DiscTools["Discord"]
            DCT["send_message\nread_messages\nlist_channels\nlist_threads"]
        end
    end

    subgraph Persist["💾 Persistence Layer"]
        direction LR
        PG1[("PostgreSQL\nagent_memory\nConversation history\nUsage counters")]
        PG2[("PostgreSQL + pgvector\nagent_embeddings\n768-dim vectors\nCosine similarity")]
        PG3[("PostgreSQL\ntrace_spans\n7-day retention")]
        GitHub[("GitHub\nBranches & PRs\nCode reviews")]
        GCP[("GCP Cloud Run\nDeploy & rollback\nSecrets & logs")]
    end

    GC --> GCH
    Agents --> TCH
    GCH --> Core
    TCH --> Core
    TL --> Tools
    Tools --> Persist
    Core --> Persist
    UR -.->|"update dashboards"| Ops

    style Discord fill:#1a1f36,stroke:#5865F2,stroke-width:2px,color:#fff
    style Routing fill:#0d1f0d,stroke:#2ea043,stroke-width:2px,color:#fff
    style Core fill:#1f1a00,stroke:#d29922,stroke-width:2px,color:#fff
    style Tools fill:#0d1a1f,stroke:#388bfd,stroke-width:2px,color:#fff
    style Persist fill:#1a1a1a,stroke:#484f58,stroke-width:2px,color:#fff
```

## Agent Hierarchy & Tool Access

```mermaid
flowchart TB
    subgraph Orchestrator["📋 Riley — Executive Assistant"]
        Riley["Receives all user messages\nDelegates execution to Ace\nNever executes code directly\nCustom tool tier: read/write/PR/deploy/memory"]
    end

    subgraph Executor["💻 Ace — Tool Master / Chief Engineer"]
        Ace["Executes all code changes\nFull tool access (72 tools)\nDelegates reviews to specialists\nCan invoke any agent via mention"]
    end

    subgraph FullAccess["🟢 Full Tool Access"]
        direction LR
        Jude["🚀 Jude\nDevOps"]
        Mia["🍎 Mia\niOS Engineer"]
        Leo["🤖 Leo\nAndroid Engineer"]
    end

    subgraph ReviewOnly["⚪ Review-Only Access"]
        direction LR
        Max["🧪 Max\nQA"]
        Sophie["🎨 Sophie\nUX Reviewer"]
        Kane["🔒 Kane\nSecurity Auditor"]
        Raj["📡 Raj\nAPI Reviewer"]
        Elena["🗄️ Elena\nDBA"]
        Kai["⚡ Kai\nPerformance"]
        Liv["✍️ Liv\nCopywriter"]
        Harper["⚖️ Harper\nLawyer"]
    end

    Riley -->|"handoff.ts\ntask + context + constraints"| Ace
    Ace -->|"agent mention\nin response text"| FullAccess
    Ace -->|"agent mention\nin response text"| ReviewOnly
    ReviewOnly -->|"review feedback"| Ace
    FullAccess -->|"execution results"| Ace
    Ace -->|"handoff result\nstatus + summary + files"| Riley

    style Orchestrator fill:#1a1040,stroke:#8957e5,stroke-width:2px,color:#fff
    style Executor fill:#0d1f0d,stroke:#2ea043,stroke-width:2px,color:#fff
    style FullAccess fill:#0d1f0d,stroke:#2ea043,stroke-width:1px,color:#fff
    style ReviewOnly fill:#1a1a1a,stroke:#484f58,stroke-width:1px,color:#fff
```

## Self-Improvement Loop

```mermaid
flowchart LR
    subgraph Identify["1. Identify"]
        ID["Riley notices a bug,\ngap, or optimization\nin #💬-groupchat"]
    end

    subgraph Delegate["2. Delegate"]
        HO["Riley → Ace\nhandoff.ts\n\nTask, context,\nconstraints,\nexpected output"]
    end

    subgraph Code["3. Write Code"]
        WR["Ace uses tools:\nread_file\nwrite_file\nedit_file\nrun_command\nsearch_files"]
    end

    subgraph Test["4. Test"]
        direction TB
        UT["Jest Unit Tests\nnpx jest\n963 tests / 51 suites\nReads TEST_MAP.md"]
        ST["Smoke Tests\ntester.ts +\ntest-definitions.ts\nLive Discord integration"]
    end

    subgraph PR["5. Review"]
        direction TB
        CR["git_create_branch\ncreate_pull_request"]
        RV["Auto-review by 6 agents:\n🧪 Max (QA)\n🎨 Sophie (UX)\n🔒 Kane (Security)\n📡 Raj (API)\n🗄️ Elena (DBA)\n⚡ Kai (Performance)"]
        CR --> RV
    end

    subgraph Deploy["6. Ship"]
        MG["merge_pull_request\ngcp_build_image\ngcp_deploy"]
    end

    Identify --> Delegate --> Code --> Test --> PR --> Deploy
    Deploy -->|"Loop: observe results\nlearn from outcomes\nrecordAgentDecision()"| Identify

    style Identify fill:#1a1040,stroke:#8957e5,stroke-width:2px,color:#fff
    style Delegate fill:#1a1040,stroke:#8957e5,stroke-width:1px,color:#fff
    style Code fill:#0d1f0d,stroke:#2ea043,stroke-width:2px,color:#fff
    style Test fill:#1f1a00,stroke:#d29922,stroke-width:2px,color:#fff
    style PR fill:#0d1a1f,stroke:#388bfd,stroke-width:2px,color:#fff
    style Deploy fill:#1a0d0d,stroke:#f85149,stroke-width:2px,color:#fff
```

## agentRespond() — Detailed Internal Flow

```mermaid
flowchart TD
    MSG["Incoming message\n+ conversation history"]

    MSG --> GUARD_IN

    subgraph InputPhase["Input Processing"]
        GUARD_IN{"classifyInput()\nguardrails.ts\nGemini Flash, 5s timeout"}
        GUARD_IN -->|"block"| REJECT["❌ Reject message"]
        GUARD_IN -->|"pass/warn"| RECALL
        RECALL["recallRelevantContext()\nvectorMemory.ts\nCosine similarity search\nof past decisions"]
    end

    subgraph ModelPhase["Model Selection"]
        RECALL --> SELECT
        SELECT["resolveHealthyModel()\nmodelHealth.ts"]
        SELECT --> CACHE
        CACHE["getOrCreateContentCache()\ncontextCache.ts\nSaves 50-75% input tokens"]
        CACHE --> BUDGET
        BUDGET{"isBudgetExceeded()?\nusage.ts\n8M tokens / $250 daily"}
        BUDGET -->|"exceeded"| BUDGET_BLOCK["⏸️ Budget exceeded"]
        BUDGET -->|"ok"| PROMPT
    end

    subgraph PromptPhase["Prompt Assembly"]
        PROMPT["System prompt:\n• Agent .agent.md\n• Riley personality\n• Governance rules\n• Budget status\n• Tool schemas"]
    end

    PROMPT --> APICALL

    subgraph ToolLoop["Tool Loop (up to maxToolRounds)"]
        APICALL["API Call\nClaude Opus 4.6 / Sonnet 4\nGemini Flash / Pro"]
        APICALL --> HASTOOLS{"Response has\ntool_use blocks?"}
        HASTOOLS -->|"no"| DONE["Final text response"]
        HASTOOLS -->|"yes"| EXEC
        EXEC["executeTool()\ntools.ts\n\n• safePath() — prevent traversal\n• BLOCKED_PATHS — .env, .git\n• Circuit breaker per service\n• 120s timeout"]
        EXEC --> RESULTS["Tool results\nappended to conversation"]
        RESULTS --> APICALL
    end

    subgraph OutputPhase["Output Processing"]
        DONE --> GUARD_OUT
        GUARD_OUT{"classifyOutput()\nguardrails.ts"}
        GUARD_OUT -->|"block"| REDACT["⚠️ Redact response"]
        GUARD_OUT -->|"pass"| RECORD
        RECORD["recordClaudeUsage()\nrecordSpan()\nusage.ts + tracing.ts"]
    end

    RECORD --> RESPONSE["📤 Send to Discord\nvia webhook"]

    subgraph Fallbacks["Error Recovery"]
        direction LR
        RATE["Rate limit → swap model"]
        QUOTA["Quota exhausted → fallback chain"]
        OVERFLOW["Context overflow → prune history"]
        VALIDATE["Validation fail → escalate to Pro"]
    end

    APICALL -.->|"on error"| Fallbacks
    Fallbacks -.->|"retry"| APICALL

    style InputPhase fill:#0d1f0d,stroke:#2ea043,stroke-width:1px,color:#fff
    style ModelPhase fill:#1f1a00,stroke:#d29922,stroke-width:1px,color:#fff
    style PromptPhase fill:#0d1a1f,stroke:#388bfd,stroke-width:1px,color:#fff
    style ToolLoop fill:#1a1040,stroke:#8957e5,stroke-width:2px,color:#fff
    style OutputPhase fill:#1a0d0d,stroke:#f85149,stroke-width:1px,color:#fff
    style Fallbacks fill:#1a1a1a,stroke:#484f58,stroke-width:1px,color:#fff
```

## Key Files Reference

| Layer | File | Purpose |
|-------|------|---------|
| **Entry** | `bot.ts` | Discord client, message routing, startup |
| **Entry** | `setup.ts` | Channel provisioning, structure |
| **Routing** | `handlers/groupchat.ts` | Groupchat orchestration, thread management |
| **Routing** | `handlers/textChannel.ts` | Agent channel handler, history, queues |
| **Core** | `claude.ts` | LLM orchestration, tool loop, model routing |
| **Core** | `agents.ts` | 13 agents, system prompts, registry |
| **Tools** | `tools.ts` | 72 tool definitions, `executeTool()` |
| **Tools** | `toolsDb.ts` | SQL queries, injection prevention |
| **Tools** | `toolsGcp.ts` | GCP operations via `gcloud` CLI |
| **Safety** | `guardrails.ts` | Input/output classification, Gemini Flash |
| **Safety** | `circuitBreaker.ts` | Per-service resilience (open/half-open/closed) |
| **Memory** | `memory.ts` | Conversation persistence, compression |
| **Memory** | `vectorMemory.ts` | Semantic search, pgvector embeddings |
| **Routing** | `handoff.ts` | Agent-to-agent delegation protocol |
| **Infra** | `modelHealth.ts` | Model health tracking, fallback chains |
| **Infra** | `contextCache.ts` | Gemini API prompt caching |
| **Infra** | `usage.ts` | Token/cost tracking, daily budgets |
| **Infra** | `tracing.ts` | OpenTelemetry-style spans |
| **Testing** | `tester.ts` | Live Discord smoke test runner |
| **Testing** | `test-definitions.ts` | Declarative test catalog |
| **Services** | `services/github.ts` | Octokit: branches, PRs, reviews |
| **Services** | `services/cloudrun.ts` | GCP deploy, revisions, rollback |
