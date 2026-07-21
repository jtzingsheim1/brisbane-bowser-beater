// Tip jar ("Shout me a litre") configuration shared by the UI and the checkout
// route — the route re-validates every amount server-side against these same
// numbers, so the client can never mint its own price.

export type TipTier = {
  label: string;
  /** Whole Australian dollars, for display. */
  dollars: number;
  amountCents: number;
};

// Fuel-themed, loosely pegged to Brisbane U91 (~$1.90/L): a litre ≈ $2.
export const TIP_TIERS: readonly TipTier[] = [
  { label: "A litre", dollars: 2, amountCents: 200 },
  { label: "A few litres", dollars: 5, amountCents: 500 },
  { label: "Half a tank", dollars: 35, amountCents: 3500 },
];

export const TIP_CURRENCY = "aud";

// Custom-amount bounds. Floor keeps card fees from eating the entire tip;
// ceiling keeps a typo'd "$2000" from going through.
export const MIN_TIP_CENTS = 200; // A$2
export const MAX_TIP_CENTS = 10_000; // A$100

export function isValidTipAmountCents(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_TIP_CENTS &&
    value <= MAX_TIP_CENTS
  );
}

// Feature flag: the tip jar is invisible (UI and checkout route both off)
// until BBB_TIPS is explicitly set truthy — so no payment UI ever shows on
// production before live Stripe keys and the webhook are in place. Opt-in
// (default OFF), unlike the BBB_PUBLIC kill switch which defaults CLOSED for
// the whole site.
export function tipsEnabled(): boolean {
  const raw = process.env.BBB_TIPS;
  if (raw == null) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "true" || normalized === "1";
}
