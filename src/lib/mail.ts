export type MailProvider = "resend" | "smtp" | null;

export function getMailProvider(): MailProvider {
  if (process.env.RESEND_API_KEY?.trim()) return "resend";
  if (
    process.env.SMTP_HOST?.trim() &&
    process.env.SMTP_USER?.trim() &&
    process.env.SMTP_PASS?.trim()
  ) {
    return "smtp";
  }
  return null;
}

export function isMailConfigured() {
  return Boolean(getMailProvider() && getEmailFrom());
}

export function getEmailFrom() {
  return (process.env.EMAIL_FROM || process.env.RESEND_FROM || "").trim();
}

export async function sendEmail(input: {
  to: string;
  subject: string;
  text: string;
  html: string;
}) {
  const provider = getMailProvider();
  const from = getEmailFrom();
  if (!provider || !from) {
    throw new Error("Email delivery is not configured (set RESEND_API_KEY + EMAIL_FROM, or SMTP_*)");
  }

  if (provider === "resend") {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY!.trim()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [input.to],
        subject: input.subject,
        text: input.text,
        html: input.html,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg =
        (body as { message?: string })?.message ||
        (typeof body === "object" ? JSON.stringify(body) : "Resend error");
      throw new Error(`Resend failed: ${msg}`);
    }
    return { provider: "resend" as const, id: (body as { id?: string }).id };
  }

  // SMTP via nodemailer (dynamic import so it stays optional until configured)
  const nodemailer = await import("nodemailer");
  const port = Number(process.env.SMTP_PORT || "587");
  const secure = process.env.SMTP_SECURE === "true" || port === 465;
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  const info = await transporter.sendMail({
    from,
    to: input.to,
    subject: input.subject,
    text: input.text,
    html: input.html,
  });
  return { provider: "smtp" as const, id: info.messageId };
}

export function otpEmailContent(code: string) {
  const subject = "Your Custara sign-in code";
  const text = `Your Custara sign-in code is ${code}.\n\nIt expires in 10 minutes. If you did not request this, you can ignore this email.`;
  const html = `
    <div style="font-family: ui-sans-serif, system-ui, sans-serif; max-width: 420px; margin: 0 auto; padding: 24px;">
      <p style="font-size: 14px; color: #555; margin: 0 0 12px;">Custara</p>
      <h1 style="font-size: 22px; margin: 0 0 16px;">Sign-in code</h1>
      <p style="font-size: 32px; letter-spacing: 0.2em; font-weight: 700; margin: 0 0 16px;">${code}</p>
      <p style="font-size: 14px; color: #555; margin: 0;">Expires in 10 minutes. If you did not request this, ignore this email.</p>
    </div>
  `;
  return { subject, text, html };
}
