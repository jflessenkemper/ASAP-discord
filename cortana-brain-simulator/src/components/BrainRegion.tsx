import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import type { BrainRegion as BrainRegionT } from '../data/regions';
import { useBrainStore } from '../store';
import { buildRegionGeometry } from '../data/brainGeometry';

interface Props {
  region: BrainRegionT;
}

export function BrainRegion({ region }: Props) {
  const groupRef = useRef<THREE.Group>(null);
  const meshRef = useRef<THREE.Mesh>(null);
  const glowRef = useRef<THREE.Mesh>(null);

  const active = useBrainStore(s => s.active.get(region.id));
  const selected = useBrainStore(s => s.selectedRegion === region.id);
  const swap = useBrainStore(s => s.swapInProgress);
  const explode = useBrainStore(s => s.explode);
  const selectRegion = useBrainStore(s => s.selectRegion);

  const dim = !region.alwaysOn && !active && !swap;

  // Build the gyrified tissue geometry once.
  const { geometry, scale: regionScale } = useMemo(
    () => buildRegionGeometry(region),
    [region.id]
  );

  // Glow halo geometry — same shape as tissue but slightly bigger.
  const glowGeometry = useMemo(() => {
    const g = geometry.clone();
    const pos = g.attributes.position;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      v.multiplyScalar(1.18);
      pos.setXYZ(i, v.x, v.y, v.z);
    }
    pos.needsUpdate = true;
    g.computeVertexNormals();
    return g;
  }, [geometry]);

  // Compute exploded position by pushing outward from origin.
  const basePos = region.position;
  const radial = new THREE.Vector3(...basePos).length();
  const dir = new THREE.Vector3(...basePos).normalize();

  useFrame(() => {
    if (!groupRef.current || !meshRef.current || !glowRef.current) return;

    // Apply explode offset
    const offset = dir.clone().multiplyScalar(radial * explode * 1.4);
    groupRef.current.position.set(
      basePos[0] + offset.x,
      basePos[1] + offset.y,
      basePos[2] + offset.z,
    );

    const intensity = active?.intensity ?? 0;
    const pulse = 1 + intensity * 0.25 + (selected ? 0.08 : 0);
    meshRef.current.scale.setScalar(pulse);
    glowRef.current.scale.setScalar(1 + intensity * 0.5);

    const mat = meshRef.current.material as THREE.MeshStandardMaterial;
    mat.emissiveIntensity = 0.35 + intensity * 1.6 + (selected ? 0.4 : 0);

    const glowMat = glowRef.current.material as THREE.MeshBasicMaterial;
    glowMat.opacity = 0.0 + intensity * 0.35 + (selected ? 0.15 : 0);
  });

  return (
    <group ref={groupRef} position={basePos}>
      {/* Glow halo — only visible when active or selected */}
      <mesh ref={glowRef} geometry={glowGeometry}>
        <meshBasicMaterial
          color={region.color}
          transparent
          opacity={0}
          depthWrite={false}
          side={THREE.BackSide}
        />
      </mesh>

      {/* Tissue chunk */}
      <mesh
        ref={meshRef}
        geometry={geometry}
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
        <meshStandardMaterial
          color={region.color}
          emissive={region.color}
          emissiveIntensity={0.35}
          metalness={0.15}
          roughness={0.55}
          opacity={dim ? 0.45 : 1}
          transparent={dim}
          flatShading={false}
        />
      </mesh>

      {/* Label */}
      <Html
        position={[0, regionScale + 0.35, 0]}
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
