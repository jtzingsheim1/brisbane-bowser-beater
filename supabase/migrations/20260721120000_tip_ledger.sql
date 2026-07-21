-- =============================================================================
-- Migration 0012 — Tip reconciliation ledger
--
-- Backs the "Shout me a litre" tip jar (Stripe-hosted Checkout). One row per
-- verified Stripe webhook event, so every checkout is traceable to a signed
-- event and the books can be reconciled against the Stripe dashboard.
--
-- Deliberately minimal: no donor PII is stored — no email, no name, and no raw
-- event payload column. Donor identity's system of record is Stripe (that is
-- their regulated job); our rows hold only opaque Stripe IDs, the amount, and
-- status. A breach of this database therefore exposes no donor identities.
-- See README (privacy) and src/lib/tips/ledger.ts, which enforces the same
-- whitelist at write time.
--
-- INTERNAL table: not part of the public surface. RLS on with no anon policy
-- and — unlike the anon-readable display tables — deliberately NO anon grant.
-- The webhook route writes via service_role only.
-- =============================================================================

create table tip_ledger (
  stripe_event_id     text primary key,       -- Stripe event ID (evt_…); PK doubles as the idempotency key
  event_type          text not null,          -- e.g. checkout.session.completed
  checkout_session_id text,                   -- cs_… (opaque)
  payment_intent_id   text,                   -- pi_… (opaque)
  amount_total        integer,                -- smallest currency unit (cents)
  currency            text,                   -- e.g. aud
  status              text not null,          -- Stripe payment_status (paid / unpaid)
  occurred_at         timestamptz not null,   -- Stripe event creation time
  recorded_at         timestamptz not null default now()
);

-- Reconciliation lookups go by checkout session.
create index tip_ledger_checkout_session_idx on tip_ledger (checkout_session_id);

alter table tip_ledger enable row level security;
-- No anon policy on purpose (internal ledger; contrast the migration-0004
-- convention for display tables). Migration 0004's ALTER DEFAULT PRIVILEGES
-- auto-grants anon SELECT to new tables — RLS-with-no-policy already returns
-- zero rows to anon, but revoke the grant too, belt-and-braces, so the ledger
-- isn't even reachable through the Data API. service_role bypasses RLS.
revoke all on tip_ledger from anon;
grant all on tip_ledger to service_role;

comment on table tip_ledger is
  'One row per verified Stripe webhook event for the tip jar. Deliberately '
  'PII-free: opaque Stripe IDs, amount, currency, status, timestamps only — '
  'donor identity lives in Stripe. Written by the webhook route via '
  'service_role; no anon access.';
