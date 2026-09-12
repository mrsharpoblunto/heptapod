import { NextResponse, type NextRequest } from "next/server";

// Resolve at request time so a production build also supports custom sidecar ports.
export function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname.replace(/^\/api\/service/, "");
  return NextResponse.rewrite(new URL(`${path}${request.nextUrl.search}`, process.env.HEPTAPOD_API_URL ?? "http://127.0.0.1:3001"));
}
export const config = { matcher: "/api/service/:path*" };
