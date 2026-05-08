import { useMemo } from 'react';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';

useGLTF.preload('/brain.glb');

export function BrainShell() {
  const { scene } = useGLTF('/brain.glb');

  const clone = useMemo(() => {
    const cloned = scene.clone(true);
    // Render back-faces only — the shell encloses the scene from outside
    // without obscuring nodes from the camera. depthWrite:true keeps depth
    // sorting clean so we don't tank the renderer.
    const mat = new THREE.MeshBasicMaterial({
      color: '#3a6a96',
      transparent: true,
      opacity: 0.22,
      side: THREE.BackSide,
    });
    cloned.traverse(obj => {
      if ((obj as THREE.Mesh).isMesh) {
        (obj as THREE.Mesh).material = mat;
        (obj as THREE.Mesh).renderOrder = -10;
      }
    });

    const bbox = new THREE.Box3().setFromObject(cloned);
    const size = bbox.getSize(new THREE.Vector3());
    const center = bbox.getCenter(new THREE.Vector3());
    const longest = Math.max(size.x, size.y, size.z) || 1;
    const s = 11 / longest;

    const wrapper = new THREE.Group();
    cloned.position.copy(center.clone().multiplyScalar(-1));
    wrapper.scale.setScalar(s);
    wrapper.add(cloned);
    return wrapper;
  }, [scene]);

  return <primitive object={clone} />;
}
