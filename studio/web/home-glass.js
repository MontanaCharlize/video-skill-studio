import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const MODEL_URL = 'https://motionsites.org/assets/prompt-media/fa96096e78c8153a70d2.glb';
const fullscreenVertex = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;
const glassVertex = `
  varying vec3 vNormal;
  varying vec3 vEye;
  void main() {
    vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vEye = normalize(viewPosition.xyz);
    gl_Position = projectionMatrix * viewPosition;
  }
`;
const glassFragment = `
  uniform sampler2D uTexture;
  uniform vec2 uResolution;
  uniform float uBackside;
  varying vec3 vNormal;
  varying vec3 vEye;

  float refraction(vec2 uv, vec3 eye, vec3 n, float ior, float spread) {
    vec2 offset = refract(eye, n, 1.0 / ior).xy * spread;
    offset.x *= uResolution.y / uResolution.x;
    return texture2D(uTexture, clamp(uv + offset, 0.001, 0.999)).r;
  }

  void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;
    vec3 n = normalize(vNormal) * (1.0 - 2.0 * uBackside);
    vec3 eye = normalize(vEye);
    float power = mix(0.32, 0.23, uBackside);
    float glass = 0.0;
    for (int i = 0; i < 4; i++) {
      float spread = power + float(i) * 0.012;
      glass += refraction(uv, eye, n, 1.15, spread) * 0.09;
      glass += refraction(uv, eye, n, 1.18, spread) * 0.10;
      glass += refraction(uv, eye, n, 1.23, spread) * 0.06;
    }
    vec3 lightA = normalize(vec3(-1.0, 1.0, 1.0));
    vec3 lightB = normalize(vec3(1.0, -0.65, 0.7));
    float soft = max(0.0, dot(n, lightA)) * 0.038;
    float spec = pow(max(0.0, dot(n, normalize(lightA - eye))), 68.0) * 0.34;
    spec += pow(max(0.0, dot(n, normalize(lightB - eye))), 34.0) * 0.22;
    float edge = pow(clamp(1.0 + dot(eye, n), 0.0, 1.0), 4.0);
    float tone = glass * mix(0.74, 0.46, uBackside) + 0.005 + soft + spec;
    tone = mix(tone, 0.95, edge * mix(0.63, 0.38, uBackside));
    gl_FragColor = vec4(vec3(tone), 1.0);
    #include <colorspace_fragment>
  }
`;

function extractGeometry(gltf) {
  const parts = [];
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse(mesh => {
    if (!mesh.isMesh) return;
    const source = mesh.geometry.clone();
    for (const name of Object.keys(source.attributes)) {
      if (name !== 'position') source.deleteAttribute(name);
    }
    source.applyMatrix4(mesh.matrixWorld);
    const welded = mergeVertices(source, 1e-4);
    source.dispose();
    welded.computeVertexNormals();
    parts.push(welded);
  });
  if (!parts.length) return null;
  const merged = parts.length === 1 ? parts[0] : mergeGeometries(parts);
  for (const part of parts) if (part !== merged) part.dispose();
  if (!merged) return null;
  merged.computeBoundingBox();
  const size = merged.boundingBox.getSize(new THREE.Vector3());
  const extent = Math.max(size.x, size.y, size.z);
  if (!Number.isFinite(extent) || extent === 0) {
    merged.dispose();
    return null;
  }
  merged.center();
  merged.scale(1 / extent, 1 / extent, 1 / extent);
  return merged;
}

export function createGlass(canvas, background, reduced, wake) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setClearColor(0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const camera = new THREE.PerspectiveCamera(30, 1, .1, 100);
  camera.position.z = 10;
  const scene = new THREE.Scene();
  const pivot = new THREE.Group();
  const spinner = new THREE.Group();
  spinner.rotation.set(-.42, .62, .18);
  scene.add(pivot);
  pivot.add(spinner);

  function headlineTexture() {
    const texture = new THREE.CanvasTexture(background);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    return texture;
  }
  let texture = headlineTexture();
  let textureWidth = background.width;
  let textureHeight = background.height;
  const bgScene = new THREE.Scene();
  const bg = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
    uniforms: { uTexture: { value: texture } },
    vertexShader: fullscreenVertex,
    fragmentShader: `
      uniform sampler2D uTexture;
      varying vec2 vUv;
      void main() {
        vec3 ink = texture2D(uTexture, vUv).rgb;
        gl_FragColor = vec4(vec3(dot(ink, vec3(0.2126, 0.7152, 0.0722))), 1.0);
        #include <colorspace_fragment>
      }
    `,
    depthTest: false,
    depthWrite: false
  }));
  bg.frustumCulled = false;
  bgScene.add(bg);

  const backTarget = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false });
  const frontTarget = new THREE.WebGLRenderTarget(1, 1);
  const resolution = new THREE.Vector2();
  const material = (target, back) => new THREE.ShaderMaterial({
    uniforms: { uTexture: { value: target.texture }, uResolution: { value: resolution }, uBackside: { value: Number(back) } },
    vertexShader: glassVertex,
    fragmentShader: glassFragment,
    side: back ? THREE.BackSide : THREE.FrontSide
  });
  const front = material(frontTarget, false);
  const back = material(backTarget, true);
  const box = new THREE.Mesh(new RoundedBoxGeometry(1, 1, 1, 8, .12), front);
  spinner.add(box);
  canvas.dataset.geometry = 'rounded-box';

  new GLTFLoader().load(MODEL_URL, gltf => {
    const geometry = extractGeometry(gltf);
    if (!geometry) return;
    box.geometry.dispose();
    box.geometry = geometry;
    canvas.dataset.geometry = 'reference-model';
    wake();
  }, undefined, () => {});

  let pointer;
  let angle = 0;
  let velocityX = 0;
  let velocityY = 0;
  let released = performance.now();
  const xAxis = new THREE.Vector3(1, 0, 0);
  const yAxis = new THREE.Vector3(0, 1, 0);
  const quaternion = new THREE.Quaternion();
  function rotate(x, y) {
    spinner.quaternion.premultiply(quaternion.setFromAxisAngle(yAxis, x));
    spinner.quaternion.premultiply(quaternion.setFromAxisAngle(xAxis, y));
  }

  canvas.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0) return;
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, time: event.timeStamp };
    angle = velocityX = velocityY = 0;
    canvas.setPointerCapture(event.pointerId);
    canvas.classList.add('is-dragging');
  });
  canvas.addEventListener('pointermove', event => {
    if (pointer?.id !== event.pointerId) return;
    const dx = (event.clientX - pointer.x) * .008;
    const dy = (event.clientY - pointer.y) * .008;
    const rate = Math.min(1, 16.67 / Math.max(1, event.timeStamp - pointer.time));
    velocityX = dx * rate;
    velocityY = dy * rate;
    rotate(dx, dy);
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, time: event.timeStamp };
    wake();
  });
  function stopDrag(event) {
    if (pointer?.id !== event.pointerId) return;
    if (event.timeStamp - pointer.time > 75 || event.type === 'pointercancel') velocityX = velocityY = 0;
    pointer = undefined;
    released = performance.now();
    canvas.classList.remove('is-dragging');
  }
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(name, stopDrag);

  function turn(direction) {
    angle = direction * Math.PI / 2;
    velocityX = velocityY = 0;
    released = performance.now();
    if (reduced.matches) {
      rotate(angle, 0);
      angle = 0;
    }
    wake();
  }
  canvas.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    turn(event.key === 'ArrowLeft' ? -1 : 1);
  });
  canvas.addEventListener('webglcontextlost', event => {
    event.preventDefault();
    canvas.hidden = true;
  });
  canvas.addEventListener('webglcontextrestored', () => {
    canvas.hidden = false;
    texture.needsUpdate = true;
    wake();
  });

  return {
    turn,
    refreshType() { texture.needsUpdate = true; },
    layout(width, height, ratio) {
      if (textureWidth !== background.width || textureHeight !== background.height) {
        texture.dispose();
        texture = headlineTexture();
        textureWidth = background.width;
        textureHeight = background.height;
        bg.material.uniforms.uTexture.value = texture;
      }
      const compact = width < 740 || width < height;
      renderer.setPixelRatio(ratio);
      renderer.setSize(width, height, false);
      renderer.getDrawingBufferSize(resolution);
      backTarget.setSize(resolution.x, resolution.y);
      frontTarget.setSize(resolution.x, resolution.y);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      const visibleHeight = 2 * Math.tan(Math.PI / 12) * 10;
      const edge = Math.min(height * .45, width * (compact ? .46 : .29));
      pivot.scale.setScalar(edge / height * visibleHeight);
      pivot.position.set(visibleHeight * camera.aspect * .012, visibleHeight * .028, 0);
      texture.needsUpdate = true;
    },
    render(dt, now, changing) {
      if (canvas.hidden) return;
      if (!pointer && !reduced.matches) {
        const frames = dt * 60;
        const step = angle * Math.min(1, .085 * frames);
        angle = Math.abs(angle - step) < .0005 ? 0 : angle - step;
        const idle = Math.min(1, Math.max(0, (now - released - 600) / 1000));
        rotate(step + (velocityX + .0029 * idle) * frames, (velocityY + .0009 * idle) * frames);
        velocityX *= .94 ** frames;
        velocityY *= .94 ** frames;
      }
      if (changing) texture.needsUpdate = true;

      renderer.autoClear = true;
      renderer.setRenderTarget(backTarget);
      renderer.render(bgScene, camera);
      renderer.setRenderTarget(frontTarget);
      renderer.render(bgScene, camera);
      renderer.autoClear = false;
      box.material = back;
      renderer.render(scene, camera);

      renderer.setRenderTarget(null);
      renderer.autoClear = true;
      renderer.render(bgScene, camera);
      renderer.autoClear = false;
      renderer.clearDepth();
      box.material = front;
      renderer.render(scene, camera);
    }
  };
}
