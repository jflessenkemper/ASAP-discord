# Cortana Brain Architecture

Open-source model stack mapped to human brain regions. Discord is her only sensory surface.

---

```mermaid
flowchart TD

    subgraph DIN["Discord — Inputs"]
        VOICE_IN("👂 Voice Channel\nOpus 48kHz")
        IMG_IN("👁️ Image Attachments\n.png · .jpg · screenshots")
        TEXT_IN("💬 Text Messages\n#groupchat · #specialists")
        REACT_IN("👍👎 Reactions\nPreference signals")
    end

    subgraph AUDITORY["👂 Auditory Cortex"]
        WHISPER["Faster-Whisper Large-V3-Turbo\nSilero VAD + Pipecat Smart-Turn\n~3 GB · self-tune: rare"]
    end

    subgraph VISUAL["👁️ Visual Cortex"]
        VLM["Qwen3-VL-8B-Instruct\n~12 GB · LAZY-LOADED on image events\nUnsloth LoRA tunable"]
    end

    subgraph THAL["🔀 Thalamus — Router & Dispatcher"]
        ROUTER["Qwen3-1.7B + rule-based intent classifier\n~2 GB · self-tunable\ntext→PFC · voice→ASR→PFC · image→VLM→PFC\nreaction→BG · slash cmd→Cerebellum bypass"]
    end

    subgraph PFC_G["🧠 Prefrontal Cortex — Executive Reasoning"]
        PFC["Qwen3-14B Q4_K_M · ~9 GB\nvLLM serving · LoRA hot-swap in milliseconds\nUnsloth QLoRA nightly · DPO/KTO from reactions\n──────────────────────────────────────────\nPlanning · tool dispatch · 12-specialist delegation\nBroca's: language production\nWernicke's: language comprehension\nCerebellum: code gen shared here"]
    end

    subgraph SUBCORT["Subcortical Layer"]
        subgraph AMY["😤 Amygdala — Emotion"]
            EMOTION["RoBERTa-GoEmotions\n< 1 GB · self-tunable\nUrgency · frustration · praise\nAdjusts PFC response tone"]
        end
        subgraph BG_G["🔁 Basal Ganglia — Self-Tuning"]
            REWARD["Unsloth DPO / KTO loop\n30–60 min nightly · training-time only\n👍 → KTO positive\n👎 → KTO negative\ncorrections → DPO pairs · failures → SFT"]
        end
        subgraph ACC_G["⚡ Anterior Cingulate — Error Detection"]
            MONITOR["DistilBERT classifier\n< 1 GB · self-tunable\nDetects: stalls · hallucinations · off-topic\nFires watchdog if threshold breached"]
        end
    end

    subgraph CEREB_G["🎯 Cerebellum — Procedural Skills"]
        TOOLS["Tool Execution Engine · no dedicated model\n12 self-repair tools\nread_self · edit_self · typecheck · test\ncommit · PR · merge · deploy_self\nAll other GCP / Git / DB tools"]
    end

    subgraph MOTOR_G["🗣️ Motor Cortex — Voice Output"]
        TTS["Chatterbox (MIT) · ~3 GB\nzero-shot voice cloning from Cortana_voice.wav\n──────────────────────────────────────────\nKokoro-82M (Apache 2.0) · ~1 GB\nlow-latency fallback during training windows"]
    end

    subgraph HIPP["🗂️ Hippocampus — Memory"]
        SHORT["Short-Term\nQwen3 KV cache\n~20K token sliding window"]
        LONG["Long-Term\nBGE-M3 · ~1.5 GB\npgvector similarity RAG\ncontrastive fine-tunable"]
        EPIC["Episodic\nPostgres — already live in prod\nagent_memory · agent_learnings\nagent_activity_log · user_events"]
    end

    subgraph DMN_G["💭 Default Mode Network — Idle Introspection"]
        IDLE["Nightly PFC cron — no extra VRAM\nMemory consolidation · prune low-signal vectors\nGoal generation · self-improvement job queue\nUpgrade triage · anomaly detection"]
    end

    subgraph BS_G["⚙️ Brain Stem — Watchdog"]
        WATCH["pm2 + systemd\nINTENTIONALLY ML-FREE — hard rules only\nCORTANA_NO_RESPONSE_TIMEOUT_MS=180000\ntool-activity reset · restart on stall"]
    end

    subgraph DOUT["Discord — Outputs"]
        VOICE_OUT("🔊 Voice Channel Out\n48kHz stereo opus")
        TEXT_OUT("💬 Text Reply\nWebhook · Greek-god identity")
        ACTION_OUT("🔧 Actions\nFile edits · Git · Deploys · GCP")
    end

    %% ── Sensory input wiring ──
    VOICE_IN --> WHISPER
    IMG_IN --> VLM
    TEXT_IN --> ROUTER
    REACT_IN --> REWARD

    WHISPER --> ROUTER
    VLM --> ROUTER
    ROUTER --> PFC

    %% ── Subcortical loops ──
    PFC --> EMOTION
    EMOTION --> PFC
    PFC --> MONITOR
    MONITOR --> WATCH

    %% ── Memory ──
    SHORT -.->|sliding context window| PFC
    LONG --> PFC
    PFC --> LONG
    EPIC <--> LONG

    %% ── Motor output ──
    PFC --> TOOLS
    PFC --> TTS
    PFC --> TEXT_OUT
    TOOLS --> ACTION_OUT
    TTS --> VOICE_OUT

    %% ── Self-tuning & housekeeping ──
    REWARD -.->|nightly LoRA adapter via vLLM hot-swap| PFC
    WATCH -.->|restart if stalled| PFC
    IDLE -.->|cron| PFC
```

---

## VRAM Budget — RTX 3090 / 4090 (24 GB)

| Model | Brain Region | VRAM | Always-on |
|---|---|---|---|
| Qwen3-14B Q4_K_M | PFC + Language | ~9 GB | ✅ |
| Faster-Whisper Large-V3-Turbo | Auditory Cortex | ~3 GB | ✅ |
| Chatterbox | Motor Cortex (voice) | ~3 GB | ✅ |
| Qwen3-1.7B | Thalamus router | ~2 GB | ✅ |
| BGE-M3 | Hippocampus long-term | ~1.5 GB | ✅ |
| RoBERTa-GoEmotions | Amygdala | <1 GB | ✅ |
| DistilBERT | ACC error detector | <1 GB | ✅ |
| KV cache + CUDA overhead | — | ~3 GB | ✅ |
| **Total always-on** | | **~23 GB** | ✅ fits 24 GB |
| Qwen3-VL-8B | Visual Cortex | ~12 GB | ❌ lazy-load — swap Whisper+TTS off temporarily |

---

## Self-Tuning Flywheel

| Trigger | Data | Technique | Tool | Time |
|---|---|---|---|---|
| 👍/👎 reactions | Binary signals | KTO | Unsloth | nightly |
| User corrections | (bad, good) pairs | DPO | Unsloth | nightly |
| Tool failures | Error→fix examples | SFT | Unsloth | nightly |
| RAG misses | Hard negatives | Contrastive | Unsloth | weekly |
| Image corrections | Caption pairs | VLM LoRA | Unsloth | weekly |
| Voice reference update | New voice clip | Zero-shot | Chatterbox | seconds |

New adapter promoted via `vLLM /v1/load_lora_adapter` — **no bot restart**.
