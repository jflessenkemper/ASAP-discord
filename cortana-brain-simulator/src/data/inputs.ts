import type { RegionId } from './regions';

export type InputId =
  | 'text_message'
  | 'voice_utterance'
  | 'image_attachment'
  | 'mention'
  | 'reaction_up'
  | 'reaction_down'
  | 'slash_command'
  | 'tool_failure'
  | 'voice_barge_in'
  | 'idle_timeout'
  | 'concurrent_image_voice';

export interface DiscordInput {
  id: InputId;
  label: string;
  emoji: string;
  description: string;
}

export const INPUTS: DiscordInput[] = [
  { id: 'text_message',  label: 'Text Message',  emoji: '💬', description: 'User types a message in #groupchat' },
  { id: 'voice_utterance', label: 'Voice Utterance', emoji: '🎤', description: 'User speaks in voice channel' },
  { id: 'image_attachment', label: 'Image Attachment', emoji: '🖼️', description: 'User attaches a screenshot/photo' },
  { id: 'mention', label: '@ Mention', emoji: '📣', description: 'User @-mentions Cortana — high arousal trigger' },
  { id: 'reaction_up', label: '👍 Reaction', emoji: '👍', description: 'Positive feedback — KTO positive signal' },
  { id: 'reaction_down', label: '👎 Reaction', emoji: '👎', description: 'Negative feedback — KTO negative signal' },
  { id: 'slash_command', label: 'Slash Command', emoji: '⚡', description: 'Direct tool invocation — bypasses PFC' },
  { id: 'tool_failure', label: 'Tool Failure', emoji: '💥', description: 'Tool returned error — ACC fires' },
  { id: 'voice_barge_in', label: 'Voice Barge-in', emoji: '✋', description: 'User talks while Cortana is speaking' },
  { id: 'idle_timeout', label: 'Idle 5 min', emoji: '💤', description: 'No activity — DMN takes over for replay' },
  { id: 'concurrent_image_voice', label: 'Image + Voice', emoji: '🎬', description: 'Image and voice arrive together — VLM swap conflict' },
];

// Each input fires a sequence of activations through the brain.
// Each step: list of regions that fire, with optional delayMs offset.
export interface ActivationStep {
  regions: RegionId[];
  delayMs: number;       // ms after input fires
  durationMs: number;    // how long the regions stay lit
  signal?: { from: RegionId; to: RegionId; type: import('./regions').Connection['type'] }[];
  label?: string;        // shown in event log
}

export interface NeuromodEffect {
  da_tonic?: number;
  da_phasic?: number;
  ne?: number;
  ach?: number;
  ser?: number;
}

export interface Activation {
  steps: ActivationStep[];
  neuromod?: NeuromodEffect;
  faults?: string[];     // potential faults this input can surface
}

export const ACTIVATIONS: Record<InputId, Activation> = {
  text_message: {
    steps: [
      { regions: ['thalamus'], delayMs: 0, durationMs: 300, label: 'Input gated through thalamus' },
      { regions: ['wernicke', 'pfc'], delayMs: 100, durationMs: 800, signal: [{ from: 'thalamus', to: 'pfc', type: 'sensory' }], label: 'Language comprehension + PFC activation' },
      { regions: ['atl', 'hippocampus'], delayMs: 300, durationMs: 600, signal: [{ from: 'pfc', to: 'atl', type: 'memory_read' }, { from: 'pfc', to: 'hippocampus', type: 'memory_read' }], label: 'Semantic + episodic recall' },
      { regions: ['workspace'], delayMs: 600, durationMs: 500, signal: [{ from: 'pfc', to: 'workspace', type: 'broadcast' }], label: 'Workspace broadcast (GWT ignition)' },
      { regions: ['acc'], delayMs: 700, durationMs: 300, label: 'ACC monitors output for conflict' },
      { regions: ['broca', 'motor_voice'], delayMs: 900, durationMs: 600, signal: [{ from: 'pfc', to: 'broca', type: 'motor' }], label: 'Language production' },
      { regions: ['hippocampus'], delayMs: 1500, durationMs: 400, signal: [{ from: 'pfc', to: 'hippocampus', type: 'memory_write' }], label: 'Encode interaction → episodic memory' },
    ],
    neuromod: { ach: 0.1, ne: 0.05 },
  },

  voice_utterance: {
    steps: [
      { regions: ['auditory'], delayMs: 0, durationMs: 600, label: 'Whisper transcribes audio' },
      { regions: ['thalamus', 'wernicke'], delayMs: 400, durationMs: 400, signal: [{ from: 'auditory', to: 'wernicke', type: 'sensory' }] },
      { regions: ['pfc', 'atl', 'hippocampus'], delayMs: 700, durationMs: 800, signal: [{ from: 'wernicke', to: 'pfc', type: 'sensory' }] },
      { regions: ['workspace'], delayMs: 1100, durationMs: 500 },
      { regions: ['broca', 'cerebellum', 'motor_voice'], delayMs: 1400, durationMs: 800, signal: [{ from: 'pfc', to: 'motor_voice', type: 'motor' }], label: 'Chatterbox TTS streams reply' },
    ],
    neuromod: { ach: 0.15, ne: 0.1 },
    faults: ['Endpoint silence misjudged → late response', 'Backchannel not suppressed → cuts user off'],
  },

  image_attachment: {
    steps: [
      { regions: ['visual'], delayMs: 0, durationMs: 1500, label: 'VLM lazy-load (~3s) — Whisper + Chatterbox swap off!' },
      { regions: ['insula', 'acc'], delayMs: 100, durationMs: 1500, label: 'Insula registers VRAM pressure → high salience' },
      { regions: ['thalamus', 'pfc'], delayMs: 1500, durationMs: 600, signal: [{ from: 'visual', to: 'pfc', type: 'sensory' }] },
      { regions: ['atl'], delayMs: 1800, durationMs: 500, signal: [{ from: 'pfc', to: 'atl', type: 'memory_read' }] },
      { regions: ['workspace', 'broca', 'motor_voice'], delayMs: 2100, durationMs: 700 },
    ],
    neuromod: { ach: 0.25, ne: 0.2 },
    faults: ['VRAM swap blackout — voice path dead 2-3s', 'If voice arrives during swap, signal is dropped'],
  },

  mention: {
    steps: [
      { regions: ['thalamus'], delayMs: 0, durationMs: 200, label: 'Mention detected → NE phasic spike' },
      { regions: ['acc', 'workspace'], delayMs: 100, durationMs: 600, label: 'Salience network fires hard — switch to CEN' },
      { regions: ['cen', 'pfc'], delayMs: 300, durationMs: 800 },
    ],
    neuromod: { ne: 0.4, ach: 0.2, da_phasic: 0.1 },
  },

  reaction_up: {
    steps: [
      { regions: ['amygdala'], delayMs: 0, durationMs: 300, label: 'Positive valence tag' },
      { regions: ['basal_ganglia'], delayMs: 100, durationMs: 400, label: 'DA phasic spike → reinforces last action' },
      { regions: ['hippocampus'], delayMs: 300, durationMs: 500, signal: [{ from: 'amygdala', to: 'hippocampus', type: 'modulation' }], label: 'Affect-tag last memory as positive' },
      { regions: ['cerebellum_skill'], delayMs: 500, durationMs: 400, label: 'Skill library: bump weight on last tool pattern' },
    ],
    neuromod: { da_tonic: 0.15, da_phasic: 0.5, ser: 0.05 },
  },

  reaction_down: {
    steps: [
      { regions: ['amygdala', 'acc'], delayMs: 0, durationMs: 400, label: 'Negative valence + error signal' },
      { regions: ['basal_ganglia'], delayMs: 200, durationMs: 400, label: 'DA phasic dip — reduces last action value' },
      { regions: ['hippocampus'], delayMs: 400, durationMs: 500, label: 'Tag memory negative → flag for REM recombination' },
      { regions: ['dmn'], delayMs: 700, durationMs: 600, label: 'DMN queues for offline reflection' },
    ],
    neuromod: { da_tonic: -0.15, da_phasic: -0.5, ser: -0.1, ne: 0.1 },
    faults: ['Sustained 👎 stream → DA tonic floor → response vigor zero (need floor!)'],
  },

  slash_command: {
    steps: [
      { regions: ['thalamus'], delayMs: 0, durationMs: 100 },
      { regions: ['basal_ganglia', 'sma', 'cerebellum_skill'], delayMs: 50, durationMs: 400, label: 'Direct tool path — bypasses PFC' },
      { regions: ['cerebellum'], delayMs: 300, durationMs: 600, label: 'Tool execution refinement' },
    ],
    neuromod: { ach: 0.05 },
  },

  tool_failure: {
    steps: [
      { regions: ['acc'], delayMs: 0, durationMs: 400, label: 'ERN equivalent — error signal' },
      { regions: ['insula'], delayMs: 100, durationMs: 500, label: 'Interoceptive distress' },
      { regions: ['amygdala'], delayMs: 200, durationMs: 400 },
      { regions: ['workspace', 'pfc'], delayMs: 400, durationMs: 700, label: 'Switch to repair planning' },
      { regions: ['cerebellum_skill'], delayMs: 600, durationMs: 400, label: 'Mark tool pattern as failed → demote' },
    ],
    neuromod: { ne: 0.3, da_phasic: -0.3 },
  },

  voice_barge_in: {
    steps: [
      { regions: ['auditory'], delayMs: 0, durationMs: 200 },
      { regions: ['acc', 'insula'], delayMs: 100, durationMs: 300, label: 'Salience: user speaking while Cortana speaks' },
      { regions: ['motor_voice'], delayMs: 200, durationMs: 100, label: 'Graceful stream drain — no hard cut' },
      { regions: ['pfc', 'workspace'], delayMs: 400, durationMs: 500, label: 'Replan response' },
    ],
    neuromod: { ne: 0.25, ach: 0.15 },
    faults: ['If using .abort() instead of .end(), audio cuts mid-word', 'Backchannel suppression must hold'],
  },

  idle_timeout: {
    steps: [
      { regions: ['dmn'], delayMs: 0, durationMs: 1000, label: 'DMN takes over — task-positive networks dim' },
      { regions: ['hippocampus', 'atl'], delayMs: 500, durationMs: 1500, label: 'Awake replay — recent episodes → semantic store' },
      { regions: ['amygdala'], delayMs: 1000, durationMs: 800, label: 'Affect-prioritized memory selection' },
      { regions: ['pfc'], delayMs: 1800, durationMs: 800, label: 'Goal generation pass' },
    ],
    neuromod: { ach: -0.2, ne: -0.3, ser: 0.2 },
  },

  concurrent_image_voice: {
    steps: [
      { regions: ['visual', 'auditory'], delayMs: 0, durationMs: 2500, label: '⚠️ FAULT: VLM swap evicts Whisper mid-utterance!' },
      { regions: ['insula', 'acc'], delayMs: 100, durationMs: 2500, label: 'Salience: high VRAM pressure detected' },
      { regions: ['pfc'], delayMs: 2500, durationMs: 800, label: 'Recovery — replay buffered audio' },
    ],
    neuromod: { ne: 0.5, ach: 0.3 },
    faults: [
      'VRAM contention: cannot keep VLM + Whisper both resident',
      'Buffered audio may be lost during swap window',
      'User experiences silence + delayed reply',
    ],
  },
};
