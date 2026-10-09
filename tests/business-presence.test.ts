import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isValidSocialUrl,
  isValidWebsite,
  isVerifiedBusiness,
  normalizeHttpUrl,
} from "../src/lib/businessPresence";

describe("businessPresence", () => {
  it("normalizes bare domains", () => {
    assert.equal(normalizeHttpUrl("acme.com"), "https://acme.com");
    assert.equal(normalizeHttpUrl(""), null);
  });

  it("accepts public websites and rejects localhost/IPs", () => {
    assert.equal(isValidWebsite("https://acme.com"), true);
    assert.equal(isValidWebsite("localhost"), false);
    assert.equal(isValidWebsite("http://127.0.0.1"), false);
    assert.equal(isValidWebsite("http://10.0.0.1"), false);
  });

  it("accepts known social hosts only", () => {
    assert.equal(isValidSocialUrl("https://linkedin.com/company/acme"), true);
    assert.equal(isValidSocialUrl("https://x.com/acme"), true);
    assert.equal(isValidSocialUrl("https://acme.com"), false);
  });

  it("requires onboarding plus website or social for verification", () => {
    assert.equal(
      isVerifiedBusiness({
        onboardingCompletedAt: new Date(),
        website: "https://acme.com",
      }),
      true,
    );
    assert.equal(
      isVerifiedBusiness({
        onboardingCompletedAt: new Date(),
        socialUrl: "https://instagram.com/acme",
      }),
      true,
    );
    assert.equal(
      isVerifiedBusiness({
        onboardingCompletedAt: new Date(),
        website: null,
        socialUrl: null,
      }),
      false,
    );
    assert.equal(
      isVerifiedBusiness({
        onboardingCompletedAt: null,
        website: "https://acme.com",
      }),
      false,
    );
  });
});
