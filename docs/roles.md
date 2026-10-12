# Roles

Roles is `/app/roles`. Open it from **Go to → Admin → Roles**. Only an admin can open it.

## Role catalog

| Role | What it can do |
|------|----------------|
| Viewer | Read invoices, vendors, payments, and cash |
| Approver | Read bills and decide approvals. Also read policy, cash, and audit. Cannot pay. |
| Payer | Upload bills, pay, manage wallets and vendors, read cash and audit. Cannot publish policy or create API keys. |
| Auditor | Read the books, the approval queue, policy, and the audit trail. Cannot pay or approve. |
| Admin | The whole workspace, including Settings, API keys, policy publish, and invites |

## Team

The team list is everyone in this workspace. Invite a person by email and role. An email belongs to one workspace. You can change a member's role or disable them. You cannot disable yourself.

## MFA by role

**MFA by role** chooses which roles must enroll an authenticator before sign-in completes. This is separate from the payment threshold on [Security](app-security.md). Payment MFA asks for a code when a person pays at or above an amount. Role MFA asks for a code when that person signs in.
