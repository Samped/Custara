import { prisma } from "@/lib/db";
import { deleteObject } from "@/lib/storage";
import { writeAudit } from "@/lib/audit";

/** Soft-delete and remove bytes for documents past retainedUntil. */
export async function purgeExpiredDocuments(limit = 200) {
  const now = new Date();
  const docs = await prisma.invoiceDocument.findMany({
    where: {
      deletedAt: null,
      retainedUntil: { lte: now },
    },
    include: { invoice: { select: { organizationId: true } } },
    take: limit,
    orderBy: { retainedUntil: "asc" },
  });

  let purged = 0;
  const errors: string[] = [];
  for (const doc of docs) {
    try {
      if (doc.storagePath) {
        await deleteObject(doc.storagePath);
      }
      await prisma.invoiceDocument.update({
        where: { id: doc.id },
        data: { deletedAt: now, byteSize: 0, storagePath: `purged:${doc.id}` },
      });
      await writeAudit({
        organizationId: doc.invoice.organizationId,
        actorType: "system",
        action: "document.purged",
        entityType: "invoice_document",
        entityId: doc.id,
        metadata: { invoiceId: doc.invoiceId, retainedUntil: doc.retainedUntil?.toISOString() },
      });
      purged += 1;
    } catch (e) {
      errors.push(`${doc.id}: ${e instanceof Error ? e.message : "purge failed"}`);
    }
  }
  return { scanned: docs.length, purged, errors };
}
