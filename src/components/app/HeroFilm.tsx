"use client";

import { useEffect, useRef } from "react";

export function HeroFilm() {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      video.pause();
      return;
    }
    video.muted = true;
    void video.play().catch(() => undefined);
  }, []);

  return (
    <figure className="hero-film">
      <figcaption className="hero-film-bar">
        <span>Product</span>
        <span>46s</span>
      </figcaption>
      <video
        ref={ref}
        className="hero-film-video"
        src="/product.mp4"
        poster="/product-poster.jpg"
        muted
        playsInline
        loop
        controls
        preload="metadata"
        aria-label="Custara product overview"
      />
    </figure>
  );
}
