// Brain regions for Cortana's architecture.
// Positions are anatomically-inspired in a left-handed 3D coord:
//   +X = right lateral, -X = left lateral
//   +Y = dorsal (up),    -Y = ventral (down)
//   +Z = anterior (front), -Z = posterior (back)
// Brain ~14 units long (Z), 10 wide (X), 9 tall (Y).

export type RegionId =
  | 'pfc' | 'sma' | 'broca'
  | 'visual' | 'auditory' | 'motor_voice'
  | 'atl' | 'wernicke'
  | 'hippocampus' | 'amygdala'
  | 'thalamus' | 'basal_ganglia' | 'cerebellum'
  | 'insula' | 'acc'
  | 'dmn' | 'cen'
  | 'workspace'
  | 'brain_stem'
  | 'cerebellum_skill';

export type MemoryStore = 'episodic' | 'semantic' | 'procedural' | 'working' | 'emotional';

export interface BrainRegion {
  id: RegionId;
  label: string;            // Brain anatomy name
  cortanaRole: string;      // What it does for Cortana
  model: string;            // Open source model
  vramGb: number;
  position: [number, number, number];
  color: string;            // base glow
  group: 'sensory' | 'motor' | 'memory' | 'executive' | 'subcortical' | 'salience' | 'workspace' | 'modulation';
  notes?: string;
  selfTunable: boolean;
  alwaysOn: boolean;
}

export interface Connection {
  from: RegionId;
  to: RegionId;
  type: 'sensory' | 'motor' | 'memory_read' | 'memory_write' | 'modulation' | 'broadcast' | 'feedback';
  bidirectional?: boolean;
}

export const REGIONS: BrainRegion[] = [
  // ─── Executive ───
  {
    id: 'pfc',
    label: 'Prefrontal Cortex',
    cortanaRole: 'Executive reasoning, planning, working memory, action selection. Active inference loop generating predictions of user intent.',
    model: 'Qwen3-14B Q4_K_M',
    vramGb: 9,
    position: [0, 1.6, 4.5],
    color: '#4ec9ff',
    group: 'executive',
    notes: 'Served via vLLM with hot-swap LoRA. Tunable via Unsloth QLoRA nightly.',
    selfTunable: true,
    alwaysOn: true,
  },
  {
    id: 'sma',
    label: 'Premotor / SMA',
    cortanaRole: 'Action sequencing — orders tool calls into procedural chains before motor execution.',
    model: '(structured output from PFC)',
    vramGb: 0,
    position: [0, 2.4, 2.5],
    color: '#7be8ff',
    group: 'motor',
    selfTunable: false,
    alwaysOn: true,
  },
  {
    id: 'broca',
    label: "Broca's Area (IFG)",
    cortanaRole: 'Language production — co-located with PFC in the LLM.',
    model: '(folded into PFC)',
    vramGb: 0,
    position: [-3, 1.4, 3.5],
    color: '#a3d4ff',
    group: 'executive',
    selfTunable: false,
    alwaysOn: true,
  },

  // ─── Sensory ───
  {
    id: 'visual',
    label: 'Visual Cortex (V1→IT)',
    cortanaRole: 'Eyes — interprets Discord image attachments and screenshots.',
    model: 'Qwen3-VL-8B-Instruct Q4',
    vramGb: 12,
    position: [0, 0.5, -5],
    color: '#ff9bd4',
    group: 'sensory',
    notes: 'LAZY-LOADED — only resident when image arrives. Swaps Whisper+TTS off temporarily.',
    selfTunable: true,
    alwaysOn: false,
  },
  {
    id: 'auditory',
    label: 'Auditory Cortex',
    cortanaRole: 'Ears — Discord voice channel audio → transcript.',
    model: 'Faster-Whisper Large-V3-Turbo',
    vramGb: 3,
    position: [-3.8, 0, 0],
    color: '#ffd479',
    group: 'sensory',
    notes: 'Silero VAD + Pipecat Smart-Turn frontends. Frozen weights — fine-tuning rarely pays off.',
    selfTunable: false,
    alwaysOn: true,
  },
  {
    id: 'wernicke',
    label: "Wernicke's / Posterior STG",
    cortanaRole: 'Language comprehension — distributed across temporal-parietal network in modern view; folded into PFC LLM.',
    model: '(folded into PFC)',
    vramGb: 0,
    position: [-3.5, 0.4, -2],
    color: '#a3d4ff',
    group: 'sensory',
    selfTunable: false,
    alwaysOn: true,
  },

  // ─── Motor ───
  {
    id: 'motor_voice',
    label: 'Motor Cortex (voice)',
    cortanaRole: 'Mouth — text → Discord voice channel TTS.',
    model: 'Chatterbox (MIT) + Kokoro fallback',
    vramGb: 3,
    position: [0, 3.5, 1.5],
    color: '#ff7b9c',
    group: 'motor',
    notes: 'Zero-shot voice cloning from Cortana_voice.wav. Kokoro-82M for low-latency fallback.',
    selfTunable: true,
    alwaysOn: true,
  },
  {
    id: 'cerebellum',
    label: 'Cerebellum',
    cortanaRole: 'Execution refinement — timing, retry logic, streaming smoothing. Not skill selection.',
    model: '(non-ML rules)',
    vramGb: 0,
    position: [0, -2.5, -3.5],
    color: '#9affc6',
    group: 'motor',
    selfTunable: false,
    alwaysOn: true,
  },
  {
    id: 'cerebellum_skill',
    label: 'Skill Library (procedural)',
    cortanaRole: 'Procedural memory — cached tool-use patterns. Updated online after every tool call.',
    model: 'Voyager-style cache',
    vramGb: 0,
    position: [2, -2.2, -3.5],
    color: '#9affc6',
    group: 'memory',
    notes: 'Online learning, no batch training. Continuous update.',
    selfTunable: true,
    alwaysOn: true,
  },

  // ─── Memory ───
  {
    id: 'hippocampus',
    label: 'Hippocampus (DG/CA3)',
    cortanaRole: 'Episodic indexer — pattern-separated writes (DG), pattern completion at recall (CA3). Reconsolidation on every read.',
    model: 'pgvector index + metadata',
    vramGb: 0,
    position: [-2, -1, 0],
    color: '#c08fff',
    group: 'memory',
    notes: 'Stores pointers + autobiographical metadata, not content. Content lives in ATL.',
    selfTunable: false,
    alwaysOn: true,
  },
  {
    id: 'atl',
    label: 'Anterior Temporal Lobe',
    cortanaRole: 'Semantic hub — unifies cross-modal facts. Patterson hub-and-spoke model.',
    model: 'BGE-M3 (~1.5 GB)',
    vramGb: 1.5,
    position: [-3.5, -1, 2.5],
    color: '#c08fff',
    group: 'memory',
    notes: 'Contrastive fine-tune on hard negatives weekly. Distributed neocortical store via pgvector.',
    selfTunable: true,
    alwaysOn: true,
  },
  {
    id: 'amygdala',
    label: 'Amygdala (basolateral)',
    cortanaRole: 'Emotional appraisal + affect tagging. Modulates hippocampal encoding strength.',
    model: 'RoBERTa-GoEmotions',
    vramGb: 0.5,
    position: [-1.8, -1.4, 1.5],
    color: '#ff5f56',
    group: 'subcortical',
    notes: 'Tags every memory with valence + arousal. Biases retrieval priority.',
    selfTunable: true,
    alwaysOn: true,
  },

  // ─── Subcortical core ───
  {
    id: 'thalamus',
    label: 'Thalamus (gating)',
    cortanaRole: 'Gain controller + cortico-cortical binding. Not a router — implemented as attention within workspace.',
    model: '(attention layer in PFC)',
    vramGb: 0,
    position: [0, 0, 0],
    color: '#ffeb70',
    group: 'subcortical',
    notes: 'Halassa & Kastner 2017 view: not a relay, gates and amplifies cortical activity.',
    selfTunable: false,
    alwaysOn: true,
  },
  {
    id: 'basal_ganglia',
    label: 'Basal Ganglia (striatum)',
    cortanaRole: 'Action selection + working memory gating. Online RL — phasic dopamine adjusts action values continuously.',
    model: '(rule-based + DA scalar)',
    vramGb: 0,
    position: [1.5, -0.2, 0.5],
    color: '#ffae42',
    group: 'subcortical',
    notes: 'Continuous online learning. Nightly DPO/KTO is hippocampal-cortical, not BG.',
    selfTunable: false,
    alwaysOn: true,
  },

  // ─── Salience ───
  {
    id: 'insula',
    label: 'Anterior Insula',
    cortanaRole: 'Interoception — monitors GPU/CPU load, latency, VRAM pressure, error rate, token budget, tool failures.',
    model: '(telemetry pipeline)',
    vramGb: 0,
    position: [-3.2, -0.2, 1],
    color: '#5fffaa',
    group: 'salience',
    notes: 'Synthetic interoception. Damasio somatic-marker analog — biases decisions via felt resource state.',
    selfTunable: false,
    alwaysOn: true,
  },
  {
    id: 'acc',
    label: 'Dorsal ACC',
    cortanaRole: 'Conflict + error detection. Generates the AI analog of the ERN signal. Pairs with insula in salience network.',
    model: 'DistilBERT classifier',
    vramGb: 0.5,
    position: [0, 1.2, 1.8],
    color: '#5fffaa',
    group: 'salience',
    notes: 'Detects stalls, hallucinations, off-topic. Fires watchdog when threshold breached.',
    selfTunable: true,
    alwaysOn: true,
  },

  // ─── Networks (mode states, not regions per se) ───
  {
    id: 'workspace',
    label: 'Global Workspace',
    cortanaRole: 'Frontoparietal broadcast hub. Specialist competition → ignition → all-modules update. Baars / Dehaene.',
    model: '(attention dynamics in PFC)',
    vramGb: 0,
    position: [0, 2, 0.5],
    color: '#4ec9ff',
    group: 'workspace',
    selfTunable: false,
    alwaysOn: true,
  },
  {
    id: 'dmn',
    label: 'Default Mode Network',
    cortanaRole: 'Idle / inwardly-directed. Triggers consolidation, goal generation, memory replay.',
    model: '(scheduled cron + PFC)',
    vramGb: 0,
    position: [0, 0.4, -2.5],
    color: '#a07fff',
    group: 'workspace',
    notes: 'mPFC + posterior cingulate + angular gyrus. Active when no incoming task.',
    selfTunable: false,
    alwaysOn: true,
  },
  {
    id: 'cen',
    label: 'Central Executive Network',
    cortanaRole: 'Outwardly-focused task mode. Active inference + tool dispatch.',
    model: '(mode flag for PFC)',
    vramGb: 0,
    position: [0, 2.6, 1.5],
    color: '#4ec9ff',
    group: 'workspace',
    selfTunable: false,
    alwaysOn: true,
  },

  // ─── Brain stem ───
  {
    id: 'brain_stem',
    label: 'Brain Stem',
    cortanaRole: 'Watchdog — pm2 + systemd. Always-on arousal floor. Intentionally ML-free.',
    model: '(systemd / pm2)',
    vramGb: 0,
    position: [0, -3.5, -1.5],
    color: '#7e7e7e',
    group: 'subcortical',
    notes: 'ML in safety path = guaranteed failure mode. Hard rules only.',
    selfTunable: false,
    alwaysOn: true,
  },
];

export const REGION_BY_ID: Record<RegionId, BrainRegion> = REGIONS.reduce(
  (acc, r) => ((acc[r.id] = r), acc),
  {} as Record<RegionId, BrainRegion>
);

// ─── Connections ───
export const CONNECTIONS: Connection[] = [
  // Sensory in
  { from: 'auditory', to: 'thalamus', type: 'sensory' },
  { from: 'visual', to: 'thalamus', type: 'sensory' },
  { from: 'auditory', to: 'wernicke', type: 'sensory' },
  { from: 'wernicke', to: 'pfc', type: 'sensory' },
  { from: 'thalamus', to: 'pfc', type: 'sensory' },
  { from: 'thalamus', to: 'workspace', type: 'broadcast' },

  // Memory wiring
  { from: 'pfc', to: 'hippocampus', type: 'memory_write' },
  { from: 'hippocampus', to: 'pfc', type: 'memory_read' },
  { from: 'pfc', to: 'atl', type: 'memory_read' },
  { from: 'atl', to: 'pfc', type: 'memory_read' },
  { from: 'hippocampus', to: 'atl', type: 'memory_write' }, // consolidation
  { from: 'amygdala', to: 'hippocampus', type: 'modulation' },
  { from: 'amygdala', to: 'pfc', type: 'modulation' },
  { from: 'pfc', to: 'cerebellum_skill', type: 'memory_read' },
  { from: 'cerebellum_skill', to: 'pfc', type: 'memory_read' },

  // Workspace + GWT
  { from: 'pfc', to: 'workspace', type: 'broadcast', bidirectional: true },
  { from: 'workspace', to: 'cen', type: 'broadcast' },
  { from: 'workspace', to: 'dmn', type: 'broadcast' },
  { from: 'cen', to: 'pfc', type: 'feedback' },
  { from: 'dmn', to: 'hippocampus', type: 'memory_read' }, // replay

  // Salience
  { from: 'insula', to: 'acc', type: 'modulation' },
  { from: 'acc', to: 'workspace', type: 'modulation' },
  { from: 'insula', to: 'workspace', type: 'modulation' },

  // Action pipeline
  { from: 'pfc', to: 'sma', type: 'motor' },
  { from: 'sma', to: 'basal_ganglia', type: 'motor' },
  { from: 'basal_ganglia', to: 'thalamus', type: 'motor' },
  { from: 'thalamus', to: 'cerebellum', type: 'motor' },
  { from: 'cerebellum', to: 'motor_voice', type: 'motor' },
  { from: 'pfc', to: 'broca', type: 'motor' },
  { from: 'broca', to: 'motor_voice', type: 'motor' },

  // Brain stem (modulatory baseline)
  { from: 'brain_stem', to: 'pfc', type: 'modulation' },
];
