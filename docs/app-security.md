# Security

Security is `/app/security`. Open it from **Go to → Admin → Security**. Every signed-in role can open it and manage their own authenticator. Only an admin can change the payment threshold.

The control model for sessions, keys, and encryption is in the handbook [Security](security.md). This page is the screen people use.

## Authenticator

Status is **Enabled**, **Enrollment in progress**, or **Off**.

**Set up MFA** shows a secret and a QR code. Scan it in an authenticator app, enter the current code, and confirm. After that, status is Enabled. **Disable** asks for a current code and turns it off.

If a role is selected under [Roles](roles.md) → MFA by role, sign-in will not finish until this authenticator is on.

## Payment MFA

Admins set **Require MFA at or above (USD)**. The default is 5,000.

- A payment under that amount does not ask for a code.
- A payment at or above it requires an enrolled authenticator and the current code on the invoice pay card.
- Autopay, which runs as the system, does not ask for a code.

Save the threshold with **Save threshold**.
