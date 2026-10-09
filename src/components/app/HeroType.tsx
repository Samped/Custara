"use client";

import { useEffect, useState } from "react";

export function HeroType({ text }: { text: string }) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      setCount(text.length);
      return;
    }
    const id = window.setInterval(() => {
      setCount((n) => {
        if (n >= text.length) {
          window.clearInterval(id);
          return n;
        }
        return n + 1;
      });
    }, 36);
    return () => window.clearInterval(id);
  }, [text]);

  const done = count >= text.length;

  return (
    <p className="hero-line" aria-label={text}>
      <span aria-hidden="true">
        {text.slice(0, count)}
        <span className={`hero-caret${done ? " is-idle" : ""}`} />
      </span>
    </p>
  );
}
