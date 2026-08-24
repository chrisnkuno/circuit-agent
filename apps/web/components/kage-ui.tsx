"use client";

import { useEffect } from "react";

/**
 * Kage-style page furniture and behavior for the Circuit-Nova home page:
 * a chapter progress rail, a custom cursor, and the scroll-driven behaviors
 * Kage's index.html ships with (sticky/hiding nav, slide-in mobile menu,
 * reveal-on-scroll, chapter chips that scroll).
 *
 * Everything here is progressive enhancement — if any of it fails, the page
 * is still fully usable.
 */

const SECTION_IDS = ["work", "principles", "integrations", "agents"];

export function KageFurniture() {
  useEffect(() => {
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");

    const nav = document.querySelector(".nav");
    const burger = document.querySelector<HTMLButtonElement>(".nav-burger");
    const sections = SECTION_IDS
      .map((id) => document.getElementById(id))
      .filter((section): section is HTMLElement => Boolean(section));

    const closeMenu = () => {
      nav?.classList.remove("menu-open");
      document.documentElement.classList.remove("nav-open");
    };

    // Nav: gain the blur wash once scrolled, hide while scrolling down past
    // the hero, reappear on the way back up.
    let lastY = window.scrollY;
    const onScroll = () => {
      const y = window.scrollY;
      nav?.classList.toggle("stuck", y > 10);
      nav?.classList.toggle("hide", y > lastY && y > 420);
      lastY = y;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();

    // Slide-in mobile menu.
    const onBurger = () => {
      nav?.classList.toggle("menu-open");
      document.documentElement.classList.toggle("nav-open", nav?.classList.contains("menu-open") ?? false);
    };
    burger?.addEventListener("click", onBurger);
    nav?.querySelectorAll("a").forEach((link) => link.addEventListener("click", closeMenu));

    // Reveal-on-scroll for [data-rv] elements.
    const reveals = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add("rv-in");
            reveals.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.12, rootMargin: "0px 0px -5% 0px" },
    );
    document.querySelectorAll("[data-rv]").forEach((el) => reveals.observe(el));

    // Progress rail: highlight the section in view, scroll on click.
    const railButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".rail button"));
    const chips = Array.from(document.querySelectorAll<HTMLButtonElement>(".chip"));
    const markChapter = (index: number) => {
      railButtons.forEach((button, i) => button.classList.toggle("on", i === index));
      chips.forEach((chip, i) => chip.classList.toggle("on", i === index));
    };
    const rail = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          markChapter(sections.indexOf(entry.target as HTMLElement));
        }
      },
      { threshold: 0.35 },
    );
    sections.forEach((section) => rail.observe(section));
    const scrollToChapter = (index: number) => {
      const target = sections[index];
      if (!target) return;
      target.scrollIntoView({ behavior: reduceMotion.matches ? "auto" : "smooth" });
    };
    railButtons.forEach((button) => {
      button.addEventListener("click", () => scrollToChapter(Number(button.dataset.step ?? "0")));
    });
    chips.forEach((chip) => {
      chip.addEventListener("click", () => scrollToChapter(Number(chip.dataset.chip ?? "0")));
    });

    // Custom cursor (fine pointers only; the dot itself is CSS-only otherwise).
    let cleanupCursor = () => {};
    if (finePointer.matches) {
      const dot = document.querySelector<HTMLElement>(".cur-dot");
      if (dot) {
        let raf = 0;
        let x = window.innerWidth / 2;
        let y = window.innerHeight / 2;
        let tx = x;
        let ty = y;
        const frame = () => {
          raf = 0;
          x += (tx - x) * 0.2;
          y += (ty - y) * 0.2;
          dot.style.transform = `translate3d(${x}px, ${y}px, 0)`;
        };
        const move = (event: MouseEvent) => {
          tx = event.clientX;
          ty = event.clientY;
          if (!raf) raf = requestAnimationFrame(frame);
        };
        const actOn = () => dot.classList.add("act");
        const actOff = () => dot.classList.remove("act");
        const interactive = "a, button, .chip, .card, .peek, .rail, select, input, label";
        window.addEventListener("mousemove", move, { passive: true });
        document.querySelectorAll(interactive).forEach((el) => {
          el.addEventListener("mouseenter", actOn);
          el.addEventListener("mouseleave", actOff);
        });
        cleanupCursor = () => {
          window.removeEventListener("mousemove", move);
          if (raf) cancelAnimationFrame(raf);
          document.querySelectorAll(interactive).forEach((el) => {
            el.removeEventListener("mouseenter", actOn);
            el.removeEventListener("mouseleave", actOff);
          });
        };
      }
    }

    return () => {
      window.removeEventListener("scroll", onScroll);
      burger?.removeEventListener("click", onBurger);
      nav?.querySelectorAll("a").forEach((link) => link.removeEventListener("click", closeMenu));
      reveals.disconnect();
      rail.disconnect();
      cleanupCursor();
    };
  }, []);

  return (
    <>
      {/* Chapter progress rail. */}
      <div className="rail" aria-hidden="true">
        {SECTION_IDS.map((_, index) => (
          <button key={index} data-step={index} tabIndex={-1} aria-label={`Chapter ${index + 1}`}><i /></button>
        ))}
      </div>

      {/* Custom cursor. */}
      <div className="cur-dot" aria-hidden="true" />
    </>
  );
}
