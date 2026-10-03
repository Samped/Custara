import { NextResponse } from "next/server";
import { csvTemplateContent } from "@/domain/csvIngest";

/** Downloadable CSV template for AP bulk ingest. */
export async function GET() {
  return new NextResponse(csvTemplateContent(), {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="custara-ap-template.csv"',
    },
  });
}
