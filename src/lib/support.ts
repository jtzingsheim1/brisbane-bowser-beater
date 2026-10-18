// Public support contact, shown near the tip jar and on /privacy. Read at
// request time from a server-only variable (no NEXT_PUBLIC_ prefix) so it is
// set from the Vercel dashboard like APP_ORIGIN, and never baked into the
// client bundle. Unset or malformed means "no contact line": callers hide it
// rather than render a blank.
const EMAIL_SHAPE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

export function supportEmail(): string | null {
  const raw = process.env.SUPPORT_EMAIL?.trim();
  if (!raw || !EMAIL_SHAPE.test(raw)) return null;
  return raw;
}
