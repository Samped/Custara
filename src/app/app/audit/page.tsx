import { redirect } from "next/navigation";
import { requireSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { AppShell } from "@/components/app/AppShell";
import { formatDate } from "@/lib/format";

export default async function AuditPage() {
  let user;
  try {
    user = await requireSessionUser(undefined, "audit:read");
  } catch {
    redirect("/login");
  }

  const events = await prisma.auditEvent.findMany({
    where: { organizationId: user.organizationId },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return (
    <AppShell user={user} title="Audit" subtitle="Append-only · request IDs">
      <div className="card overflow-hidden">
        <table className="table">
          <thead>
            <tr>
              <th>When</th>
              <th>Action</th>
              <th>Actor</th>
              <th>Entity</th>
              <th>Metadata</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => (
              <tr key={event.id}>
                <td className="whitespace-nowrap text-sm">{formatDate(event.createdAt)}</td>
                <td className="font-medium">{event.action}</td>
                <td className="app-sub">
                  {event.actorType}
                  {event.actorId ? ` · ${event.actorId.slice(0, 8)}` : ""}
                </td>
                <td className="app-sub">
                  {event.entityType}
                  {event.entityId ? ` · ${event.entityId.slice(0, 8)}` : ""}
                </td>
                <td className="max-w-xs truncate font-mono text-xs text-muted">{event.metadataJson}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AppShell>
  );
}
