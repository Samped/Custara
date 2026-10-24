import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { isApexHost, shouldRedirectApexToTestnet, TESTNET_HOST } from "@/lib/publicUrl";

export function middleware(request: NextRequest) {
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host");
  if (shouldRedirectApexToTestnet() && isApexHost(host)) {
    const dest = request.nextUrl.clone();
    dest.hostname = TESTNET_HOST;
    dest.protocol = "https:";
    dest.port = "";
    return NextResponse.redirect(dest, 302);
  }

  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-pathname", request.nextUrl.pathname);
  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });
  response.headers.set("x-request-id", requestId);
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (process.env.NODE_ENV === "production") {
    response.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
