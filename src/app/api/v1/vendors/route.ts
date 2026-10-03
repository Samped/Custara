import { NextResponse } from "next/server";
import { AuthError, authenticateApiKey } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { encryptField, last4 } from "@/lib/crypto";
import { addDestination } from "@/domain/arc/allowlist";

export async function POST(request: Request) {
  try {
    const auth = await authenticateApiKey(request.headers.get("authorization"), ["invoices:write"]);
    const body = (await request.json()) as {
      external_id?: string;
      name?: string;
      email?: string;
      account_name?: string;
      account_number?: string;
      bank_name?: string;
      bank_code?: string;
      currency?: string;
      arc_address?: string;
      endpoint_type?: "bank" | "arc_usdc";
    };

    if (!body.name) return NextResponse.json({ error: "name required" }, { status: 400 });

    const endpointType = body.endpoint_type || (body.arc_address ? "arc_usdc" : "bank");

    const vendor = await prisma.vendor.create({
      data: {
        organizationId: auth.organizationId,
        externalId: body.external_id || null,
        name: body.name,
        email: body.email || null,
        isNew: true,
        endpoints:
          endpointType === "arc_usdc" && body.arc_address
            ? {
                create: {
                  endpointType: "arc_usdc",
                  accountName: body.account_name || body.name,
                  arcAddress: body.arc_address.toLowerCase(),
                  currency: body.currency || "USDC",
                  version: 1,
                  isActive: true,
                },
              }
            : body.account_number && body.account_name
              ? {
                  create: {
                    endpointType: "bank",
                    accountName: body.account_name,
                    accountNumberEncrypted: encryptField(body.account_number),
                    accountNumberLast4: last4(body.account_number),
                    bankName: body.bank_name || null,
                    bankCode: body.bank_code || null,
                    currency: body.currency || "NGN",
                    version: 1,
                    isActive: true,
                  },
                }
              : undefined,
      },
    });

    if (endpointType === "arc_usdc" && body.arc_address) {
      await addDestination({
        organizationId: auth.organizationId,
        address: body.arc_address,
        label: body.name,
        vendorId: vendor.id,
        actorId: auth.apiKeyId,
      });
    }

    await writeAudit({
      organizationId: auth.organizationId,
      actorType: "api_key",
      actorId: auth.apiKeyId,
      action: "vendor.created",
      entityType: "vendor",
      entityId: vendor.id,
      metadata: { endpointType },
    });

    return NextResponse.json({ id: vendor.id, name: vendor.name }, { status: 201 });
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    const message = e instanceof Error ? e.message : "Server error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
