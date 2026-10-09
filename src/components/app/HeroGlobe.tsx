"use client";

import { useEffect, useState } from "react";

type Vec = [number, number, number];

const NODES: { id: string; lat: number; lng: number }[] = [
  { id: "lagos", lat: 6.5, lng: 3.4 },
  { id: "london", lat: 51.5, lng: -0.1 },
  { id: "nyc", lat: 40.7, lng: -74 },
  { id: "singapore", lat: 1.35, lng: 103.8 },
  { id: "nairobi", lat: -1.3, lng: 36.8 },
  { id: "dubai", lat: 25.2, lng: 55.3 },
  { id: "saopaulo", lat: -23.55, lng: -46.6 },
  { id: "frankfurt", lat: 50.1, lng: 8.7 },
];

const LINKS: [string, string][] = [
  ["lagos", "london"],
  ["london", "nyc"],
  ["lagos", "nairobi"],
  ["nairobi", "dubai"],
  ["dubai", "singapore"],
  ["nyc", "saopaulo"],
  ["london", "frankfurt"],
  ["singapore", "lagos"],
];

const CX = 200;
const CY = 200;
/** Screen radius of the old outline; mesh is scaled so its edge lands there. */
const LIMB = 156;
const R = LIMB * 1.55;

function vec(lat: number, lng: number, rot: number): Vec {
  const la = (lat * Math.PI) / 180;
  const ln = ((lng + rot) * Math.PI) / 180;
  return [Math.cos(la) * Math.sin(ln), Math.sin(la), Math.cos(la) * Math.cos(ln)];
}

function slerp(a: Vec, b: Vec, t: number): Vec {
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  dot = Math.min(1, Math.max(-1, dot));
  const omega = Math.acos(dot);
  if (omega < 1e-3) return a;
  const s = Math.sin(omega);
  const s0 = Math.sin((1 - t) * omega) / s;
  const s1 = Math.sin(t * omega) / s;
  return [a[0] * s0 + b[0] * s1, a[1] * s0 + b[1] * s1, a[2] * s0 + b[2] * s1];
}

function project(v: Vec) {
  const depth = 1 / (1.55 - v[2] * 0.42);
  return {
    x: CX + v[0] * R * depth,
    y: CY - v[1] * R * depth,
    z: v[2],
  };
}

function frontPath(samples: Vec[]) {
  let d = "";
  let drawing = false;
  for (const v of samples) {
    const p = project(v);
    if (p.z < 0.05) {
      drawing = false;
      continue;
    }
    d += `${drawing ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`;
    drawing = true;
  }
  return d;
}

function meridian(lng: number, rot: number) {
  const pts: Vec[] = [];
  for (let lat = -88; lat <= 88; lat += 4) pts.push(vec(lat, lng, rot));
  return frontPath(pts);
}

function parallel(lat: number, rot: number) {
  const pts: Vec[] = [];
  for (let lng = 0; lng <= 360; lng += 6) pts.push(vec(lat, lng, rot));
  return frontPath(pts);
}

function arcSamples(a: Vec, b: Vec, from = 0, to = 1, steps = 28) {
  const pts: Vec[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = from + ((to - from) * i) / steps;
    pts.push(slerp(a, b, t));
  }
  return pts;
}

export function HeroGlobe() {
  const [frame, setFrame] = useState({ rot: 18, elapsed: 0, motion: true, ready: false });

  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      setFrame({ rot: 24, elapsed: 900, motion: false, ready: true });
      return;
    }
    let raf = 0;
    let last = performance.now();
    let elapsed = 0;
    const loop = (now: number) => {
      const dt = Math.min(32, now - last);
      last = now;
      elapsed += dt;
      setFrame({ rot: (elapsed * 0.01) % 360, elapsed, motion: true, ready: true });
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const { rot, elapsed, ready } = frame;
  if (!ready) {
    return (
      <svg className="hero-globe-svg" viewBox="0 0 400 400" role="img" aria-label="Businesses connecting across the network" />
    );
  }
  const linkMs = 3200;
  const link = LINKS[Math.abs(Math.floor(elapsed / linkMs)) % LINKS.length] ?? LINKS[0];
  const u = (elapsed % linkMs) / linkMs;
  const lats = [-75, -60, -45, -30, -15, 0, 15, 30, 45, 60, 75];
  const lngs = Array.from({ length: 24 }, (_, i) => i * 15);
  const from = NODES.find((n) => n.id === link[0])!;
  const to = NODES.find((n) => n.id === link[1])!;
  const snap = (lat: number, lng: number) => {
    const nearestLat = lats.reduce((best, value) =>
      Math.abs(value - lat) < Math.abs(best - lat) ? value : best,
    );
    const norm = ((lng % 360) + 360) % 360;
    const nearestLng = lngs.reduce((best, value) =>
      Math.abs(value - norm) < Math.abs(best - norm) ? value : best,
    );
    return { lat: nearestLat, lng: nearestLng };
  };
  const start = snap(from.lat, from.lng);
  const end = snap(to.lat, to.lng);
  const a = vec(start.lat, start.lng, rot);
  const b = vec(end.lat, end.lng, rot);
  const arc = frontPath(arcSamples(a, b));
  const trail = frontPath(arcSamples(a, b, Math.max(0, u - 0.22), u, 12));
  const head = project(slerp(a, b, u));

  return (
    <svg className="hero-globe-svg" viewBox="0 0 400 400" role="img" aria-label="Businesses connecting across the network">
      {lats.map((lat) => (
        <path
          key={`lat-${lat}`}
          d={parallel(lat, rot)}
          fill="none"
          stroke="var(--foreground)"
          strokeOpacity={lat === 0 ? 0.28 : 0.14}
          strokeWidth={lat === 0 ? 1.15 : 0.8}
        />
      ))}
      {lngs.map((lng) => (
        <path
          key={`lng-${lng}`}
          d={meridian(lng, rot)}
          fill="none"
          stroke="var(--foreground)"
          strokeOpacity="0.14"
          strokeWidth="0.8"
        />
      ))}
      {arc ? (
        <path d={arc} fill="none" stroke="var(--accent)" strokeOpacity="0.35" strokeWidth="1.15" />
      ) : null}
      {trail ? (
        <path d={trail} fill="none" stroke="var(--accent)" strokeOpacity="0.95" strokeWidth="1.6" strokeLinecap="round" />
      ) : null}
      {lats.flatMap((lat) =>
        lngs.map((lng) => {
          const p = project(vec(lat, lng, rot));
          if (p.z < 0.08) return null;
          return (
            <circle
              key={`${lat}-${lng}`}
              cx={p.x}
              cy={p.y}
              r={1.35 + p.z * 0.7}
              fill="var(--foreground)"
              fillOpacity={0.22 + p.z * 0.28}
            />
          );
        }),
      )}
      {head.z > 0.08 ? <circle cx={head.x} cy={head.y} r={2.4} fill="var(--foreground)" /> : null}
    </svg>
  );
}
