import { readFileSync } from "node:fs";
import { createSessionToken } from "../src/lib/auth";
import { prisma } from "../src/lib/db";

async function main() {
  const user = await prisma.workspaceUser.findFirst({ where: { role: "admin" }, orderBy: { createdAt: "asc" } });
  if (!user) throw new Error("no user");
  const { token, cookieName } = await createSessionToken(user.id);
  const pdf = readFileSync("/tmp/custara-multi-5-b.pdf");
  const res = await fetch("http://localhost:3000/api/app/upload-invoice", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-custara-upload": "xhr",
      accept: "application/json",
      cookie: `${cookieName}=${token}`,
    },
    body: JSON.stringify({
      fileName: "custara-multi-5-b.pdf",
      contentType: "application/pdf",
      contentBase64: pdf.toString("base64"),
    }),
  });
  const text = await res.text();
  console.log("status", res.status);
  console.log(text.slice(0, 800));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
