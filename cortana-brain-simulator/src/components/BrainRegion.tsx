import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import type { BrainRegion as BrainRegionT } from '../data/regions';
import { useBrainStore } from '../store';
import { buildRegionGeometry, type PartitionedSlice } from '../data/brainGeometry';

interface Props {
  region: BrainRegionT;
  /** If provided (cortex slice or cerebellum half), use this geometry instead
   *  of building a procedural blob. The slice is in local coords (centered),
   *  and its world position is `slice.centroid`. */
  slice?: PartitionedSlice;
}

export function BrainRegion({ region, slice }: Props) {
  const groupRef = useRef<THREE.Group>(null);
  const meshRef = useRef<THREE.Mesh>(null);
  const glowRef = useRef<THREE.Mesh>(null);

  const active = useBrainStore(s => s.active.get(region.id));
  const selected = useBrainStore(s => s.selectedRegion === region.id);
  const swap = useBrainStore(s => s.swapInProgress);
  const explode = useBrainStore(s => s.explode);
  const selectRegion = useBrainStore(s => s.selectRegion);

  const dim = !region.alwaysOn && !active && !swap;

  // Build (or use provided) geometry. Prefer the partitioned slice.
  const { geometry, scale } = useMemo(() => {
    if (slice) return { geometry: slice.geometry, scale: slice.scale };
    const built = buildRegionGeometry(region);
    return { geometry: built.geometry, scale: built.scale };
  }, [slice, region.id]);

  // Glow halo geometry — same shape, slightly bigger.
  const glowGeometry = useMemo(() => {
    const g = geometry.clone();
    const pos = g.attributes.position;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      v.multiplyScalar(1.12);
      pos.setXYZ(i, v.x, v.y, v.z);
    }
    pos.needsUpdate = true;
    g.computeVertexNormals();
    return g;
  }, [geometry]);

  // Base position: cortex/cerebellum slices live at their slice centroid;
  // procedural regions sit at the anatomical position from the data.
  const basePos: [number, number, number] = slice
    ? [slice.centroid.x, slice.centroid.y, slice.centroid.z]
    : region.position;
  const dir = new THREE.Vector3(...basePos).normalize();
  const radial = new THREE.Vector3(...basePos).length();

  useFrame(() => {
    if (!groupRef.current || !meshRef.current || !glowRef.current) return;

    // Apply explode offset (push outward along anatomical direction)
    const offset = dir.clone().multiplyScalar(radial * explode * 1.4);
    groupRef.current.position.set(
      basePos[0] + offset.x,
      basePos[1] + offset.y,
      basePos[2] + offset.z,
    );

    const intensity = active?.intensity ?? 0;
    const pulse = 1 + intensity * 0.15 + (selected ? 0.04 : 0);
    meshRef.current.scale.setScalar(pulse);
    glowRef.current.scale.setScalar(1 + intensity * 0.3);

    const mat = meshRef.current.material as THREE.MeshStandardMaterial;
    mat.emissiveIntensity = 0.3 + intensity * 1.4 + (selected ? 0.35 : 0);

    const glowMat = glowRef.current.material as THREE.MeshBasicMaterial;
    glowMat.opacity = 0.0 + intensity * 0.32 + (selected ? 0.15 : 0);
  });

  return (
    <group ref={groupRef} position={basePos}>
      {/* Glow halo — visible when active or selected */}
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
          emissiveIntensity={0.3}
          metalness={0.15}
          roughness={0.55}
          opacity={dim ? 0.55 : 1}
          transparent={dim}
          flatShading={false}
          side={slice ? THREE.DoubleSide : THREE.FrontSide}
        />
      </mesh>

      {/* Label */}
      <Html
        position={[0, scale + 0.35, 0]}
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
