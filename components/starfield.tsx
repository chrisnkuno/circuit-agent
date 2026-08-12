"use client";

import { useEffect, useRef } from "react";

type Star = { x: number; y: number; radius: number; baseAlpha: number; twinkleSpeed: number; phase: number };
type ShootingStar = { x: number; y: number; vx: number; vy: number; life: number; maxLife: number };

const STAR_DENSITY = 1 / 2600;

/** Canvas-based night sky: twinkling stars plus occasional shooting stars, static under prefers-reduced-motion. */
export function Starfield() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let stars: Star[] = [];
    let shootingStars: ShootingStar[] = [];
    let width = 0;
    let height = 0;
    let raf = 0;
    let lastShot = 0;

    function resize() {
      width = window.innerWidth;
      height = window.innerHeight;
      canvas!.width = width * dpr;
      canvas!.height = height * dpr;
      canvas!.style.width = `${width}px`;
      canvas!.style.height = `${height}px`;
      context!.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.round(width * height * STAR_DENSITY);
      stars = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        radius: Math.random() * 1.2 + 0.3,
        baseAlpha: Math.random() * 0.6 + 0.3,
        twinkleSpeed: Math.random() * 0.0015 + 0.0004,
        phase: Math.random() * Math.PI * 2,
      }));
    }

    function frame(time: number) {
      context!.clearRect(0, 0, width, height);
      for (const star of stars) {
        const alpha = reducedMotion ? star.baseAlpha : star.baseAlpha * (0.55 + 0.45 * Math.sin(time * star.twinkleSpeed + star.phase));
        context!.beginPath();
        context!.arc(star.x, star.y, star.radius, 0, Math.PI * 2);
        context!.fillStyle = `rgba(188, 214, 255, ${Math.max(0, alpha).toFixed(3)})`;
        context!.fill();
      }

      if (reducedMotion) return;

      if (time - lastShot > 4200 + Math.random() * 5200) {
        lastShot = time;
        shootingStars.push({ x: Math.random() * width * 0.6, y: Math.random() * height * 0.35, vx: 0.55 + Math.random() * 0.35, vy: 0.28 + Math.random() * 0.18, life: 0, maxLife: 40 + Math.random() * 20 });
      }
      shootingStars = shootingStars.filter((shot) => shot.life < shot.maxLife);
      for (const shot of shootingStars) {
        shot.life += 1;
        shot.x += shot.vx * 6;
        shot.y += shot.vy * 6;
        const fade = 1 - shot.life / shot.maxLife;
        context!.beginPath();
        context!.moveTo(shot.x, shot.y);
        context!.lineTo(shot.x - shot.vx * 26, shot.y - shot.vy * 26);
        context!.strokeStyle = `rgba(160, 198, 255, ${Math.max(0, fade * 0.85).toFixed(3)})`;
        context!.lineWidth = 1.4;
        context!.stroke();
      }
      raf = requestAnimationFrame(frame);
    }

    resize();
    window.addEventListener("resize", resize);
    if (reducedMotion) frame(0);
    else raf = requestAnimationFrame(frame);

    return () => {
      window.removeEventListener("resize", resize);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return <canvas ref={canvasRef} className="starfield-canvas" aria-hidden="true" />;
}
