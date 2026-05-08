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

// Real brain-tissue color (pink-grey, slightly desaturated). Used at rest.
const BRAIN_TISSUE = new THREE.Color('#c89c8a');
const BRAIN_TISSUE_EMISSIVE = new THREE.Color('#3a1814');

// Scratch colors so we don't allocate per frame
const tmpColor = new THREE.Color();
const tmpEmissive = new THREE.Color();

export function BrainRegion({ region, slice }: Props) {
  const groupRef = useRef<THREE.Group>(null);
  const meshRef = useRef<THREE.Mesh>(null);
  const glowRef = useRef<THREE.Mesh>(null);
  const labelRef = useRef<HTMLDivElement>(null);

  const active = useBrainStore(s => s.active.get(region.id));
  const selected = useBrainStore(s => s.selectedRegion === region.id);
  const swap = useBrainStore(s => s.swapInProgress);
  const explodeT = useBrainStore(s => s.explodeT);
  const selectRegion = useBrainStore(s => s.selectRegion);

  const regionColor = useMemo(() => new THREE.Color(region.color), [region.color]);

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
  const dir = useMemo(() => new THREE.Vector3(...basePos).normalize(), [basePos[0], basePos[1], basePos[2]]);
  const radial = useMemo(() => new THREE.Vector3(...basePos).length(), [basePos[0], basePos[1], basePos[2]]);

  useFrame(() => {
    if (!groupRef.current || !meshRef.current || !glowRef.current) return;

    // Apply explode offset (push outward along anatomical direction)
    const offset = dir.clone().multiplyScalar(radial * explodeT * 1.4);
    groupRef.current.position.set(
      basePos[0] + offset.x,
      basePos[1] + offset.y,
      basePos[2] + offset.z,
    );

    const intensity = active?.intensity ?? 0;
    const pulse = 1 + intensity * 0.15 + (selected ? 0.04 : 0);
    meshRef.current.scale.setScalar(pulse);
    glowRef.current.scale.setScalar(1 + intensity * 0.3);

    // Color lerp: at rest, the cortex/cerebellum looks like real tissue.
    // As explodeT → 1, each region fades to its own color.
    const mat = meshRef.current.material as THREE.MeshStandardMaterial;
    tmpColor.copy(BRAIN_TISSUE).lerp(regionColor, explodeT);
    mat.color.copy(tmpColor);
    tmpEmissive.copy(BRAIN_TISSUE_EMISSIVE).lerp(regionColor, explodeT);
    mat.emissive.copy(tmpEmissive);
    mat.emissiveIntensity = (0.18 + intensity * 1.2 + (selected ? 0.3 : 0)) * (0.6 + 0.4 * explodeT);

    // All regions are part of the solid brain envelope at rest.
    // Lazy-loaded modules (alwaysOn=false) dim slightly when idle to hint
    // "not resident".
    const dimNow = !region.alwaysOn && !active && !swap;
    mat.opacity = dimNow ? 0.7 : 1.0;
    mat.transparent = dimNow;

    const glowMat = glowRef.current.material as THREE.MeshBasicMaterial;
    glowMat.opacity = (intensity * 0.32 + (selected ? 0.15 : 0)) * (0.4 + 0.6 * explodeT);

    // Hide labels until the brain is mostly exploded
    if (labelRef.current) {
      const labelOpacity = Math.max(0, (explodeT - 0.25) / 0.5);
      labelRef.current.style.opacity = String(labelOpacity);
      labelRef.current.style.visibility = labelOpacity > 0.01 ? 'visible' : 'hidden';
    }
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
          color={BRAIN_TISSUE}
          emissive={BRAIN_TISSUE_EMISSIVE}
          emissiveIntensity={0.18}
          metalness={0.05}
          roughness={0.78}
          opacity={1}
          transparent={false}
          flatShading={false}
          side={THREE.FrontSide}
        />
      </mesh>

      {/* Label — gated by explodeT in useFrame */}
      <Html
        position={[0, scale + 0.35, 0]}
        center
        distanceFactor={12}
        style={{ pointerEvents: 'none' }}
      >
        <div
          ref={labelRef}
          className={`region-label ${selected ? 'selected' : ''} ${active ? 'active' : ''}`}
          style={{ opacity: 0, visibility: 'hidden', transition: 'none' }}
        >
          <div className="region-name">{region.label}</div>
          <div className="region-model">{region.model}</div>
        </div>
      </Html>
    </group>
  );
}
