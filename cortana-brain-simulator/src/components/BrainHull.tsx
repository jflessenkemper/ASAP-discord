import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createNoise3D } from 'simplex-noise';
import { useBrainStore } from '../store';

/**
 * Procedural anatomical brain hull — gives the overall silhouette
 * (cerebrum + longitudinal fissure + cerebellum + brain stem) so the
 * region chunks read as parts of a brain, not floating clumps.
 *
 * Translucent cyan tissue with ridged anisotropic gyri.
 * Fades out as the user explodes the view.
 */

const noise = createNoise3D();

/** Ridged noise: 1 - |n|, rescaled — gives sharp ridges (gyri) instead of soft bumps. */
function ridged(x: number, y: number, z: number): number {
  return 1 - Math.abs(noise(x, y, z));
}

/** Multi-octave anisotropic ridged noise — stretched along one axis to elongate gyri. */
function gyriNoise(v: THREE.Vector3, freq: number, anisoZ = 1.6): number {
  // Stretch input along Z so ridges are elongated front-to-back (like real gyri on lateral surface)
  const x = v.x * freq;
  const y = v.y * freq;
  const z = v.z * freq / anisoZ;
  // Two octaves: large gyri + smaller secondary folds
  const n1 = ridged(x, y, z);
  const n2 = ridged(x * 2.1, y * 2.1, z * 2.1) * 0.5;
  return (n1 + n2) / 1.5;
}

function buildCerebrum(): THREE.BufferGeometry {
  // Detailed icosahedron, ellipsoidal, with longitudinal fissure + gyri
  const geom = new THREE.IcosahedronGeometry(1, 6);
  const pos = geom.attributes.position;
  const v = new THREE.Vector3();

  // Ellipsoidal scale: X (lateral), Y (dorsal-ventral), Z (anterior-posterior)
  const SX = 4.4;
  const SY = 3.6;
  const SZ = 5.2;

  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    // Squish to brain-like ellipsoid; flatten bottom slightly so it sits on cerebellum
    v.x *= SX;
    v.y *= SY * (v.y < -0.4 ? 0.8 : 1.0);   // ventral surface flattened
    v.z *= SZ;

    // Longitudinal fissure: at midline, push surface inward (only on top hemisphere)
    const fissureProximity = Math.exp(-(v.x * v.x) / 0.35);  // near x=0
    const isDorsal = Math.max(0, v.y);                       // only on top
    const fissureDepth = fissureProximity * isDorsal * 0.6;
    v.y -= fissureDepth;

    // Ridged anisotropic gyri displacement along outward normal (use original normalized dir)
    const dir = v.clone().normalize();
    const ridges = gyriNoise(v, 0.35, 1.8) - 0.5;   // centred around 0
    v.addScaledVector(dir, ridges * 0.55);

    pos.setXYZ(i, v.x, v.y, v.z);
  }
  pos.needsUpdate = true;
  geom.computeVertexNormals();
  return geom;
}

function buildCerebellum(): THREE.BufferGeometry {
  const geom = new THREE.IcosahedronGeometry(1, 5);
  const pos = geom.attributes.position;
  const v = new THREE.Vector3();

  // Bilateral, sits at (0, -2, -4.5), wider than tall
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
    // Cerebellum has horizontal folia — stretch noise along X
    const ridges = gyriNoise(new THREE.Vector3(v.x / 2.5, v.y, v.z), 1.6, 0.6) - 0.5;
    v.addScaledVector(dir, ridges * 0.22);

    // Position offset
    v.y -= 2.0;
    v.z -= 4.5;

    pos.setXYZ(i, v.x, v.y, v.z);
  }
  pos.needsUpdate = true;
  geom.computeVertexNormals();
  return geom;
}

function buildBrainStem(): THREE.BufferGeometry {
  // Capsule is indexed while icosahedrons are not — convert so it can merge cleanly.
  const geom = new THREE.CapsuleGeometry(0.45, 1.6, 8, 16).toNonIndexed();
  geom.translate(0, -3.2, -2.8);
  return geom;
}

function buildHull(): THREE.BufferGeometry {
  const cerebrum = buildCerebrum();
  const cerebellum = buildCerebellum();
  const stem = buildBrainStem();
  // Strip UVs so all three geometries have identical attributes (just position+normal).
  for (const g of [cerebrum, cerebellum, stem]) {
    if (g.getAttribute('uv')) g.deleteAttribute('uv');
    g.computeVertexNormals();
  }
  const merged = mergeGeometries([cerebrum, cerebellum, stem], false);
  return merged ?? cerebrum;
}

export function BrainHull() {
  const meshRef = useRef<THREE.Mesh>(null);
  const explode = useBrainStore(s => s.explode);

  const geometry = useMemo(() => buildHull(), []);

  useFrame(() => {
    if (!meshRef.current) return;
    const mat = meshRef.current.material as THREE.MeshStandardMaterial;
    // Fade hull as user explodes the brain
    mat.opacity = (1 - explode) * 0.22;
  });

  return (
    <mesh ref={meshRef} geometry={geometry}>
      <meshStandardMaterial
        color="#9ec6e3"
        emissive="#1a3a5a"
        emissiveIntensity={0.35}
        roughness={0.7}
        metalness={0.1}
        transparent
        opacity={0.22}
        depthWrite={false}
        side={THREE.DoubleSide}
        flatShading={false}
      />
    </mesh>
  );
}
