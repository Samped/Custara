"use client";

export function BrandDot({ className = "" }: { className?: string }) {
  return <span className={`brand-dot ${className}`} aria-hidden>.</span>;
}

export function PageAtmosphere({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`page-grid ${className}`.trim()}>{children}</div>;
}
