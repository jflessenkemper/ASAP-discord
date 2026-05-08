import { useRef, useMemo, Suspense } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Stars, useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { REGIONS, CONNECTIONS } from '../data/regions';
import {
  adaptCortex,
  partitionMeshByCenters,
  buildCerebellumMesh,
  CORTICAL_IDS,
  CEREBELLAR_IDS,
  type PartitionedSlice,
} from '../data/brainGeometry';
import { BrainRegion } from './BrainRegion';
import { SignalEdge } from './SignalEdge';
import { useBrainStore } from '../store';

useGLTF.preload('/cortex.glb');

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
          <lineBasicMaterial color={l.color} transparent opacity={0.1} />
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
 * Loads cortex.glb, adapts it to the scene frame, partitions it into slices
 * for each cortical region, partitions a procedural cerebellum mesh into the
 * two cerebellar regions, and renders one BrainRegion per region with the
 * appropriate geometry.
 */
function BrainAnatomy() {
  const gltf = useGLTF('/cortex.glb');

  const slices = useMemo(() => {
    const map = new Map<string, PartitionedSlice>();

    // Find the cortex mesh in the loaded GLB
    let src: THREE.BufferGeometry | null = null;
    gltf.scene.traverse(o => {
      if (!src && (o as THREE.Mesh).isMesh) {
        src = (o as THREE.Mesh).geometry as THREE.BufferGeometry;
      }
    });
    if (!src) return map;

    const cortex = adaptCortex(src);

    // Partition cortex among the cortical regions
    const corticalCenters = REGIONS
      .filter(r => CORTICAL_IDS.has(r.id))
      .map(r => ({ id: r.id, position: r.position }));
    const cortexSlices = partitionMeshByCenters(cortex, corticalCenters);
    for (const [id, s] of cortexSlices) map.set(id, s);

    // Partition procedural cerebellum among cerebellum + cerebellum_skill
    const cerebellumGeom = buildCerebellumMesh();
    const cerebellarCenters = REGIONS
      .filter(r => CEREBELLAR_IDS.has(r.id))
      .map(r => ({ id: r.id, position: r.position }));
    const cerebellarSlices = partitionMeshByCenters(cerebellumGeom, cerebellarCenters);
    for (const [id, s] of cerebellarSlices) map.set(id, s);

    return map;
  }, [gltf]);

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

      <StaticConnections />
      <ActiveSignals />

      <Suspense fallback={null}>
        <BrainAnatomy />
      </Suspense>

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
