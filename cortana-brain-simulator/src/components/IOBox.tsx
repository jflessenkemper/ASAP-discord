import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import type { IOBox as IOBoxT } from '../data/ioBoxes';
import { useBrainStore } from '../store';

interface Props {
  box: IOBoxT;
}

const tmpColor = new THREE.Color();

/** Render one of the sensory / motor I/O cubes (eye, ear, mouth, spine).
 *  Single solid cube, click-selectable, with a label that shows on hover
 *  or selection. */
export function IOBox({ box }: Props) {
  const groupRef = useRef<THREE.Group>(null);
  const meshRef = useRef<THREE.Mesh>(null);
  const glowRef = useRef<THREE.Mesh>(null);
  const labelRef = useRef<HTMLDivElement>(null);

  const selectIO = useBrainStore(s => s.selectIO);
  const selected = useBrainStore(
    s => s.selection?.kind === 'io' && s.selection.id === box.id,
  );
  const explodeT = useBrainStore(s => s.explodeT);

  const baseColor = useMemo(() => new THREE.Color(box.color), [box.color]);
  const emissiveColor = useMemo(() => new THREE.Color(box.emissive), [box.emissive]);

  // Direction to push outward when "exploded" — relative to brain center.
  const dir = useMemo(() => {
    const v = new THREE.Vector3(...box.position);
    if (v.lengthSq() < 0.0001) return new THREE.Vector3(0, -1, 0);
    return v.clone().normalize();
  }, [box.position]);

  useFrame(() => {
    if (!groupRef.current || !meshRef.current || !glowRef.current) return;

    // I/O boxes drift outward a little when something is selected, like the
    // brain itself — keeps the geometry visually unified.
    const offset = dir.clone().multiplyScalar(explodeT * 0.6);
    groupRef.current.position.set(
      box.position[0] + offset.x,
      box.position[1] + offset.y,
      box.position[2] + offset.z,
    );

    const mat = meshRef.current.material as THREE.MeshStandardMaterial;
    // Slight pulse when selected
    const pulse = selected ? 1.06 : 1.0;
    meshRef.current.scale.setScalar(pulse);

    // Color brightens when selected
    tmpColor.copy(baseColor);
    if (selected) tmpColor.lerp(new THREE.Color('#ffffff'), 0.2);
    mat.color.copy(tmpColor);
    mat.emissive.copy(emissiveColor);
    mat.emissiveIntensity = selected ? 1.2 : 0.5;

    const glowMat = glowRef.current.material as THREE.MeshBasicMaterial;
    glowMat.opacity = selected ? 0.4 : 0.0;

    if (labelRef.current) {
      labelRef.current.style.opacity = selected ? '1' : '0.6';
    }
  });

  const [sx, sy, sz] = box.size;

  return (
    <group ref={groupRef} position={box.position}>
      {/* Glow halo */}
      <mesh ref={glowRef} scale={1.18}>
        <boxGeometry args={[sx, sy, sz]} />
        <meshBasicMaterial
          color={box.color}
          transparent
          opacity={0}
          depthWrite={false}
          side={THREE.BackSide}
        />
      </mesh>

      {/* Cube body */}
      <mesh
        ref={meshRef}
        onClick={(e) => {
          e.stopPropagation();
          selectIO(box.id);
        }}
        onPointerOver={(e) => {
          e.stopPropagation();
          document.body.style.cursor = 'pointer';
        }}
        onPointerOut={() => {
          document.body.style.cursor = 'auto';
        }}
      >
        <boxGeometry args={[sx, sy, sz]} />
        <meshStandardMaterial
          color={box.color}
          emissive={box.emissive}
          emissiveIntensity={0.5}
          metalness={0.15}
          roughness={0.55}
          flatShading
        />
      </mesh>

      {/* Floating label — always visible, brighter when selected */}
      <Html
        position={[0, sy / 2 + 0.45, 0]}
        center
        distanceFactor={12}
        style={{ pointerEvents: 'none' }}
      >
        <div
          ref={labelRef}
          className={`io-label ${selected ? 'selected' : ''}`}
          style={{ opacity: 0.6, transition: 'opacity 0.18s' }}
        >
          {box.shortLabel}
        </div>
      </Html>
    </group>
  );
}
