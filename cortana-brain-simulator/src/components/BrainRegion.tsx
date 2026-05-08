import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import type { BrainRegion as BrainRegionT } from '../data/regions';
import { useBrainStore } from '../store';

interface Props {
  region: BrainRegionT;
}

export function BrainRegion({ region }: Props) {
  const meshRef = useRef<THREE.Mesh>(null);
  const glowRef = useRef<THREE.Mesh>(null);
  const active = useBrainStore(s => s.active.get(region.id));
  const selected = useBrainStore(s => s.selectedRegion === region.id);
  const swap = useBrainStore(s => s.swapInProgress);
  const selectRegion = useBrainStore(s => s.selectRegion);

  // Lazy-loaded VLM dims when not loaded
  const dim = !region.alwaysOn && !active && !swap;

  const baseRadius =
    region.id === 'workspace' ? 0.55 :
    region.vramGb >= 9 ? 0.42 :
    region.vramGb >= 3 ? 0.36 :
    region.vramGb > 0 ? 0.3 :
    0.26;

  useFrame(() => {
    if (!meshRef.current || !glowRef.current) return;
    const intensity = active?.intensity ?? 0;
    const pulse = 1 + intensity * 0.4 + (selected ? 0.15 : 0);
    meshRef.current.scale.setScalar(pulse);
    glowRef.current.scale.setScalar(1.6 + intensity * 1.5);
    const mat = meshRef.current.material as THREE.MeshStandardMaterial;
    mat.emissiveIntensity = 0.4 + intensity * 2.0 + (selected ? 0.5 : 0);
    const glowMat = glowRef.current.material as THREE.MeshBasicMaterial;
    glowMat.opacity = 0.05 + intensity * 0.45 + (selected ? 0.1 : 0);
  });

  return (
    <group position={region.position}>
      {/* Outer glow halo */}
      <mesh ref={glowRef}>
        <sphereGeometry args={[baseRadius, 16, 16]} />
        <meshBasicMaterial
          color={region.color}
          transparent
          opacity={0.1}
          depthWrite={false}
        />
      </mesh>

      {/* Core node */}
      <mesh
        ref={meshRef}
        onClick={(e) => {
          e.stopPropagation();
          selectRegion(region.id);
        }}
        onPointerOver={(e) => {
          e.stopPropagation();
          document.body.style.cursor = 'pointer';
        }}
        onPointerOut={() => {
          document.body.style.cursor = 'auto';
        }}
      >
        <sphereGeometry args={[baseRadius, 24, 24]} />
        <meshStandardMaterial
          color={region.color}
          emissive={region.color}
          emissiveIntensity={0.4}
          metalness={0.3}
          roughness={0.4}
          opacity={dim ? 0.4 : 1}
          transparent={dim}
        />
      </mesh>

      {/* Label */}
      <Html
        position={[0, baseRadius + 0.3, 0]}
        center
        distanceFactor={12}
        style={{ pointerEvents: 'none' }}
      >
        <div className={`region-label ${selected ? 'selected' : ''} ${active ? 'active' : ''}`}>
          <div className="region-name">{region.label}</div>
          <div className="region-model">{region.model}</div>
        </div>
      </Html>
    </group>
  );
}
