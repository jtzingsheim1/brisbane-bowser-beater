import { createHmac } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase/server";

// Server-side aggregate usage counting for QLD LUL clause 4.8 (active users per
// month, region split, on request). Privacy posture (reconciles with the
// privacy/trust pane):
//   - No cookies, no client JS, no per-user identity returned to the browser.
//   - We never store a raw IP. The "visitor_hash" is HMAC-SHA256(USAGE_SALT, ip),
//     irreversible and rotatable by changing the salt.
//   - One row per (month, visitor) — counts distinct active visitors and a coarse
//     region; new-vs-returning is derivable by comparing months at report time.
//   - Entirely best-effort: any failure is swallowed so it can never break a page
//     render, and it no-ops unless USAGE_SALT is configured.

type HeaderBag = { get(name: string): string | null };

export function getClientIp(h: HeaderBag): string | null {
  const xff = h.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]?.trim() || null;
  return h.get("x-real-ip");
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
    await supabaseAdmin()
      .from("usage_monthly_visitors")
      .upsert(
        {
          period_month: currentMonthStart(),
          visitor_hash: visitorHash,
          region: regionFrom(h),
        },
        { onConflict: "period_month,visitor_hash", ignoreDuplicates: true },
      );
  } catch (error) {
    console.error("[usage] record failed (non-fatal)", error);
  }
}
