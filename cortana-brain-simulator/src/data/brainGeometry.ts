import * as THREE from 'three';
import { createNoise3D } from 'simplex-noise';
import type { BrainRegion } from './regions';

// One noise field shared across all geometry — gives consistent "tissue" look.
const noise = createNoise3D();

export interface RegionShape {
  geometry: THREE.BufferGeometry;
  scale: number;       // visual scale (used for label offset)
}

/**
 * Build a brain-tissue-shaped chunk for a region.
 * Cortex regions get high-frequency gyri; subcortical structures are
 * smoother; cerebellum has fine foliated ridges; brain stem is elongated.
 */
export function buildRegionGeometry(region: BrainRegion): RegionShape {
  const baseRadius = sizeFor(region);
  const profile = profileFor(region);

  let geom: THREE.BufferGeometry;

  if (region.id === 'brain_stem') {
    // Capsule for the brain stem — long, narrow, smooth.
    geom = new THREE.CapsuleGeometry(baseRadius * 0.55, baseRadius * 1.6, 6, 16);
  } else if (region.group === 'workspace' && region.id === 'workspace') {
    // Workspace is a network "cloud", not tissue — keep it as a loose icosahedron.
    geom = new THREE.IcosahedronGeometry(baseRadius, 2);
  } else {
    // Default: high-res icosahedron, will be displaced.
    geom = new THREE.IcosahedronGeometry(baseRadius, profile.detail);
  }

  // Slight ellipsoidal squish so it doesn't read as a sphere even before displacement.
  squish(geom, profile.squish);

  // Apply noise displacement to give it brain-tissue texture.
  displaceWithNoise(geom, profile.freq, profile.amp, region.id);

  // Smooth normals after displacement for proper lighting.
  geom.computeVertexNormals();

  return { geometry: geom, scale: baseRadius };
}

function sizeFor(r: BrainRegion): number {
  if (r.id === 'workspace') return 0.85;
  if (r.id === 'brain_stem') return 0.55;
  if (r.id === 'cerebellum') return 1.05;
  if (r.id === 'pfc') return 1.1;
  if (r.id === 'visual') return 1.0;        // VLM is big
  if (r.vramGb >= 3) return 0.7;
  if (r.vramGb > 0) return 0.55;
  return 0.45;
}

interface Profile {
  detail: number;        // icosahedron subdivision level
  freq: number;          // noise frequency — higher = finer folds
  amp: number;           // displacement amplitude
  squish: [number, number, number];   // ellipsoidal scale
}

function profileFor(r: BrainRegion): Profile {
  // Cerebellum — fine, dense ridges
  if (r.id === 'cerebellum' || r.id === 'cerebellum_skill') {
    return { detail: 5, freq: 4.2, amp: 0.12, squish: [1.2, 0.7, 1.0] };
  }
  // Brain stem — minimal displacement, already elongated
  if (r.id === 'brain_stem') {
    return { detail: 0, freq: 1.0, amp: 0.04, squish: [1.0, 1.0, 1.0] };
  }
  // Big cortical lobes (PFC, ATL, Visual cortex) — pronounced gyri
  if (['pfc', 'atl', 'visual', 'auditory', 'wernicke', 'broca', 'motor_voice', 'sma'].includes(r.id)) {
    return { detail: 5, freq: 2.6, amp: 0.18, squish: ellipsoid(r.id) };
  }
  // Salience / monitor regions — moderate folds
  if (r.group === 'salience') {
    return { detail: 4, freq: 2.2, amp: 0.13, squish: [1.1, 0.9, 1.0] };
  }
  // Subcortical structures — smooth, slightly bumpy
  if (r.group === 'subcortical' || r.group === 'memory') {
    return { detail: 4, freq: 1.6, amp: 0.08, squish: [1.0, 0.85, 1.1] };
  }
  // Workspace cloud — loose icosahedron
  return { detail: 2, freq: 1.5, amp: 0.05, squish: [1.0, 1.0, 1.0] };
}

function ellipsoid(id: string): [number, number, number] {
  // Roughly mimic anatomical aspect ratios
  switch (id) {
    case 'pfc': return [1.15, 0.95, 1.1];
    case 'atl': return [1.0, 0.85, 1.25];
    case 'visual': return [1.2, 0.9, 0.9];
    case 'auditory': return [0.9, 0.85, 1.1];
    case 'broca': return [0.95, 1.0, 1.0];
    case 'wernicke': return [0.95, 0.9, 1.1];
    case 'motor_voice': return [1.3, 0.7, 1.0];
    case 'sma': return [1.1, 0.85, 1.0];
    default: return [1, 1, 1];
  }
}

function squish(geom: THREE.BufferGeometry, [sx, sy, sz]: [number, number, number]) {
  const pos = geom.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    pos.setXYZ(i, pos.getX(i) * sx, pos.getY(i) * sy, pos.getZ(i) * sz);
  }
  pos.needsUpdate = true;
}

/** Ridged noise: turns soft bumps into sharp ridges (sulci between gyri). */
function ridged(x: number, y: number, z: number): number {
  return 1 - Math.abs(noise(x, y, z));
}

function displaceWithNoise(
  geom: THREE.BufferGeometry,
  freq: number,
  amp: number,
  seedKey: string,
  anisoZ = 1.7,    // stretch noise along Z so ridges are elongated front-to-back
) {
  const pos = geom.attributes.position;
  const v = new THREE.Vector3();
  // Per-region offset so each region has its own noise field
  const seed = hashString(seedKey);
  const ox = (seed % 100) * 0.7;
  const oy = ((seed / 7) % 100) * 0.7;
  const oz = ((seed / 13) % 100) * 0.7;

  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    // Anisotropic ridged noise — elongates ridges along Z (gyri-like)
    const x = v.x * freq + ox;
    const y = v.y * freq + oy;
    const z = (v.z * freq) / anisoZ + oz;
    const r1 = ridged(x, y, z);
    const r2 = ridged(x * 2.3, y * 2.3, z * 2.3) * 0.5;
    const r3 = ridged(x * 4.5, y * 4.5, z * 4.5) * 0.2;
    // Centre around 0 so ridges go both in/out
    const ridges = (r1 + r2 + r3) / 1.7 - 0.5;
    // Push along outward direction (vertex position normalized)
    const len = v.length() || 1;
    const factor = 1 + ridges * amp * 2.0;
    v.setLength(len * factor);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  pos.needsUpdate = true;
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// ─────────────────────────────────────────────────────────────────────
// Cortex mesh adapter + Voronoi partition into per-region slices
// ─────────────────────────────────────────────────────────────────────

/**
 * Take a loaded MRI cortex mesh (in MRI patient coords, mm) and return a
 * fresh BufferGeometry recentred + rescaled + reoriented to the simulator
 * scene frame.
 *   scene: +X right, +Y dorsal, +Z anterior
 *   MRI:   +X right, +Y anterior, +Z superior
 */
export function adaptCortex(
  src: THREE.BufferGeometry,
  targetLongest = 11,
): THREE.BufferGeometry {
  const geom = src.clone();
  geom.computeBoundingBox();
  const bb = geom.boundingBox!;
  const center = new THREE.Vector3();
  bb.getCenter(center);
  const size = new THREE.Vector3();
  bb.getSize(size);
  const longest = Math.max(size.x, size.y, size.z);
  const scale = targetLongest / longest;

  const pos = geom.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    v.sub(center);
    v.multiplyScalar(scale);
    // MRI Z (superior) → scene Y (dorsal); MRI Y (anterior) → scene Z (anterior)
    const sx = v.x;
    const sy = v.z;
    const sz = v.y;
    pos.setXYZ(i, sx, sy, sz);
  }
  pos.needsUpdate = true;
  if (geom.getAttribute('uv')) geom.deleteAttribute('uv');
  geom.computeVertexNormals();
  geom.computeBoundingSphere();
  return geom;
}

export interface PartitionedSlice {
  geometry: THREE.BufferGeometry;   // centered around origin (vertices are local)
  centroid: THREE.Vector3;          // world position of slice (move mesh here)
  scale: number;                    // bounding-sphere radius (label offset, glow size)
}

/**
 * Voronoi-partition a mesh into per-region sub-meshes by closest-centroid.
 * Each output slice is recentered so vertices are in local coords; mesh
 * position should be set to the slice's centroid.
 *
 * Used to split the loaded cortex mesh into the 10 cortical regions, and
 * (separately) to split a procedural cerebellum mesh in two.
 */
export function partitionMeshByCenters(
  src: THREE.BufferGeometry,
  centers: Array<{ id: string; position: [number, number, number] }>,
): Map<string, PartitionedSlice> {
  if (centers.length === 0) return new Map();

  const pos = src.attributes.position;
  const idx = src.index;
  const triCount = idx ? idx.count / 3 : pos.count / 3;

  const buckets = new Map<string, number[]>();
  for (const c of centers) buckets.set(c.id, []);

  const v0 = new THREE.Vector3();
  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();

  for (let t = 0; t < triCount; t++) {
    const a = idx ? idx.getX(t * 3) : t * 3;
    const b = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
    const c = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
    v0.fromBufferAttribute(pos, a);
    v1.fromBufferAttribute(pos, b);
    v2.fromBufferAttribute(pos, c);

    const cx = (v0.x + v1.x + v2.x) / 3;
    const cy = (v0.y + v1.y + v2.y) / 3;
    const cz = (v0.z + v1.z + v2.z) / 3;

    let bestId = centers[0].id;
    let bestD = Infinity;
    for (const ctr of centers) {
      const dx = cx - ctr.position[0];
      const dy = cy - ctr.position[1];
      const dz = cz - ctr.position[2];
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestD) {
        bestD = d;
        bestId = ctr.id;
      }
    }

    const arr = buckets.get(bestId)!;
    arr.push(v0.x, v0.y, v0.z, v1.x, v1.y, v1.z, v2.x, v2.y, v2.z);
  }

  const out = new Map<string, PartitionedSlice>();
  for (const [id, verts] of buckets) {
    if (verts.length === 0) continue;

    // Compute centroid of this slice's vertices
    let cx = 0, cy = 0, cz = 0;
    const n = verts.length / 3;
    for (let i = 0; i < verts.length; i += 3) {
      cx += verts[i];
      cy += verts[i + 1];
      cz += verts[i + 2];
    }
    cx /= n;
    cy /= n;
    cz /= n;

    // Recenter and compute bounding-sphere radius
    let maxR = 0;
    for (let i = 0; i < verts.length; i += 3) {
      verts[i] -= cx;
      verts[i + 1] -= cy;
      verts[i + 2] -= cz;
      const r = Math.hypot(verts[i], verts[i + 1], verts[i + 2]);
      if (r > maxR) maxR = r;
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    g.computeVertexNormals();
    g.computeBoundingSphere();

    out.set(id, {
      geometry: g,
      centroid: new THREE.Vector3(cx, cy, cz),
      scale: maxR,
    });
  }
  return out;
}

/** Region IDs whose anatomy is on the cortical surface (partitioned from cortex.glb). */
export const CORTICAL_IDS: ReadonlySet<string> = new Set([
  'pfc', 'sma', 'broca',
  'visual', 'auditory', 'wernicke',
  'motor_voice', 'atl',
  'insula', 'acc',
]);

/** Region IDs that share the procedural cerebellum mesh (partitioned in half). */
export const CEREBELLAR_IDS: ReadonlySet<string> = new Set([
  'cerebellum', 'cerebellum_skill',
]);

/** Build a single procedural cerebellum mesh that spans both halves, ready
 *  to be Voronoi-partitioned by `cerebellum` and `cerebellum_skill` centers. */
export function buildCerebellumMesh(): THREE.BufferGeometry {
  const geom = new THREE.IcosahedronGeometry(1, 5);
  const pos = geom.attributes.position;
  const v = new THREE.Vector3();
  // Stretch laterally; tucked under the back of the brain
  const SX = 2.4;
  const SY = 1.2;
  const SZ = 1.6;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    v.x *= SX;
    v.y *= SY;
    v.z *= SZ;
    // Foliated horizontal ridges
    const dir = v.clone().normalize();
    const r1 = 1 - Math.abs(noise(v.x * 1.6, v.y * 1.6 * 2, v.z * 1.6));
    const r2 = (1 - Math.abs(noise(v.x * 3.5, v.y * 7, v.z * 3.5))) * 0.4;
    const ridges = (r1 + r2) / 1.4 - 0.5;
    v.addScaledVector(dir, ridges * 0.2);
    // Anatomical position (under the back of cerebrum)
    v.y -= 2.0;
    v.z -= 4.0;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  pos.needsUpdate = true;
  if (geom.getAttribute('uv')) geom.deleteAttribute('uv');
  geom.computeVertexNormals();
  return geom;
}
