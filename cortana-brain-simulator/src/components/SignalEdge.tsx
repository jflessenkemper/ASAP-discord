import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { SignalTrace } from '../store';
import { REGION_BY_ID } from '../data/regions';

const TYPE_COLORS: Record<SignalTrace['type'], string> = {
  sensory: '#ffd479',
  motor: '#ff7b9c',
  memory_read: '#c08fff',
  memory_write: '#a07fff',
  modulation: '#5fffaa',
  broadcast: '#4ec9ff',
  feedback: '#7be8ff',
};

interface Props {
  signal: SignalTrace;
}

export function SignalEdge({ signal }: Props) {
  const meshRef = useRef<THREE.Mesh>(null);
  const trailRef = useRef<THREE.Mesh>(null);

  const fromRegion = REGION_BY_ID[signal.from];
  const toRegion = REGION_BY_ID[signal.to];

  const { start, end, length, midpoint, quat } = useMemo(() => {
    const start = new THREE.Vector3(...fromRegion.position);
    const end = new THREE.Vector3(...toRegion.position);
    const dir = new THREE.Vector3().subVectors(end, start);
    const length = dir.length();
    const midpoint = new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5);
    // Cylinder default axis is +Y, rotate to match dir
    const up = new THREE.Vector3(0, 1, 0);
    const quat = new THREE.Quaternion().setFromUnitVectors(up, dir.clone().normalize());
    return { start, end, length, midpoint, quat };
  }, [fromRegion, toRegion]);

  const color = TYPE_COLORS[signal.type];

  useFrame(() => {
    if (!meshRef.current) return;
    const elapsed = performance.now() - signal.startTime;
    const t = Math.min(elapsed / signal.duration, 1);

    // Move pulse from start to end
    const pos = new THREE.Vector3().lerpVectors(start, end, t);
    meshRef.current.position.copy(pos);

    // Fade in then out
    const fade = t < 0.1 ? t / 0.1 : t > 0.85 ? (1 - t) / 0.15 : 1;
    const mat = meshRef.current.material as THREE.MeshBasicMaterial;
    mat.opacity = fade * 0.95;

    if (trailRef.current) {
      const trailMat = trailRef.current.material as THREE.MeshBasicMaterial;
      trailMat.opacity = fade * 0.25;
    }
  });

  return (
    <group>
      {/* Static trail line */}
      <mesh ref={trailRef} position={midpoint} quaternion={quat}>
        <cylinderGeometry args={[0.025, 0.025, length, 6]} />
        <meshBasicMaterial color={color} transparent opacity={0.2} depthWrite={false} />
      </mesh>

      {/* Moving pulse */}
      <mesh ref={meshRef}>
        <sphereGeometry args={[0.18, 12, 12]} />
        <meshBasicMaterial color={color} transparent opacity={0.9} depthWrite={false} />
      </mesh>
    </group>
  );
}
