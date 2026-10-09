const SOCIAL_HOSTS = new Set([
  "linkedin.com",
  "www.linkedin.com",
  "twitter.com",
  "www.twitter.com",
  "x.com",
  "www.x.com",
  "instagram.com",
  "www.instagram.com",
  "facebook.com",
  "www.facebook.com",
  "fb.com",
  "www.fb.com",
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
]);

/** Normalize bare domains to https://… ; empty → null. */
export function normalizeHttpUrl(raw: string | null | undefined): string | null {
  const trimmed = (raw || "").trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function parseUrl(raw: string | null | undefined): URL | null {
  const normalized = normalizeHttpUrl(raw);
  if (!normalized) return null;
  try {
    return new URL(normalized);
  } catch {
    return null;
  }
}

function isPublicHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost")) return false;
  if (host === "127.0.0.1" || host === "::1" || host === "0.0.0.0") return false;
  // Reject bare IPv4
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  // Require at least one dot (TLD)
  if (!host.includes(".")) return false;
  return true;
}

export function isValidWebsite(raw: string | null | undefined): boolean {
  const url = parseUrl(raw);
  if (!url) return false;
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return isPublicHostname(url.hostname);
}

export function isValidSocialUrl(raw: string | null | undefined): boolean {
  const url = parseUrl(raw);
  if (!url) return false;
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return SOCIAL_HOSTS.has(host);
}

export function isVerifiedBusiness(org: {
  onboardingCompletedAt?: Date | null;
  website?: string | null;
  socialUrl?: string | null;
}): boolean {
  if (!org.onboardingCompletedAt) return false;
  return isValidWebsite(org.website) || isValidSocialUrl(org.socialUrl);
}
