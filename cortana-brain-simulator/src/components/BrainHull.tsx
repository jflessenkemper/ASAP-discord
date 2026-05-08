import { useMemo, useRef, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createNoise3D } from 'simplex-noise';
import { useBrainStore } from '../store';

/**
 * Brain hull — real anatomical pial cortex (MRI-derived, decimated to ~108k tris)
 * plus a procedural cerebellum + brain stem (open-brain repo only ships cortex).
 *
 * The cortex is in MRI patient coordinates (RAS, mm). We re-center, rescale, and
 * reorient to fit the simulator's scene frame:
 *   scene: +X right, +Y dorsal, +Z anterior
 *   MRI:   +X right, +Y anterior, +Z superior
 *
 * Hull fades out as the user explodes the view (so regions can fly free).
 */

const noise = createNoise3D();

// Pre-load the GLB so r3f's Suspense surfaces it fast.
useGLTF.preload('/cortex.glb');

/** Ridged noise: 1 - |n|. Gives sharp ridges (sulci) instead of soft bumps. */
function ridged(x: number, y: number, z: number): number {
  return 1 - Math.abs(noise(x, y, z));
}

function gyriNoise(v: THREE.Vector3, freq: number): number {
  const n1 = ridged(v.x * freq, v.y * freq, v.z * freq);
  const n2 = ridged(v.x * freq * 2.1, v.y * freq * 2.1, v.z * freq * 2.1) * 0.5;
  return (n1 + n2) / 1.5;
}

function buildCerebellum(): THREE.BufferGeometry {
  const geom = new THREE.IcosahedronGeometry(1, 5);
  const pos = geom.attributes.position;
  const v = new THREE.Vector3();

  // Cerebellum: bilateral, sits posterior + ventral relative to cerebrum
  const SX = 1.9;
  const SY = 1.2;
  const SZ = 1.6;

  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    v.x *= SX;
    v.y *= SY;
    v.z *= SZ;

    // Fine, dense foliated ridges (high-freq, anisotropic horizontally)
    const dir = v.clone().normalize();
    const ridges = gyriNoise(new THREE.Vector3(v.x / 2.5, v.y, v.z), 1.6) - 0.5;
    v.addScaledVector(dir, ridges * 0.22);

    // Position offset (in scene coords: y=down, z=back)
    v.y -= 2.0;
    v.z -= 4.5;

    pos.setXYZ(i, v.x, v.y, v.z);
  }
  pos.needsUpdate = true;
  geom.computeVertexNormals();
  if (geom.getAttribute('uv')) geom.deleteAttribute('uv');
  return geom;
}

function buildBrainStem(): THREE.BufferGeometry {
  const geom = new THREE.CapsuleGeometry(0.45, 1.6, 8, 16).toNonIndexed();
  geom.translate(0, -3.2, -2.8);
  if (geom.getAttribute('uv')) geom.deleteAttribute('uv');
  geom.computeVertexNormals();
  return geom;
}

/**
 * Take a loaded MRI cortex mesh and reorient + rescale it to fit our scene.
 * Returns a fresh BufferGeometry, no UVs, normals recomputed.
 */
function adaptCortex(src: THREE.BufferGeometry): THREE.BufferGeometry {
  const geom = src.clone();

  // Compute bbox so we can recenter
  geom.computeBoundingBox();
  const bb = geom.boundingBox!;
  const center = new THREE.Vector3();
  bb.getCenter(center);

  // Target half-extent on the longest dimension. Real brain ≈ 16cm long.
  const size = new THREE.Vector3();
  bb.getSize(size);
  const longest = Math.max(size.x, size.y, size.z);
  const targetLongest = 11; // scene units: cerebrum spans ~11
  const scale = targetLongest / longest;

  const pos = geom.attributes.position;
  const v = new THREE.Vector3();

  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);

    // Recenter
    v.sub(center);

    // Scale uniformly
    v.multiplyScalar(scale);

    // Reorient: MRI (X=right, Y=anterior, Z=superior) → scene (X=right, Y=dorsal, Z=anterior)
    // i.e. swap Y↔Z (and the brain in MRI typically has +Y forward → +Z in scene; +Z up → +Y in scene)
    const sx = v.x;
    const sy = v.z;     // MRI Z (superior) → scene Y (dorsal)
    const sz = v.y;     // MRI Y (anterior) → scene Z (anterior)
    v.set(sx, sy, sz);

    pos.setXYZ(i, v.x, v.y, v.z);
  }
  pos.needsUpdate = true;
  if (geom.getAttribute('uv')) geom.deleteAttribute('uv');
  geom.computeVertexNormals();
  geom.computeBoundingSphere();
  return geom;
}

export function BrainHull() {
  const groupRef = useRef<THREE.Group>(null);
  const cortexMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const extraMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const explode = useBrainStore(s => s.explode);

  const gltf = useGLTF('/cortex.glb');

  // Find the first mesh in the loaded scene and adapt its geometry.
  const cortexGeometry = useMemo(() => {
    let src: THREE.BufferGeometry | null = null;
    gltf.scene.traverse(obj => {
      if (!src && (obj as THREE.Mesh).isMesh) {
        src = (obj as THREE.Mesh).geometry as THREE.BufferGeometry;
      }
    });
    return src ? adaptCortex(src) : null;
  }, [gltf]);

  const cerebellumGeom = useMemo(() => buildCerebellum(), []);
  const stemGeom = useMemo(() => buildBrainStem(), []);

  // Pre-merge cerebellum + brain stem (compatible attribute sets).
  const extraGeom = useMemo(() => {
    const merged = mergeGeometries([cerebellumGeom, stemGeom], false);
    return merged ?? cerebellumGeom;
  }, [cerebellumGeom, stemGeom]);

  // Fade hull as user explodes the brain
  useFrame(() => {
    const op = (1 - explode) * 0.32;
    if (cortexMatRef.current) cortexMatRef.current.opacity = op;
    if (extraMatRef.current) extraMatRef.current.opacity = op * 0.85;
  });

  useEffect(() => {
    return () => {
      cortexGeometry?.dispose();
    };
  }, [cortexGeometry]);

  if (!cortexGeometry) return null;

  return (
    <group ref={groupRef}>
      <mesh geometry={cortexGeometry}>
        <meshStandardMaterial
          ref={cortexMatRef}
          color="#bcdcef"
          emissive="#1a3a5a"
          emissiveIntensity={0.25}
          roughness={0.6}
          metalness={0.05}
          transparent
          opacity={0.32}
          depthWrite={false}
          side={THREE.DoubleSide}
          flatShading={false}
        />
      </mesh>
      <mesh geometry={extraGeom}>
        <meshStandardMaterial
          ref={extraMatRef}
          color="#9ec6e3"
          emissive="#1a3a5a"
          emissiveIntensity={0.3}
          roughness={0.7}
          metalness={0.05}
          transparent
          opacity={0.27}
          depthWrite={false}
          side={THREE.DoubleSide}
          flatShading={false}
        />
      </mesh>
    </group>
  );
}
