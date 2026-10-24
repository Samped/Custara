# Controls

Controls is `/app/policies`. Open it from **Go to → Admin → Controls**. Admins and auditors can open it. Publishing a new version is admin only.

Controls has two tabs: **Policies** and **Audit**.

## Policies

A policy is versioned. The active version is what every new bill is scored against. Publishing does not rewrite bills that already finished the pipeline.

The form sets:

| Field | Effect |
|-------|--------|
| Auto-approve max | Ceiling in the policy currency |
| Auto-approve max (USDC) | Ceiling for USDC and USD bills |
| Min confidence for auto-approve | Bills under this confidence stay in review |
| Single approver max | One approver up to this amount |
| Dual control above | Two different approvers above this amount |
| Hold on new vendor | First-time vendors wait for a person |
| Hold on bank change | A changed account or Arc address waits for a person |
| Hold on duplicate | A repeated invoice number or file is held |
| Require PO / contract match | The purchase order on the bill must match a PO stored on the vendor |
| Require a purchase order on every invoice | A bill with no PO number is held |
| Hold if wallet not allowlisted | An unknown Arc address is held |
| Block auto-approve until Arc destination allowlisted | A known address can still block auto-approve until it is on the allowlist |
| Require approval when a bill is coded to a cost center | Analytic names from Odoo hold the bill for a person |
| Cost centers that require approval | Optional names. Empty means any cost center. |

**Publish policy version** saves the form as the next version. **Apply PayablesAI Strict preset** fills the live preset: auto-approve up to 5,000 USDC, confidence floor 0.75, purchase order required, and the new-vendor, duplicate, and allowlist holds on.

The table under the form is the version history.

## Audit

Audit lists the latest 100 events for this workspace: when, action, actor, entity, and metadata. The hash chain and the export for a SIEM are described in [Audit](audit.md). Settings also shows whether that chain is intact.
