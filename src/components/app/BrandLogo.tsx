"use client";

import Image from "next/image";
import Link from "next/link";

type BrandLogoProps = {
  className?: string;
  size?: number;
  showWordmark?: boolean;
  href?: string | null;
  wordmarkClassName?: string;
};

export function BrandLogo({
  className = "",
  size = 22,
  showWordmark = true,
  href = "/app",
  wordmarkClassName = "",
}: BrandLogoProps) {
  const mark = (
    <span
      className={`brand-logo ${className}`.trim()}
      style={{ width: size, height: size }}
    >
      <Image
        src="/logo-mark.png"
        alt=""
        fill
        sizes={`${size}px`}
        className="brand-logo-img brand-logo-img-dark object-contain"
        priority
      />
      <Image
        src="/logo-mark-light.png"
        alt=""
        fill
        sizes={`${size}px`}
        className="brand-logo-img brand-logo-img-light object-contain"
        priority
      />
    </span>
  );

  const content = showWordmark ? (
    <span className={`brand inline-flex items-center gap-2 ${wordmarkClassName}`.trim()}>
      {mark}
      <span>Custara</span>
    </span>
  ) : (
    mark
  );

  if (href === null) {
    return (
      <span className="inline-flex items-center" aria-label="Custara">
        {content}
      </span>
    );
  }

  return (
    <Link href={href} className="inline-flex items-center" aria-label="Custara">
      {content}
    </Link>
  );
}
