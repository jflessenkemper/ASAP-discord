import { create } from 'zustand';
import type { RegionId, Connection } from './data/regions';
import { ACTIVATIONS, INPUTS } from './data/inputs';
import type { InputId } from './data/inputs';

export interface SignalTrace {
  id: string;
  from: RegionId;
  to: RegionId;
  type: Connection['type'];
  startTime: number;     // performance.now() ms
  duration: number;      // ms
}

export interface ActiveRegion {
  id: RegionId;
  startTime: number;
  duration: number;
  intensity: number;     // 0-1
}

export interface LogEntry {
  ts: number;
  inputId?: InputId;
  text: string;
  level: 'info' | 'warn' | 'fault';
}

export interface NeuromodState {
  da_tonic: number;     // 0-1, baseline 0.5
  da_phasic: number;    // -1 to 1, decays fast
  ne: number;           // 0-1, baseline 0.2
  ach: number;          // 0-1, baseline 0.4
  ser: number;          // 0-1, baseline 0.5
}

export interface BrainState {
  active: Map<RegionId, ActiveRegion>;
  signals: SignalTrace[];
  log: LogEntry[];
  selectedRegion: RegionId | null;
  neuromod: NeuromodState;
  vlmLoaded: boolean;       // is the VLM currently resident?
  swapInProgress: boolean;  // are we mid-swap?
  totalActivations: number;
  faultsDetected: string[];
  explode: number;          // 0 = anatomical, 1 = exploded view

  fireInput: (inputId: InputId) => void;
  selectRegion: (id: RegionId | null) => void;
  setExplode: (v: number) => void;
  tick: () => void;             // called every animation frame to expire activations + decay neuromod
  reset: () => void;
}

const NEUROMOD_BASELINE: NeuromodState = {
  da_tonic: 0.5,
  da_phasic: 0,
  ne: 0.2,
  ach: 0.4,
  ser: 0.5,
};

const NEUROMOD_DECAY = {
  da_tonic: 0.0001,    // very slow
  da_phasic: 0.005,    // fast — phasic spikes decay back to 0
  ne: 0.001,
  ach: 0.001,
  ser: 0.0005,
};

function clamp(v: number, lo = 0, hi = 1) {
  return Math.max(lo, Math.min(hi, v));
}

export const useBrainStore = create<BrainState>((set, get) => ({
  active: new Map(),
  signals: [],
  log: [],
  selectedRegion: null,
  neuromod: { ...NEUROMOD_BASELINE },
  vlmLoaded: false,
  swapInProgress: false,
  totalActivations: 0,
  faultsDetected: [],
  explode: 0,

  fireInput: (inputId: InputId) => {
    const activation = ACTIVATIONS[inputId];
    const input = INPUTS.find(i => i.id === inputId)!;
    const now = performance.now();
    const state = get();

    // Detect VLM swap fault
    let logs: LogEntry[] = [];
    if (inputId === 'image_attachment') {
      set({ swapInProgress: true, vlmLoaded: false });
      setTimeout(() => set({ swapInProgress: false, vlmLoaded: true }), 1500);
    }
    if (inputId === 'concurrent_image_voice') {
      set({ swapInProgress: true });
      setTimeout(() => set({ swapInProgress: false }), 2500);
    }
    if (inputId === 'voice_utterance' && state.swapInProgress) {
      logs.push({
        ts: now,
        inputId,
        text: '⚠️ FAULT DETECTED: voice utterance arrived during VLM swap — audio buffer at risk',
        level: 'fault',
      });
    }

    // Schedule activation steps
    activation.steps.forEach((step, idx) => {
      setTimeout(() => {
        set(s => {
          const next = new Map(s.active);
          step.regions.forEach(rid => {
            next.set(rid, {
              id: rid,
              startTime: performance.now(),
              duration: step.durationMs,
              intensity: 1,
            });
          });
          const newSignals: SignalTrace[] = (step.signal ?? []).map((sg, i) => ({
            id: `${inputId}-${idx}-${i}-${performance.now()}`,
            from: sg.from,
            to: sg.to,
            type: sg.type,
            startTime: performance.now(),
            duration: 600,
          }));
          return {
            active: next,
            signals: [...s.signals, ...newSignals],
            log: step.label
              ? [
                  ...s.log,
                  { ts: performance.now(), inputId, text: step.label, level: 'info' },
                ].slice(-50)
              : s.log,
          };
        });
      }, step.delayMs);
    });

    // Apply neuromodulator effects
    if (activation.neuromod) {
      set(s => {
        const nm = { ...s.neuromod };
        if (activation.neuromod!.da_tonic) nm.da_tonic = clamp(nm.da_tonic + activation.neuromod!.da_tonic);
        if (activation.neuromod!.da_phasic) nm.da_phasic = clamp(nm.da_phasic + activation.neuromod!.da_phasic, -1, 1);
        if (activation.neuromod!.ne) nm.ne = clamp(nm.ne + activation.neuromod!.ne);
        if (activation.neuromod!.ach) nm.ach = clamp(nm.ach + activation.neuromod!.ach);
        if (activation.neuromod!.ser) nm.ser = clamp(nm.ser + activation.neuromod!.ser);
        return { neuromod: nm };
      });
    }

    // Surface known faults
    const faults = activation.faults ?? [];

    set(s => ({
      log: [
        ...s.log,
        { ts: now, inputId, text: `▶ Fired: ${input.label}`, level: 'info' },
        ...logs,
      ].slice(-50),
      totalActivations: s.totalActivations + 1,
      faultsDetected: faults.length
        ? [...new Set([...s.faultsDetected, ...faults])]
        : s.faultsDetected,
    }));
  },

  selectRegion: (id) => set({ selectedRegion: id }),

  setExplode: (v) => set({ explode: Math.max(0, Math.min(1, v)) }),

  tick: () => {
    const now = performance.now();
    const s = get();

    // Bail if nothing to update — avoids hammering React with new refs every frame.
    const idle =
      s.active.size === 0 &&
      s.signals.length === 0 &&
      Math.abs(s.neuromod.da_tonic - NEUROMOD_BASELINE.da_tonic) < 0.001 &&
      Math.abs(s.neuromod.da_phasic) < 0.001 &&
      Math.abs(s.neuromod.ne - NEUROMOD_BASELINE.ne) < 0.001 &&
      Math.abs(s.neuromod.ach - NEUROMOD_BASELINE.ach) < 0.001 &&
      Math.abs(s.neuromod.ser - NEUROMOD_BASELINE.ser) < 0.001;
    if (idle) return;

    set(state => {
      // Expire active regions
      const next = new Map<RegionId, ActiveRegion>();
      for (const [k, v] of state.active.entries()) {
        const elapsed = now - v.startTime;
        if (elapsed < v.duration) {
          next.set(k, { ...v, intensity: 1 - elapsed / v.duration });
        }
      }
      // Expire signals
      const sigs = state.signals.filter(sg => now - sg.startTime < sg.duration);

      // Decay neuromodulators back toward baseline
      const nm = { ...state.neuromod };
      const lerp = (cur: number, base: number, rate: number) =>
        cur + (base - cur) * rate;
      nm.da_tonic = lerp(nm.da_tonic, NEUROMOD_BASELINE.da_tonic, NEUROMOD_DECAY.da_tonic);
      nm.da_phasic = lerp(nm.da_phasic, 0, NEUROMOD_DECAY.da_phasic);
      nm.ne = lerp(nm.ne, NEUROMOD_BASELINE.ne, NEUROMOD_DECAY.ne);
      nm.ach = lerp(nm.ach, NEUROMOD_BASELINE.ach, NEUROMOD_DECAY.ach);
      nm.ser = lerp(nm.ser, NEUROMOD_BASELINE.ser, NEUROMOD_DECAY.ser);

      // Reuse refs for unchanged collections to avoid spurious re-renders.
      const activeNext = next.size === 0 && state.active.size === 0 ? state.active : next;
      const sigsNext = sigs.length === 0 && state.signals.length === 0 ? state.signals : sigs;

      return { active: activeNext, signals: sigsNext, neuromod: nm };
    });
  },

  reset: () => set(s => ({
    active: new Map(),
    signals: [],
    log: [],
    selectedRegion: null,
    neuromod: { ...NEUROMOD_BASELINE },
    vlmLoaded: false,
    swapInProgress: false,
    totalActivations: 0,
    faultsDetected: [],
    explode: s.explode,   // preserve user's view setting
  })),
}));
