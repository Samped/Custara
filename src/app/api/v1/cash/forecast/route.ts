import { NextResponse } from "next/server";
import { AuthError, authenticateApiKey } from "@/lib/auth";
import { getCashForecast } from "@/domain/cash";

export async function GET(request: Request) {
  try {
    const auth = await authenticateApiKey(request.headers.get("authorization"), ["cash:read"]);
    const forecast = await getCashForecast(auth.organizationId);
    return NextResponse.json(forecast);
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
