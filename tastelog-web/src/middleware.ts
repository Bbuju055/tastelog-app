import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { hasSupabaseEnv } from "@/lib/supabase/env";

const PUBLIC_PATH_PREFIXES = ["/login", "/api", "/_next", "/favicon.ico"];
const PUBLIC_FILE = /\.(.*)$/;

/**
 * Auth gate:
 * - If Supabase env is not configured -> skip auth, proceed unauthenticated
 * - If route is protected and user is not authenticated -> redirect to /login?next=...
 * - Otherwise continue
 */
export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Skip next internals / public files / explicitly public prefixes
  if (
    PUBLIC_PATH_PREFIXES.some((p) => pathname.startsWith(p)) ||
    PUBLIC_FILE.test(pathname)
  ) {
    return NextResponse.next();
  }

  // If Supabase is not configured, skip auth entirely
  if (!hasSupabaseEnv()) {
    return NextResponse.next();
  }

  // Prepare response so @supabase/ssr can set cookies when refreshing sessions
  const res = NextResponse.next();

  // Safe to assert: hasSupabaseEnv() guarantees these are set
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => req.cookies.getAll(),
        setAll: (cookiesToSet) => {
          for (const { name, value, options } of cookiesToSet) {
            res.cookies.set(name, value, options);
          }
        },
      },
    }
  );

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  // Fail closed on error
  if (error || !user) {
    const loginUrl = req.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return res;
}

// Protect everything except explicit public paths handled above
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
