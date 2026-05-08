import { useRef, useMemo } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Stars } from '@react-three/drei';
import * as THREE from 'three';
import { REGIONS, CONNECTIONS } from '../data/regions';
import { BrainRegion } from './BrainRegion';
import { BrainHull } from './BrainHull';
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

  return (
    <>
      {lines.map(l => (
        <line key={l.key}>
          <primitive object={l.geometry} attach="geometry" />
          <lineBasicMaterial color={l.color} transparent opacity={0.12} />
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

export function BrainScene() {
  const controlsRef = useRef<any>(null);
  const selectRegion = useBrainStore(s => s.selectRegion);

  return (
    <Canvas
      camera={{ position: [11, 4, 14], fov: 38 }}
      style={{ background: 'radial-gradient(ellipse at center, #0a1628 0%, #02060d 100%)' }}
      onPointerMissed={() => selectRegion(null)}
    >
      <ambientLight intensity={0.55} />
      <pointLight position={[10, 10, 10]} intensity={0.7} color="#4ec9ff" />
      <pointLight position={[-10, -5, -10]} intensity={0.4} color="#a07fff" />
      <Stars radius={80} depth={40} count={400} factor={3} fade speed={0.3} />

      <Ticker />

      <BrainHull />
      <StaticConnections />
      <ActiveSignals />

      {REGIONS.map(r => (
        <BrainRegion key={r.id} region={r} />
      ))}

      <OrbitControls
        ref={controlsRef}
        enableDamping
        dampingFactor={0.08}
        minDistance={6}
        maxDistance={28}
        target={[0, 0, 0]}
      />
    </Canvas>
  );
}
