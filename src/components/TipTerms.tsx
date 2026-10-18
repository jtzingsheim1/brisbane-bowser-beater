// The tip jar's terms and support line, shared by the tip jar and /privacy.
// Tips are framed as a voluntary thank-you for free content, never as a
// donation (Stripe can't support Australian donations that aren't linked to a
// good or service). The refund sentence needs a contact, so it only renders
// when SUPPORT_EMAIL is set.

export default function TipTerms({
  email,
  className,
}: {
  email: string | null;
  className?: string;
}) {
  return (
    <p className={className}>
      Tips are voluntary and buy nothing: a thank-you for the free content.
      They aren&rsquo;t tax-deductible.
      {email && (
        <>
          {" "}
          If you tipped by mistake, get in touch for a refund:{" "}
          <a href={`mailto:${email}`} className="underline">
            {email}
          </a>
          .
        </>
      )}
    </p>
  );
}
