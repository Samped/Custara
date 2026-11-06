import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertErpNextOrigin,
  isBlockedErpNextHost,
} from "../src/domain/connectors/erpnext";
import { isMetadataHost, isPrivateOrLocalIp } from "../src/domain/connectors/odoo";

describe("ERPNext origin guards", () => {
  it("rejects metadata and private hosts by default", () => {
    assert.equal(isMetadataHost("169.254.169.254"), true);
    assert.equal(isPrivateOrLocalIp("10.0.0.1"), true);
    assert.equal(isBlockedErpNextHost("169.254.169.254"), true);
    assert.equal(isBlockedErpNextHost("10.0.0.1", false), true);
    assert.equal(isBlockedErpNextHost("localhost", false), true);
  });

  it("normalizes https origins", () => {
    assert.equal(assertErpNextOrigin("https://acme.frappe.cloud/app/home"), "https://acme.frappe.cloud");
  });

  it("rejects non-http schemes", () => {
    assert.throws(() => assertErpNextOrigin("ftp://example.com"), /http or https/);
  });
});
