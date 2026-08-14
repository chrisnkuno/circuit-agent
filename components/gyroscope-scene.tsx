"use client";

import { useEffect, useRef } from "react";

/* The Gyroscope Core — the Circuit-Nova landing background.
   A dark, perfectly balanced AI nucleus held in slowly precessing blue and
   cyan rings, floating in deep fog under a pale moon. The craft is the same
   as Kage's: near-black night, one glowing source, layered mist, a restrained
   slow camera. No scattered star dust or ember rain — the sky stays empty so
   the engine is the only light. The subject is deliberately different — no
   temple, no circuit city, just the engine, balanced on a needle.

   THREE is loaded from the local r149 build (/three.min.js) and typed through
   the window.THREE interface below so no npm dependency is needed. The scene
   stays behind the content plane and never intercepts pointer events.
   prefers-reduced-motion renders a single static frame.

   NOTE: do not declare another `interface Window { THREE?: ... }` anywhere else
   in this app — ambient interface declarations merge, and a duplicate would
   silently break typechecking across files (that is why the old circuit-city
   scene had to be removed alongside this file). */

type Vec2Like = { x: number; y: number };
type Vec3Like = { x: number; y: number; z: number };
type ColorLike = {
  setHex: (hex: number) => void;
  getHex: () => number;
  copy: (c: ColorLike) => void;
  lerp: (c: ColorLike, t: number) => void;
};
type Matrix4Like = {
  makeTranslation: (x: number, y: number, z: number) => Matrix4Like;
};
type MaterialLike = {
  color: ColorLike;
  opacity: number;
  transparent: boolean;
  dispose: () => void;
} & Record<string, unknown>;
type Object3DLike = {
  position: { set: (x: number, y: number, z: number) => void; x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number };
  scale: { set: (x: number, y: number, z: number) => void };
  visible: boolean;
  geometry?: { dispose: () => void };
  material: MaterialLike;
};
type SceneLike = {
  add: (o: unknown) => void;
  remove: (o: unknown) => void;
  traverse: (c: (o: { geometry?: { dispose: () => void }; material?: { dispose: () => void } | { dispose: () => void }[] }) => void) => void;
  fog: unknown;
};
type CameraLike = {
  position: { set: (x: number, y: number, z: number) => void };
  lookAt: (x: number, y: number, z: number) => void;
  aspect: number;
  updateProjectionMatrix: () => void;
};
type BufferGeometryLike = {
  setAttribute: (name: string, value: unknown) => void;
  attributes: Record<string, { array: Float32Array; needsUpdate: boolean }>;
  dispose: () => void;
};
type InstancedMeshLike = {
  setMatrixAt: (i: number, m: Matrix4Like) => void;
  setColorAt: (i: number, c: ColorLike) => void;
  count: number;
  instanceMatrix: { needsUpdate: boolean };
  instanceColor: { needsUpdate: boolean } | null;
  position: { x: number; y: number; z: number };
  material: MaterialLike;
  visible: boolean;
};
type RaycastHit = { instanceId?: number; point: Vec3Like; object: any; distance: number };
type RaycasterLike = {
  setFromCamera: (coords: Vec2Like, camera: unknown) => void;
  intersectObject: (object: unknown, recursive: boolean) => RaycastHit[];
};

declare global {
  interface Window {
    THREE?: Record<string, unknown> & {
      WebGLRenderer: new (options: Record<string, unknown>) => {
        setPixelRatio: (r: number) => void;
        setClearColor: (c: number, a: number) => void;
        setSize: (w: number, h: number, u: boolean) => void;
        render: (s: unknown, c: unknown) => void;
        dispose: () => void;
      };
      Scene: new () => SceneLike;
      Clock: new () => { getElapsedTime: () => number };
      PerspectiveCamera: new (fov: number, aspect: number, near: number, far: number) => CameraLike;
      Group: new () => Object3DLike & { add: (o: unknown, ...others: unknown[]) => void };
      Mesh: new (geometry: unknown, material: unknown) => Object3DLike;
      Sprite: new (material: unknown) => Object3DLike;
      LineSegments: new (geometry: BufferGeometryLike, material: unknown) => Object3DLike & { material: MaterialLike };
      InstancedMesh: new (geometry: unknown, material: unknown, count: number) => InstancedMeshLike;
      Raycaster: new () => RaycasterLike;
      SphereGeometry: new (r: number, ws: number, hs: number) => { dispose: () => void };
      TorusGeometry: new (r: number, tube: number, rs: number, ts: number) => { dispose: () => void };
      RingGeometry: new (inner: number, outer: number, seg: number) => { dispose: () => void };
      CircleGeometry: new (r: number, s: number) => { dispose: () => void };
      BufferGeometry: new () => BufferGeometryLike;
      Float32BufferAttribute: new (a: Float32Array, n: number) => unknown;
      MeshBasicMaterial: new (o: Record<string, unknown>) => MaterialLike;
      SpriteMaterial: new (o: Record<string, unknown>) => MaterialLike;
      LineBasicMaterial: new (o: Record<string, unknown>) => MaterialLike;
      CanvasTexture: new (c: HTMLCanvasElement) => { colorSpace: string; dispose: () => void };
      Vector2: new (x?: number, y?: number) => Vec2Like;
      Color: new (hex?: number) => ColorLike;
      Matrix4: new () => Matrix4Like;
      AdditiveBlending: number;
      SRGBColorSpace: string;
    };
  }
}

/** Soft radial glow / mist blob texture, generated once per color. */
function makeGlowTexture(THREE: NonNullable<Window["THREE"]>, rgb: [number, number, number], peak = 0.55): { colorSpace: string; dispose: () => void } {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const context = canvas.getContext("2d");
  if (context) {
    const gradient = context.createRadialGradient(128, 128, 0, 128, 128, 128);
    gradient.addColorStop(0, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${peak})`);
    gradient.addColorStop(0.35, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${peak * 0.3})`);
    gradient.addColorStop(1, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0)`);
    context.fillStyle = gradient;
    context.fillRect(0, 0, 256, 256);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/* ----------------------------------------------------------- scene state */
type RingGroup = {
  group: Object3DLike & { add: (o: unknown) => void };
  mesh: Object3DLike; // the visible torus — the raycast target
  baseTilt: number;
  wobbleAmp: number;
  wobbleFreq: number;
  wobblePhase: number;
  spin: number; // own counter-rotation speed (rad/s)
};
type PacketWorld = {
  mesh: InstancedMeshLike;
  radius: number;
  angles: number[];
  speeds: number[];
  colors: number[];
  phase: number;
};
type Wave = { mesh: Object3DLike; material: MaterialLike; t: number; duration: number; base: number };

const BLUE = 0x4f9dff;   /* primary — electric azure */
const CYAN = 0x4fd8ff;   /* secondary — cyan-azure */
const BONE_DIM = 0x9aa5a0;
const CORE_DARK = 0x0d1420; // the unlit shell of the nucleus
const CORE_POS = { x: 0, y: 0, z: -14 };

function buildGyroscopeScene(THREE: NonNullable<Window["THREE"]>, canvas: HTMLCanvasElement): () => void {
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let raf = 0;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.35));
  renderer.setClearColor(0x05070a, 1);

  const scene = new THREE.Scene();

  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 400);
  const TARGET = { x: 0, y: 0.35, z: CORE_POS.z };

  const rand = (a: number, b: number): number => a + Math.random() * (b - a);
  const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
  const easeOut = (t: number): number => 1 - (1 - t) * (1 - t);

  const disposables: Array<{ dispose: () => void }> = [];
  const disposeAll = (): void => {
    for (const entry of disposables) {
      try {
        entry.dispose();
      } catch {
        /* noop */
      }
    }
    disposables.length = 0;
  };

  /* ------------------------------------------------------------ the moon
     A pale bone-white disc far up-right — the one still light in the sky,
     Kage's vermilion moon re-lit for the machine. */
  const moon = new THREE.Mesh(
    new THREE.CircleGeometry(4.6, 64),
    new THREE.MeshBasicMaterial({ color: 0xe4ebe4, transparent: true, opacity: 0.92, fog: false }),
  );
  moon.position.set(11.5, 7.5, -46);
  scene.add(moon);

  const moonGlowTexture = makeGlowTexture(THREE, [222, 232, 224], 0.5);
  const moonGlow = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: moonGlowTexture, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }),
  );
  moonGlow.scale.set(32, 32, 1);
  moonGlow.position.set(11.5, 7.5, -46);
  scene.add(moonGlow);

  /* ------------------------------------------------------- layered mist
     Four wide blue-charcoal blobs at different depths — the scene's depth. */
  const mistTexture = makeGlowTexture(THREE, [14, 24, 36], 0.5);
  const mist = [
    { x: -7, y: 2.4, z: -32, w: 96, h: 52, o: 0.15, sx: 0.018, sy: 0.011 },
    { x: 11, y: -2.5, z: -26, w: 74, h: 44, o: 0.12, sx: -0.014, sy: 0.008 },
    { x: -14, y: 3.6, z: -6, w: 118, h: 64, o: 0.1, sx: 0.011, sy: -0.007 },
    { x: 9, y: -6.5, z: -2, w: 126, h: 58, o: 0.13, sx: -0.009, sy: 0.01 },
  ].map((m) => {
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: mistTexture, transparent: true, opacity: m.o, depthWrite: false, fog: false }),
    );
    sprite.scale.set(m.w, m.h, 1);
    sprite.position.set(m.x, m.y, m.z);
    scene.add(sprite);
    return { sprite, ...m };
  });
  disposables.push(mistTexture);

  /* ------------------------------------------------------ the gyroscope
     The engine: a dark nucleus on a faint vertical needle, held in four
     counter-rotating rings that slowly precess. */
  const gyro = new THREE.Group();
  gyro.position.set(CORE_POS.x, CORE_POS.y, CORE_POS.z);
  scene.add(gyro);

  /* the core — near-black, warm, lit only by what surrounds it */
  const core = new THREE.Mesh(new THREE.SphereGeometry(1.15, 48, 32), new THREE.MeshBasicMaterial({ color: 0x0d1420, fog: false }));
  gyro.add(core);

  /* the heart — a tiny cyan spark that breathes inside the dark shell */
  const heart = new THREE.Mesh(new THREE.SphereGeometry(0.36, 32, 24), new THREE.MeshBasicMaterial({ color: CYAN, fog: false }));
  gyro.add(heart);

  /* the needle — a faint spindle with two bright caps, the balance point */
  const spindleGeometry = new THREE.BufferGeometry();
  spindleGeometry.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array([0, -4.9, 0, 0, 4.9, 0]), 3));
  const spindle = new THREE.LineSegments(
    spindleGeometry,
    new THREE.LineBasicMaterial({ color: BONE_DIM, transparent: true, opacity: 0.34, depthWrite: false, fog: false }),
  );
  gyro.add(spindle);
  disposables.push(spindleGeometry);

  const capGeometry = new THREE.SphereGeometry(0.075, 16, 12);
  const capMaterial = new THREE.MeshBasicMaterial({ color: BLUE, fog: false });
  const capTop = new THREE.Mesh(capGeometry, capMaterial);
  capTop.position.set(0, 4.9, 0);
  const capBottom = new THREE.Mesh(capGeometry, capMaterial);
  capBottom.position.set(0, -4.9, 0);
  gyro.add(capTop, capBottom);
  disposables.push(capGeometry, capMaterial);

  /* backlight — a soft blue halo behind the whole assembly */
  const haloTexture = makeGlowTexture(THREE, [79, 157, 255], 0.42);
  const halo = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: haloTexture, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }),
  );
  halo.scale.set(30, 30, 1);
  halo.position.set(CORE_POS.x, CORE_POS.y, CORE_POS.z);
  scene.add(halo);

  /* pool of cyan light the engine floats on */
  const poolTexture = makeGlowTexture(THREE, [79, 216, 255], 0.5);
  const pool = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: poolTexture, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }),
  );
  pool.scale.set(17, 9, 1);
  pool.position.set(CORE_POS.x, CORE_POS.y - 2.6, CORE_POS.z);
  scene.add(pool);
  disposables.push(haloTexture, poolTexture);

  /* the rings — four thin toruses, each on its own tilted frame */
  const ringMaterial = (color: number, opacity: number): MaterialLike =>
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });

  const makeRing = (radius: number, tube: number, color: number, opacity: number): RingGroup => {
    const group = new THREE.Group() as Object3DLike & { add: (o: unknown) => void };
    const ring = new THREE.Mesh(new THREE.TorusGeometry(radius, tube, 8, 160), ringMaterial(color, opacity));
    group.add(ring);
    gyro.add(group);
    disposables.push(ring.geometry!, ring.material);
    return { group, mesh: ring, baseTilt: 0, wobbleAmp: 0, wobbleFreq: 0, wobblePhase: 0, spin: 0 };
  };

  const ringA = makeRing(2.35, 0.028, BLUE, 0.85);
  ringA.baseTilt = 1.15;
  ringA.spin = 0.34;
  ringA.wobbleFreq = 0.11;
  ringA.wobbleAmp = 0.05;

  const ringB = makeRing(3.2, 0.02, CYAN, 0.65);
  ringB.baseTilt = -0.95;
  ringB.spin = -0.24;
  ringB.wobbleFreq = 0.08;
  ringB.wobbleAmp = 0.07;

  const ringC = makeRing(4.15, 0.016, BONE_DIM, 0.4);
  ringC.baseTilt = 1.45;
  ringC.spin = 0.12;
  ringC.wobbleFreq = 0.13;
  ringC.wobbleAmp = 0.04;

  const ringD = makeRing(5.3, 0.011, BONE_DIM, 0.2);
  ringD.baseTilt = 1.52;
  ringD.spin = 0.05;
  ringD.wobbleFreq = 0.05;
  ringD.wobbleAmp = 0.03;
  ringD.wobblePhase = 1.7;

  /* data packets — small bright points that ride the rings like signals */
  const packetGeometry = new THREE.SphereGeometry(0.085, 12, 10);
  const scratchColor = new THREE.Color();
  const scratchWhite = new THREE.Color(0xffffff);
  const scratchBlue = new THREE.Color(BLUE);
  const scratchCoreDark = new THREE.Color(CORE_DARK);
  const scratchCyan = new THREE.Color(CYAN);
  const matrixTranslation = new THREE.Matrix4();

  const makePackets = (host: RingGroup, radius: number, count: number, color: number, speedBase: number): PacketWorld => {
    const mesh = new THREE.InstancedMesh(packetGeometry, new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false }), count);
    host.group.add(mesh);
    disposables.push(packetGeometry, mesh.material);
    const angles = Array.from({ length: count }, () => Math.random() * Math.PI * 2);
    const speeds = Array.from({ length: count }, () => speedBase * rand(0.6, 1.5));
    const colors = Array.from({ length: count }, () => (Math.random() < 0.5 ? color : 0xffffff));
    for (let i = 0; i < count; i++) {
      scratchColor.setHex(colors[i]);
      mesh.setColorAt(i, scratchColor);
    }
    mesh.instanceColor!.needsUpdate = true;
    return { mesh, radius, angles, speeds, colors, phase: rand(0, Math.PI * 2) };
  };

  const bluePackets = makePackets(ringA, 2.35, 6, BLUE, 0.5);
  const cyanPackets = makePackets(ringB, 3.2, 8, CYAN, 0.42);
  const bonePackets = makePackets(ringC, 4.15, 5, BONE_DIM, 0.28);

  /* -------------------------------------------------------- interaction */
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let pointerX = 0;
  let pointerY = 0;
  let pointerNX = 0;
  let pointerNY = 0;
  let baseYaw = 0.6;
  let coreFlash = 0;
  let hoveredCore = false;
  const waves: Wave[] = [];

  /* scroll dolly — page progress drives the camera along a path that dives
     in through the rings at mid-page and emerges wide again at the foot */
  let scrollTarget = 0;
  let scrollEased = 0;
  let pageScrollable = 1;

  const isInteractiveTarget = (target: EventTarget | null): boolean => {
    if (!(target instanceof HTMLElement)) return false;
    return Boolean(target.closest("button, a, input, textarea, label, select, [role='button']"));
  };

  const onPointerMove = (event: PointerEvent): void => {
    pointerX = (event.clientX / window.innerWidth) * 2 - 1;
    pointerY = -(event.clientY / window.innerHeight) * 2 + 1;
  };

  const spawnWave = (x: number, z: number, color: number, base: number): void => {
    const geometry = new THREE.RingGeometry(0.75, 0.88, 72);
    const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, 0.06, z);
    scene.add(mesh);
    /* geometry and material are disposed inline when the wave expires below */
    waves.push({ mesh, material, t: 0, duration: rand(0.85, 1.2), base });
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || reducedMotion) return;
    if (isInteractiveTarget(event.target)) return;
    ndc.x = (event.clientX / window.innerWidth) * 2 - 1;
    ndc.y = -(event.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    const coreHit = raycaster.intersectObject(core, false)[0];
    if (coreHit) {
      spawnWave(CORE_POS.x, CORE_POS.z, BLUE, 7);
      coreFlash = 1;
      return;
    }
    /* the four rings only — the heart, caps and needle stay out of the way */
    for (const ring of [ringA, ringB, ringC, ringD]) {
      const ringHit = raycaster.intersectObject(ring.mesh, false)[0];
      if (ringHit && ringHit.point) {
        spawnWave(ringHit.point.x, ringHit.point.z, CYAN, 3.2);
        return;
      }
    }
  };

  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerdown", onPointerDown);

  /* ------------------------------------------------------------ sizing */
  function measureScroll(): void {
    /* reading scrollHeight forces a reflow — never do it while the tab is
       hidden, where the 2s refresh interval would otherwise churn layout
       for nothing */
    if (document.hidden) return;
    pageScrollable = Math.max(
      1,
      Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) - window.innerHeight,
    );
    scrollTarget = Math.min(1, Math.max(0, window.scrollY / pageScrollable));
  }

  function resize(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
    measureScroll();
  }
  resize();
  /* The scroll handler must never force a reflow: reading scrollHeight on
     every scroll event is exactly the layout thrash that makes a fixed canvas
     jank. pageScrollable is refreshed lazily instead — on resize, after the
     page finishes loading, and every two seconds — while scrolling only reads
     the cheap scrollY value against the cached measure. */
  const onScroll = (): void => {
    scrollTarget = Math.min(1, Math.max(0, window.scrollY / pageScrollable));
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", resize);
  window.addEventListener("load", measureScroll);
  const scrollMeasureTimer = window.setInterval(measureScroll, 2000);

  /* ------------------------------------------------------------- loop */
  const clock = new THREE.Clock();
  let lastTime = clock.getElapsedTime();

  function frame(): void {
    const time = clock.getElapsedTime();
    const dt = Math.min(0.05, time - lastTime);
    lastTime = time;

    /* eased pointer + slow idle orbit */
    const smooth = 1 - Math.pow(0.0001, dt);
    pointerNX += (pointerX - pointerNX) * smooth;
    pointerNY += (pointerY - pointerNY) * smooth;
    baseYaw += dt * 0.025;

    /* scroll dolly — a slow dive through the rings at mid-page, easing back
       wide at the foot; the camera circles as it travels. The eased value
       lags the raw scroll so a fast flick reads as a smooth push-in. */
    scrollEased += (scrollTarget - scrollEased) * smooth;
    const dive = Math.sin(Math.PI * scrollEased);
    const camRadius = 16.5 - 12.5 * dive; // 16.5 at the hero → 4.0 mid-page
    const scrollYaw = (scrollEased - 0.5) * 1.5; // orbit ~86° around as we go
    const camLift = 1.6 - dive * 2.2; // rise at the hero, dip through the plane

    const cyaw = baseYaw + scrollYaw + pointerNX * 0.18 * (1 - dive * 0.55);
    const cpitch = clamp(0.14 - pointerNY * 0.1, -0.1, 0.8);
    camera.position.set(
      TARGET.x + camRadius * Math.sin(cyaw) * Math.cos(cpitch),
      TARGET.y + camLift + camRadius * Math.sin(cpitch),
      TARGET.z + camRadius * Math.cos(cyaw) * Math.cos(cpitch),
    );
    camera.lookAt(TARGET.x, TARGET.y, TARGET.z);

    /* the engine breathes, faintly */
    const gyroScale = 1 + Math.sin(time * 0.5) * 0.004;
    gyro.scale.set(gyroScale, gyroScale, gyroScale);

    /* rings precess and counter-rotate on their own tilted frames */
    for (const ring of [ringA, ringB, ringC, ringD]) {
      ring.group.rotation.y = time * ring.spin;
      ring.group.rotation.x = ring.baseTilt + Math.sin(time * ring.wobbleFreq + ring.wobblePhase) * ring.wobbleAmp;
      ring.group.rotation.z = Math.sin(time * ring.wobbleFreq * 0.7 + ring.wobblePhase) * ring.wobbleAmp * 0.5;
    }

    /* the heart breathes; the core answers the pointer */
    heart.scale.set(1 + Math.sin(time * 2.4) * 0.22, 1 + Math.sin(time * 2.4) * 0.22, 1 + Math.sin(time * 2.4) * 0.22);

    ndc.x = pointerNX;
    ndc.y = pointerNY;
    raycaster.setFromCamera(ndc, camera);
    hoveredCore = Boolean(raycaster.intersectObject(core, false)[0]);

    const coreMaterial = core.material as unknown as MaterialLike;
    coreColorLerp(coreMaterial, hoveredCore ? 0.32 : 0, coreFlash);
    const coreScale = 1.06 * (hoveredCore ? 1.05 : 1) + coreFlash * 0.22;
    core.scale.set(coreScale, coreScale, coreScale);
    coreFlash = Math.max(0, coreFlash - dt * 2.4);

    /* packets ride their rings; a few pulse white as they pass */
    const ride = (world: PacketWorld): void => {
      const now = time + world.phase;
      for (let i = 0; i < world.angles.length; i++) {
        world.angles[i] += dt * world.speeds[i];
        const a = world.angles[i];
        matrixTranslation.makeTranslation(Math.cos(a) * world.radius, Math.sin(a) * world.radius, 0);
        world.mesh.setMatrixAt(i, matrixTranslation);
        const pulse = 0.5 + 0.5 * Math.sin(now * 2 + i * 1.7);
        scratchColor.setHex(world.colors[i]);
        if (pulse > 0.86) scratchColor.lerp(scratchWhite, (pulse - 0.86) * 6);
        world.mesh.setColorAt(i, scratchColor);
      }
      world.mesh.instanceMatrix.needsUpdate = true;
      world.mesh.instanceColor!.needsUpdate = true;
    };
    ride(bluePackets);
    ride(cyanPackets);
    ride(bonePackets);

    /* shockwaves — one calm ripple in the engine's plane */
    for (let i = waves.length - 1; i >= 0; i--) {
      const wave = waves[i];
      wave.t += dt / wave.duration;
      const scale = easeOut(wave.t) * wave.base;
      wave.mesh.scale.set(scale, scale, 1);
      wave.material.opacity = 0.8 * (1 - wave.t);
      if (wave.t >= 1) {
        scene.remove(wave.mesh);
        wave.mesh.geometry?.dispose();
        wave.material.dispose();
        waves.splice(i, 1);
      }
    }

    /* the moon barely breathes; the mist drifts */
    moon.scale.set(1 + Math.sin(time * 0.3) * 0.015, 1 + Math.sin(time * 0.3) * 0.015, 1);
    for (const m of mist) {
      m.sprite.position.x = m.x + Math.sin(time * m.sx * 10) * 1.4;
      m.sprite.position.y = m.y + Math.cos(time * m.sy * 10) * 0.7;
    }

    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  }

  /* --------------------------------------------------------- visibility
     Stop rendering while the tab is hidden — otherwise the loop burns GPU and
     battery for nothing. State is untouched, so it resumes exactly where it
     left off. */
  const onVisibility = (): void => {
    if (document.hidden) {
      cancelAnimationFrame(raf);
      raf = 0;
    } else if (!reducedMotion && raf === 0) {
      lastTime = clock.getElapsedTime();
      raf = requestAnimationFrame(frame);
    }
  };
  document.addEventListener("visibilitychange", onVisibility);

  /** Core color: warms toward blue while hovered, eases back to the dark
      shell otherwise, and flashes cyan when struck. No idle drift — the
      hover state has to stay meaningful. */
  function coreColorLerp(material: MaterialLike, hoverT: number, flashT: number): void {
    const current = material.color as unknown as ColorLike;
    const hex = current.getHex ? current.getHex() : CORE_DARK;
    scratchColor.setHex(hex);
    scratchColor.lerp(hoverT > 0 ? scratchBlue : scratchCoreDark, hoverT > 0 ? hoverT : 0.05);
    scratchColor.lerp(scratchCyan, flashT);
    current.copy(scratchColor);
  }

  if (reducedMotion) {
    /* the same framing the hero shows at the top of the page, one static frame */
    baseYaw = 0.9;
    camera.position.set(
      TARGET.x + 16.5 * Math.sin(0.9),
      TARGET.y + 1.6 + 16.5 * 0.14,
      TARGET.z + 16.5 * Math.cos(0.9),
    );
    camera.lookAt(TARGET.x, TARGET.y, TARGET.z);
    for (const ring of [ringA, ringB, ringC, ringD]) {
      ring.group.rotation.x = ring.baseTilt;
      ring.group.rotation.y = 0.4;
    }
    renderer.render(scene, camera);
  } else {
    raf = requestAnimationFrame(frame);
  }

  /* ----------------------------------------------------------- cleanup */
  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerdown", onPointerDown);
    window.removeEventListener("scroll", onScroll);
    window.removeEventListener("resize", resize);
    window.removeEventListener("load", measureScroll);
    window.clearInterval(scrollMeasureTimer);
    document.removeEventListener("visibilitychange", onVisibility);
    scene.traverse((object: { geometry?: { dispose: () => void }; material?: { dispose: () => void } | { dispose: () => void }[] }) => {
      if (object.geometry) object.geometry.dispose();
      const material = object.material;
      if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
      else if (material) material.dispose();
    });
    disposeAll();
    renderer.dispose();
  };
}

/** Fixed full-viewport gyroscope world, behind the content plane. */
export function GyroscopeScene() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvasEl = canvasRef.current;
    if (!canvasEl) return;

    let dispose: (() => void) | null = null;
    let started = false;

    const init = (THREE: NonNullable<Window["THREE"]>): void => {
      if (started) return; // StrictMode double-mount + duplicate script onloads must not build twice
      started = true;
      try {
        dispose = buildGyroscopeScene(THREE, canvasEl);
      } catch (error) {
        started = false;
        console.error("[gyroscope-scene] failed to start scene:", error);
      }
    };

    const probe = document.createElement("canvas").getContext("webgl") || document.createElement("canvas").getContext("experimental-webgl");
    if (!probe) {
      // No WebGL at all — the CSS backdrop still carries the mood.
    } else if (window.THREE) {
      init(window.THREE);
    } else {
      const script = document.createElement("script");
      script.src = "/three.min.js";
      script.async = true;
      script.onload = () => {
        if (window.THREE) init(window.THREE);
      };
      script.onerror = () => {
        console.warn("[gyroscope-scene] /three.min.js failed to load; showing the CSS backdrop only.");
      };
      document.head.appendChild(script);
    }

    return () => {
      dispose?.();
    };
  }, []);

  return <canvas ref={canvasRef} className="kage-scene-canvas" aria-hidden="true" />;
}
