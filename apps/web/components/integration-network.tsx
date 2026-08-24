"use client";

import { useEffect, useRef } from "react";

/* The integrations backdrop — a restrained 3D workflow web behind the connector
   cards. Thin curved links run from each app card to a central hub, particles
   drift in the volume, and small data points travel the links. Hovering a card
   lights its node, its links, and the particle flow around it; the whole web
   answers the pointer with a whisper of parallax.

   THREE is the same local r149 build (/three.min.js) the gyroscope scene uses,
   typed through its ambient Window.THREE interface. NOTE: do not declare another
   `interface Window { THREE?: ... }` here — ambient declarations merge and a
   duplicate would break typechecking. This scene casts through its own local
   shape instead. */

type NetColor = { setHex: (hex: number) => void; getHex: () => number };
type NetMaterial = { color: NetColor; opacity: number; transparent: boolean; dispose: () => void };
type NetGeometry = { dispose: () => void };
type NetTexture = { dispose: () => void };
type NetObject3D = {
  position: { set: (x: number, y: number, z: number) => void; x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number };
  scale: { set: (x: number, y: number, z: number) => void };
  visible: boolean;
  geometry: NetGeometry;
  material: NetMaterial;
};
type NetGroup = NetObject3D & { add: (o: unknown) => void; remove: (o: unknown) => void };
type NetPointsObject = NetObject3D & { geometry: NetBufferGeometry };
type NetVector3 = { x: number; y: number; z: number };
type NetCurve = { getPointAt: (t: number, out?: NetVector3) => NetVector3; getPoints: (n: number) => NetVector3[] };
type NetBufferGeometry = NetGeometry & {
  setAttribute: (name: string, value: unknown) => void;
  attributes: Record<string, { array: Float32Array; needsUpdate: boolean }>;
};
type NetScene = { add: (o: unknown) => void; fog: unknown };
type NetCamera = {
  position: { set: (x: number, y: number, z: number) => void };
  lookAt: (x: number, y: number, z: number) => void;
  aspect: number;
  updateProjectionMatrix: () => void;
};
type NetRenderer = {
  setPixelRatio: (r: number) => void;
  setClearColor: (c: number, a: number) => void;
  setSize: (w: number, h: number, updateStyle: boolean) => void;
  render: (scene: unknown, camera: unknown) => void;
  dispose: () => void;
};
type NetworkThree = {
  WebGLRenderer: new (options: Record<string, unknown>) => NetRenderer;
  Scene: new () => NetScene;
  PerspectiveCamera: new (fov: number, aspect: number, near: number, far: number) => NetCamera;
  Group: new () => NetGroup;
  Mesh: new (geometry: unknown, material: unknown) => NetObject3D;
  Line: new (geometry: unknown, material: unknown) => NetObject3D;
  Points: new (geometry: unknown, material: unknown) => NetPointsObject;
  SphereGeometry: new (radius: number, w: number, h: number) => NetGeometry;
  BufferGeometry: new () => NetBufferGeometry;
  Float32BufferAttribute: new (array: Float32Array, itemSize: number) => unknown;
  MeshBasicMaterial: new (options: Record<string, unknown>) => NetMaterial;
  LineBasicMaterial: new (options: Record<string, unknown>) => NetMaterial;
  PointsMaterial: new (options: Record<string, unknown>) => NetMaterial;
  QuadraticBezierCurve3: new (a: NetVector3, control: NetVector3, b: NetVector3) => NetCurve;
  Vector3: new (x?: number, y?: number, z?: number) => NetVector3;
  Clock: new () => { getElapsedTime: () => number };
  AdditiveBlending: number;
  Sprite: new (material: unknown) => NetObject3D;
  SpriteMaterial: new (options: Record<string, unknown>) => NetMaterial;
  CanvasTexture: new (canvas: HTMLCanvasElement) => NetTexture;
};

/** Fixed full-section workflow web, behind the integration content plane. */
export function IntegrationNetwork() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const probe =
      document.createElement("canvas").getContext("webgl") ||
      document.createElement("canvas").getContext("experimental-webgl");
    if (!probe) return;

    let dispose: (() => void) | null = null;
    let started = false;

    const init = (raw: unknown): void => {
      if (started) return; // StrictMode double-mount + duplicate script onloads must not build twice
      started = true;
      try {
        dispose = buildNetworkScene(raw as NetworkThree, canvas);
      } catch (error) {
        started = false;
        console.error("[integration-network] failed to start scene:", error);
      }
    };

    if (window.THREE) {
      init(window.THREE);
    } else {
      const script = document.createElement("script");
      script.src = "/three.min.js";
      script.async = true;
      script.onload = () => {
        if (window.THREE) init(window.THREE);
      };
      script.onerror = () => {
        console.warn("[integration-network] /three.min.js failed to load; showing the static section only.");
      };
      document.head.appendChild(script);
    }

    return () => dispose?.();
  }, []);

  return <canvas ref={canvasRef} className="integration-network-canvas" aria-hidden="true" />;
}

/* ---------------------------------------------------------------- scene */

type NetNode = { mesh: NetObject3D; base: NetVector3; act: number; accent: number };
type NetLink = { mesh: NetObject3D; curve: NetCurve; a: number; b: number };
type NetPacket = { mesh: NetObject3D; curve: NetCurve; t: number; speed: number; phase: number };
type NetLabel = { sprite: NetObject3D; texture: NetTexture; base: NetVector3; phase: number; nodeIndex: number };

/* One soft accent per app, tuned dim so a hover reads as a quiet tint rather
   than a bright color pop — each card lights its node, its links, and its
   caption in its own hue. Keyed by the connector id from the card's data
   attribute; anything unknown falls back to the neutral azure. */
const CONNECTOR_ACCENTS: Record<string, number> = {
  "google-calendar": 0x6fb2ff,   // azure
  "gmail": 0xee9b8e,             // soft coral
  "google-drive": 0x84c9a2,      // sage green
  "notion": 0xccd5e6,            // cool ivory
  "todoist": 0xf2a878,           // soft ember
  "slack": 0xae97e0,             // muted violet
  "whatsapp-business": 0x74d2a3, // soft green
  "home-assistant": 0x8db6ff,    // sky blue
};

function lerpHex(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return (
    ((Math.round(ar + (br - ar) * t) << 16) |
      (Math.round(ag + (bg - ag) * t) << 8) |
      Math.round(ab + (bb - ab) * t)) >>>
    0
  );
}

function buildNetworkScene(THREE: NetworkThree, canvas: HTMLCanvasElement): () => void {
  const host = canvas.closest<HTMLElement>(".integration-section");
  if (!host) return () => {};
  const section: HTMLElement = host;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  let raf = 0;
  let running = false;
  let active = false;
  let width = 0;
  let height = 0;
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "low-power" });
  renderer.setPixelRatio(dpr);
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 1, 6000);
  const world = new THREE.Group();
  scene.add(world);

  let nodes: NetNode[] = [];
  let links: NetLink[] = [];
  let packets: NetPacket[] = [];
  let labels: NetLabel[] = [];
  let particleMesh: NetPointsObject | null = null;
  let particleBase: Float32Array | null = null;
  let particleSpeeds: Float32Array | null = null;
  let particlePhases: Float32Array | null = null;

  let hoverIndex = -1;
  let pointerTX = 0, pointerTY = 0, pointerX = 0, pointerY = 0;

  /* ------------------------------------------------------------- teardown */
  const disposeObject = (object: NetObject3D): void => {
    try { object.geometry.dispose(); } catch { /* noop */ }
    try { object.material.dispose(); } catch { /* noop */ }
  };

  function clearWorld(): void {
    for (const node of nodes) { world.remove(node.mesh); disposeObject(node.mesh); }
    for (const link of links) { world.remove(link.mesh); disposeObject(link.mesh); }
    for (const packet of packets) { world.remove(packet.mesh); disposeObject(packet.mesh); }
    for (const label of labels) {
      world.remove(label.sprite);
      try { label.sprite.material.dispose(); } catch { /* noop */ }
      try { label.texture.dispose(); } catch { /* noop */ }
    }
    if (particleMesh) { world.remove(particleMesh); disposeObject(particleMesh); }
    nodes = [];
    links = [];
    packets = [];
    labels = [];
    particleMesh = null;
    particleBase = null;
    particleSpeeds = null;
    particlePhases = null;
  }

  /* ---------------------------------------------------------------- build */
  function rebuild(): void {
    clearWorld();
    hoverIndex = -1;

    const rect = section.getBoundingClientRect();
    width = rect.width;
    height = rect.height;
    if (width < 2 || height < 2) return;

    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    const fovRad = (45 * Math.PI) / 180;
    camera.position.set(0, 0, height / 2 / Math.tan(fovRad / 2));
    camera.lookAt(0, 0, 0);

    /* map each connector card's screen centre into the z=0 plane, so a node
       sits behind its app — hover and geometry stay honest about the layout */
    const cards = Array.from(section.querySelectorAll<HTMLElement>(".connector-card"));
    const cardInfos: { base: NetVector3; label: string; halfHeight: number; accent: number }[] = [];
    let sumX = 0, sumY = 0;
    for (const card of cards) {
      const r = card.getBoundingClientRect();
      const x = r.left + r.width / 2 - (rect.left + width / 2);
      const y = -((r.top + r.height / 2) - (rect.top + height / 2));
      const z = (cardInfos.length % 2 === 0 ? 1 : -1) * 16 + (cardInfos.length % 3) * 6;
      const accent = CONNECTOR_ACCENTS[card.getAttribute("data-connector-id") ?? ""] ?? 0x9fc6ff;
      cardInfos.push({ base: { x, y, z }, label: card.querySelector("h3")?.textContent?.trim() ?? "", halfHeight: r.height / 2, accent });
      sumX += x;
      sumY += y;
    }
    const hub: NetVector3 = cardInfos.length ? { x: sumX / cardInfos.length, y: sumY / cardInfos.length, z: 0 } : { x: 0, y: 0, z: 0 };

    /* nodes — one per card, small blue-grey marbles with a little depth */
    const nodeGeometry = new THREE.SphereGeometry(3.6, 14, 10);
    const nodeMaterial = new THREE.MeshBasicMaterial({ color: 0x9fc6ff, transparent: true, opacity: 0.55, depthWrite: false });
    cardInfos.forEach((info, index) => {
      const mesh = new THREE.Mesh(nodeGeometry, nodeMaterial);
      mesh.position.set(info.base.x, info.base.y, info.base.z);
      world.add(mesh);
      nodes.push({ mesh, base: { x: info.base.x, y: info.base.y, z: info.base.z }, act: 0, accent: info.accent });
    });

    /* the hub — the workflow core the apps converge on */
    const hubMaterial = new THREE.MeshBasicMaterial({ color: 0x4f9dff, transparent: true, opacity: 0.65, depthWrite: false });
    const hubMesh = new THREE.Mesh(new THREE.SphereGeometry(4.8, 16, 12), hubMaterial);
    hubMesh.position.set(hub.x, hub.y, hub.z);
    world.add(hubMesh);
    nodes.push({ mesh: hubMesh, base: hub, act: 0, accent: 0xbfe0ff });
    const hubIndex = nodes.length - 1;

    /* labels — tiny floating app captions, one per card node. Each label is a
       white-text canvas sprite tinted azure, drawn at 2x for crispness, then
       positioned just outside the card's edge (above for cards in the upper
       half, below for the lower half) so the 3D text never hides behind the
       translucent panels. Top-row labels get the roomy intro gutter above the
       grid; bottom-row labels tuck into the slim 12px gap before the workflow
       preview so they stay clear of that panel too. */
    const labelFont = "500 9px ui-monospace, 'SF Mono', 'Fira Code', Menlo, Consolas, monospace";
    const labelPad = 12;
    const labelMeasure = document.createElement("canvas").getContext("2d");
    cardInfos.forEach((info, index) => {
      const label = info.label.toUpperCase();
      if (!label) return;
      let textWidth = Math.max(60, label.length * 7);
      if (labelMeasure) { labelMeasure.font = labelFont; textWidth = Math.max(textWidth, Math.ceil(labelMeasure.measureText(label).width)); }
      const logicalW = textWidth + labelPad * 2;
      const logicalH = 16;
      const canvas = document.createElement("canvas");
      canvas.width = logicalW * 2;
      canvas.height = logicalH * 2;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.scale(2, 2);
        ctx.font = labelFont;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "#ffffff";
        ctx.fillText(label, logicalW / 2, logicalH / 2 + 0.5);
      }
      const texture = new THREE.CanvasTexture(canvas);
      const material = new THREE.SpriteMaterial({ map: texture, color: 0x9fc6ff, transparent: true, opacity: 0.45, depthWrite: false });
      const sprite = new THREE.Sprite(material);
      const dir = info.base.y >= 0 ? 1 : -1;
      const offset = dir === 1 ? info.halfHeight + 16 : info.halfHeight + 6;
      sprite.position.set(info.base.x, info.base.y + dir * offset, info.base.z - 4);
      sprite.scale.set(logicalW, logicalH, 1);
      world.add(sprite);
      labels.push({ sprite, texture, base: { x: info.base.x, y: info.base.y + dir * offset, z: info.base.z - 4 }, phase: Math.random() * Math.PI * 2, nodeIndex: index });
    });

    /* links — thin curves: every card to the hub, plus a spine through the
       cards in DOM order so the whole thing reads as one workflow */
    const addLink = (a: number, b: number): void => {
      const va = nodes[a].base;
      const vb = nodes[b].base;
      const control = { x: (va.x + vb.x) / 2, y: (va.y + vb.y) / 2, z: Math.min(va.z, vb.z) - 30 };
      const curve = new THREE.QuadraticBezierCurve3(
        new THREE.Vector3(va.x, va.y, va.z),
        new THREE.Vector3(control.x, control.y, control.z),
        new THREE.Vector3(vb.x, vb.y, vb.z),
      );
      const points = curve.getPoints(40);
      const array = new Float32Array(points.length * 3);
      for (let i = 0; i < points.length; i++) {
        array[i * 3] = points[i].x;
        array[i * 3 + 1] = points[i].y;
        array[i * 3 + 2] = points[i].z;
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(array, 3));
      const material = new THREE.LineBasicMaterial({ color: 0x4f9dff, transparent: true, opacity: 0.22, depthWrite: false });
      const mesh = new THREE.Line(geometry, material);
      world.add(mesh);
      links.push({ mesh, curve, a, b });
    };
    for (let i = 0; i < hubIndex; i++) addLink(i, hubIndex);
    for (let i = 0; i + 1 < hubIndex; i++) addLink(i, i + 1);

    /* packets — a few data points riding the links */
    const packetGeometry = new THREE.SphereGeometry(2.2, 10, 8);
    const packetMaterial = new THREE.MeshBasicMaterial({
      color: 0xcfe4ff,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const packetCount = Math.min(16, Math.max(8, Math.round(links.length * 0.9)));
    for (let i = 0; i < packetCount && links.length > 0; i++) {
      const link = links[i % links.length];
      const mesh = new THREE.Mesh(packetGeometry, packetMaterial);
      world.add(mesh);
      packets.push({ mesh, curve: link.curve, t: Math.random(), speed: 0.045 + Math.random() * 0.06, phase: Math.random() * Math.PI * 2 });
    }

    /* particles — a sparse cloud drifting through the whole volume */
    const count = Math.min(190, Math.max(80, Math.round((width * height) / 15000)));
    const positions = new Float32Array(count * 3);
    const base = new Float32Array(count * 3);
    const speeds = new Float32Array(count);
    const phases = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const x = (Math.random() - 0.5) * width * 1.05;
      const y = (Math.random() - 0.5) * height * 1.05;
      const z = (Math.random() - 0.5) * 170;
      base[i * 3] = x; base[i * 3 + 1] = y; base[i * 3 + 2] = z;
      positions[i * 3] = x; positions[i * 3 + 1] = y; positions[i * 3 + 2] = z;
      speeds[i] = 0.35 + Math.random() * 0.85;
      phases[i] = Math.random() * Math.PI * 2;
    }
    const particleGeometry = new THREE.BufferGeometry();
    particleGeometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    const particleMaterial = new THREE.PointsMaterial({
      color: 0x7fb8ff,
      size: 2,
      transparent: true,
      opacity: 0.38,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    particleMesh = new THREE.Points(particleGeometry, particleMaterial);
    world.add(particleMesh);
    particleBase = base;
    particleSpeeds = speeds;
    particlePhases = phases;
  }

  /* ----------------------------------------------------------- interaction */
  const onPointerOver = (event: PointerEvent): void => {
    const target = event.target as Element | null;
    const card = target?.closest?.(".connector-card");
    if (card) {
      const cards = Array.from(section.querySelectorAll(".connector-card"));
      const index = cards.indexOf(card);
      hoverIndex = index >= 0 && index < nodes.length - 1 ? index : -1;
    }
  };
  const onPointerOut = (event: PointerEvent): void => {
    const target = event.target as Element | null;
    if (!target?.closest?.(".connector-card")) hoverIndex = -1;
  };
  const onPointerMove = (event: PointerEvent): void => {
    const rect = section.getBoundingClientRect();
    pointerTX = ((event.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
    pointerTY = -(((event.clientY - rect.top) / Math.max(1, rect.height)) * 2 - 1);
  };

  /* ----------------------------------------------------------------- loop */
  const clock = new THREE.Clock();
  let last = clock.getElapsedTime();

  function frame(): void {
    if (!running) return;
    raf = requestAnimationFrame(frame);
    const time = clock.getElapsedTime();
    const dt = Math.min(0.05, time - last);
    last = time;

    /* parallax — the whole web leans into the pointer, softly */
    pointerX += (pointerTX - pointerX) * 0.05;
    pointerY += (pointerTY - pointerY) * 0.05;
    world.rotation.y = pointerX * 0.05;
    world.rotation.x = pointerY * 0.035;
    world.position.y = Math.sin(time * 0.06) * 6;

    /* hover activation eases up on the hovered card's node */
    let boost = 0;
    for (const node of nodes) {
      const target = nodes.indexOf(node) === hoverIndex ? 1 : 0;
      node.act += (target - node.act) * (dt * 4);
      boost = Math.max(boost, node.act);
    }

    /* nodes — scale and warm toward azure as they wake; the hub breathes with
       a soft sinusoidal pulse underneath its hover swell */
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const isHub = i === nodes.length - 1;
      const pulse = isHub ? 1 + Math.sin(time * 1.5) * 0.1 : 1;
      const s = (1 + node.act * 0.55) * pulse;
      node.mesh.scale.set(s, s, s);
      node.mesh.material.opacity = Math.min(1, (isHub ? 0.65 : 0.55) + node.act * 0.35 + (isHub ? Math.sin(time * 1.5 + 0.8) * 0.05 : 0));
      node.mesh.material.color.setHex(lerpHex(isHub ? 0x4f9dff : 0x9fc6ff, isHub ? 0xbfe0ff : node.accent, node.act));
    }

    /* links — brighten and take the hovered endpoint's accent when one end wakes */
    for (const link of links) {
      const aAct = nodes[link.a]?.act ?? 0;
      const bAct = nodes[link.b]?.act ?? 0;
      const lAct = Math.max(aAct, bAct);
      const accent = (bAct > aAct ? nodes[link.b]?.accent : nodes[link.a]?.accent) ?? 0x9fc6ff;
      link.mesh.material.opacity = 0.22 + lAct * 0.5;
      link.mesh.material.color.setHex(lerpHex(0x4f9dff, accent, lAct));
    }

    /* packets — ride their curves; hover flow makes them hurry */
    const flow = 1 + boost * 2.4;
    for (const packet of packets) {
      packet.t = (packet.t + dt * packet.speed * flow) % 1;
      const point = packet.curve.getPointAt(packet.t);
      packet.mesh.position.set(point.x, point.y, point.z);
      const pulse = 0.75 + 0.25 * Math.sin(time * 3 + packet.phase);
      packet.mesh.material.opacity = 0.85 * pulse;
      packet.mesh.scale.set(pulse, pulse, pulse);
    }

    /* labels — drift on a slow wave; waking an app lifts and brightens its caption */
    for (const label of labels) {
      const act = nodes[label.nodeIndex]?.act ?? 0;
      label.sprite.position.set(
        label.base.x,
        label.base.y + Math.sin(time * 0.9 + label.phase) * 3,
        label.base.z,
      );
      label.sprite.material.opacity = 0.45 + act * 0.5;
      label.sprite.material.color.setHex(lerpHex(0x9fc6ff, nodes[label.nodeIndex]?.accent ?? 0xd9ecff, act));
    }

    /* particles — slow drift, a little livelier around a woken app */
    if (particleMesh && particleBase && particleSpeeds && particlePhases) {
      const positions = particleMesh.geometry.attributes.position.array as Float32Array;
      const amp = 5 + boost * 16;
      for (let i = 0; i < particleBase.length / 3; i++) {
        const sp = particleSpeeds[i];
        const ph = particlePhases[i];
        positions[i * 3] = particleBase[i * 3] + Math.sin(time * sp + ph) * amp;
        positions[i * 3 + 1] = particleBase[i * 3 + 1] + Math.cos(time * sp * 0.8 + ph) * amp * 0.8;
        positions[i * 3 + 2] = particleBase[i * 3 + 2] + Math.sin(time * sp * 0.6 + ph * 1.7) * amp * 0.6;
      }
      particleMesh.geometry.attributes.position.needsUpdate = true;
    }

    renderer.render(scene, camera);
  }

  const stopLoop = (): void => {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };
  const startLoop = (): void => {
    if (running || reducedMotion) return;
    running = true;
    raf = requestAnimationFrame(frame);
  };

  /* ----------------------------------------------------------- visibility */
  const onVisibility = (): void => {
    if (document.hidden) stopLoop();
    else if (active) startLoop();
  };
  document.addEventListener("visibilitychange", onVisibility);

  const observer = new IntersectionObserver(
    (entries) => {
      active = entries[0]?.isIntersecting ?? false;
      if (active && !document.hidden) startLoop();
      else stopLoop();
    },
    { threshold: 0.02 },
  );
  observer.observe(section);

  const resizeObserver = new ResizeObserver(() => {
    rebuild();
    if (!reducedMotion && active && !document.hidden) renderer.render(scene, camera);
  });
  resizeObserver.observe(section);

  section.addEventListener("pointerover", onPointerOver, { passive: true });
  section.addEventListener("pointerout", onPointerOut, { passive: true });
  section.addEventListener("pointermove", onPointerMove, { passive: true });

  rebuild();

  if (reducedMotion) {
    renderer.render(scene, camera);
  } else {
    active = true;
    startLoop();
  }

  /* ------------------------------------------------------------- cleanup */
  return () => {
    stopLoop();
    document.removeEventListener("visibilitychange", onVisibility);
    observer.disconnect();
    resizeObserver.disconnect();
    section.removeEventListener("pointerover", onPointerOver);
    section.removeEventListener("pointerout", onPointerOut);
    section.removeEventListener("pointermove", onPointerMove);
    clearWorld();
    renderer.dispose();
  };
}
