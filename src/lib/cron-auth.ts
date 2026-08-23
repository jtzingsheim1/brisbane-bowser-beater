import { createHash, timingSafeEqual } from "node:crypto";

// Bearer-token gate for cron endpoints, extracted from the route so the
// auth matrix is unit-testable. When the secret is unset (local dev) the
// endpoint is open — there's no secret to check against yet.
//
// The comparison is constant-time: both sides are hashed to fixed-length
// digests first, because timingSafeEqual requires equal-length inputs and
// comparing digests avoids leaking the expected header's length through an
// early length check.
export function bearerAuthorized(
  header: string | null,
  secret: string | undefined,
): boolean {
  if (!secret) return true;
  if (!header) return false;
  const digest = (value: string) =>
    createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(header), digest(`Bearer ${secret}`));
}
