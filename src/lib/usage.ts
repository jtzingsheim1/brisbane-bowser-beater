import { createHmac } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase/server";

// Server-side aggregate usage counting for QLD LUL clause 4.8 (active users per
// month, region split, on request). Privacy posture (reconciles with the
// privacy/trust pane):
//   - No cookies, no client JS, no per-user identity returned to the browser.
//   - We never store a raw IP. The "visitor_hash" is HMAC-SHA256(USAGE_SALT, ip)
//     truncated to 32 hex chars (128 bits), irreversible and rotatable by
//     changing the salt.
//   - One row per (month, visitor) — counts distinct active visitors and a coarse
//     region; new-vs-returning is derivable by comparing months at report time.
//   - Entirely best-effort: any failure is swallowed so it can never break a page
//     render, and it no-ops unless USAGE_SALT is configured.

type HeaderBag = { get(name: string): string | null };

export function getClientIp(h: HeaderBag): string | null {
  // Prefer Vercel's injected client IP — set by the edge, not user-spoofable,
  // unlike the leftmost x-forwarded-for value (which a client can forge to
  // pick its own rate-limit bucket).
  const vercel = h.get("x-vercel-forwarded-for");
  if (vercel) return vercel.split(",")[0]?.trim() || null;
  const real = h.get("x-real-ip");
  if (real) return real.trim() || null;
  const xff = h.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]?.trim() || null;
  return null;
}

function regionFrom(h: HeaderBag): string {
  // Vercel injects these at the edge; absent locally.
  return (
    h.get("x-vercel-ip-country-region") ||
    h.get("x-vercel-ip-country") ||
    "unknown"
  );
}

function currentMonthStart(): string {
  return `${new Date().toISOString().slice(0, 7)}-01`; // YYYY-MM-01
}

export async function recordVisit(h: HeaderBag): Promise<void> {
  const salt = process.env.USAGE_SALT;
  if (!salt) return; // not configured (local dev / pre-launch) → skip silently

  const ip = getClientIp(h);
  if (!ip) return;

  const visitorHash = createHmac("sha256", salt)
    .update(ip)
    .digest("hex")
    .slice(0, 32);

  try {
    // supabase-js returns Postgres errors rather than throwing, so this must
    // be read explicitly — otherwise a constraint violation would silently
    // stop all LUL 4.8 usage recording with no signal anywhere.
    const { error } = await supabaseAdmin()
      .from("usage_monthly_visitors")
      .upsert(
        {
          period_month: currentMonthStart(),
          visitor_hash: visitorHash,
          region: regionFrom(h),
        },
        { onConflict: "period_month,visitor_hash", ignoreDuplicates: true },
      );
    if (error) {
      console.error("[usage] record failed (non-fatal):", error.message);
    }
  } catch (error) {
    console.error("[usage] record threw (non-fatal)", error);
  }
}
