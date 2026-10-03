"use client";

import { useState } from "react";

export function CopyButton({
  value,
  label = "Copy",
  className = "btn btn-secondary",
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button type="button" className={className} onClick={onCopy}>
      {copied ? "Copied" : label}
    </button>
  );
}
