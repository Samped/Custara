import { PrismaClient } from "@prisma/client";

async function main() {
  const prisma = new PrismaClient();
  const users = await prisma.workspaceUser.findMany({
    orderBy: { createdAt: "asc" },
    select: { id: true, email: true, organizationId: true, createdAt: true },
  });
  const seen = new Map<string, string>();
  let removed = 0;
  for (const u of users) {
    const email = u.email.toLowerCase();
    if (!seen.has(email)) {
      seen.set(email, u.id);
      if (u.email !== email) {
        await prisma.workspaceUser.update({ where: { id: u.id }, data: { email } });
      }
      continue;
    }
    await prisma.session.deleteMany({ where: { userId: u.id } });
    await prisma.workspaceUser.delete({ where: { id: u.id } });
    removed++;
    console.log("removed duplicate", email, u.id);
  }
  console.log("dedupe done, removed", removed, "kept", seen.size);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
