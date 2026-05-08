import { useRef, useMemo } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Stars } from '@react-three/drei';
import * as THREE from 'three';
import { REGIONS, CONNECTIONS } from '../data/regions';
import { IO_BOXES } from '../data/ioBoxes';
import { buildBlockyBrainPartition } from '../data/brainGeometry';
import { BrainRegion } from './BrainRegion';
import { IOBox } from './IOBox';
import { SignalEdge } from './SignalEdge';
import { useBrainStore } from '../store';

const CONN_TYPE_COLORS: Record<string, string> = {
  sensory: '#ffd479',
  motor: '#ff7b9c',
  memory_read: '#c08fff',
  memory_write: '#a07fff',
  modulation: '#5fffaa',
  broadcast: '#4ec9ff',
  feedback: '#7be8ff',
};

function StaticConnections() {
  const explodeT = useBrainStore(s => s.explodeT);
  const lines = useMemo(() => {
    return CONNECTIONS.map((c, i) => {
      const from = REGIONS.find(r => r.id === c.from)!;
      const to = REGIONS.find(r => r.id === c.to)!;
      const points = [
        new THREE.Vector3(...from.position),
        new THREE.Vector3(...to.position),
      ];
      const geometry = new THREE.BufferGeometry().setFromPoints(points);
      return { geometry, color: CONN_TYPE_COLORS[c.type] ?? '#666', key: `${c.from}-${c.to}-${i}` };
    });
  }, []);

  // Connections only make sense once the brain has split open — hide them otherwise.
  if (explodeT < 0.05) return null;

  return (
    <>
      {lines.map(l => (
        <line key={l.key}>
          <primitive object={l.geometry} attach="geometry" />
          <lineBasicMaterial color={l.color} transparent opacity={0.18 * explodeT} />
        </line>
      ))}
    </>
  );
}

function Ticker() {
  const tick = useBrainStore(s => s.tick);
  useFrame(() => tick());
  return null;
}

function ActiveSignals() {
  const signals = useBrainStore(s => s.signals);
  return (
    <>
      {signals.map(sig => (
        <SignalEdge key={sig.id} signal={sig} />
      ))}
    </>
  );
}

/**
 * Builds a blocky voxel brain (cerebrum + cerebellum + brainstem envelope),
 * Voronoi-partitions the cubes among ALL region centers, and renders one
 * BrainRegion per region. At rest the cubes pack into a rough brain
 * silhouette; on explode each region's cluster flies out as a coherent chunk.
 */
function BrainAnatomy() {
  const slices = useMemo(() => {
    const centers = REGIONS.map(r => ({ id: r.id, position: r.position }));
    return buildBlockyBrainPartition(centers);
  }, []);

  return (
    <>
      {REGIONS.map(r => (
        <BrainRegion key={r.id} region={r} slice={slices.get(r.id)} />
      ))}
    </>
  );
}

export function BrainScene() {
  const controlsRef = useRef<any>(null);
  const clearSelection = useBrainStore(s => s.clearSelection);

  return (
    <Canvas
      camera={{ position: [13, 4, 16], fov: 40 }}
      style={{ background: 'radial-gradient(ellipse at center, #0a1628 0%, #02060d 100%)' }}
      onPointerMissed={() => clearSelection()}
    >
      <ambientLight intensity={0.55} />
      <pointLight position={[10, 10, 10]} intensity={0.7} color="#4ec9ff" />
      <pointLight position={[-10, -5, -10]} intensity={0.4} color="#a07fff" />
      <Stars radius={80} depth={40} count={400} factor={3} fade speed={0.3} />

      <Ticker />

      <StaticConnections />
      <ActiveSignals />

      <BrainAnatomy />

      {IO_BOXES.map(b => (
        <IOBox key={b.id} box={b} />
      ))}

      <OrbitControls
        ref={controlsRef}
        enableDamping
        dampingFactor={0.08}
        minDistance={8}
        maxDistance={36}
        target={[0, 0, 0]}
      />
    </Canvas>
  );
}
