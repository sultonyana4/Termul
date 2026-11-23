-- The original mainnet and legacy tables are read-only to the new API.
create table public.termul_wallet_challenges (
  token_hash text primary key check (token_hash ~ '^[a-f0-9]{64}$'),
  message_hash text not null check (message_hash ~ '^[a-f0-9]{64}$'),
  wallet_address text not null check (wallet_address ~ '^0x[0-9a-f]{40}$'),
  expires_at timestamptz not null,
  consumed_at timestamptz
);

create table public.termul_wallet_sessions (
  token_hash text primary key check (token_hash ~ '^[a-f0-9]{64}$'),
  wallet_address text not null check (wallet_address ~ '^0x[0-9a-f]{40}$'),
  verified_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);

create table public.termul_wallet_rate_limits (
  bucket text primary key,
  window_start timestamptz not null,
  requests integer not null
);

create table public.termul_wallet_profiles (
  wallet_address text primary key check (wallet_address ~ '^0x[0-9a-f]{40}$'),
  display_name text not null check (char_length(display_name) between 1 and 40)
);

create table public.termul_wallet_invoices (
  chain_id bigint not null check (chain_id = 5042),
  contract_address text not null check (contract_address = '0x62209ab89631492e7943ef21baee792d430f5d0e'),
  merchant_address text not null check (merchant_address ~ '^0x[0-9a-f]{40}$'),
  invoice_id text not null check (invoice_id ~ '^0x[0-9a-f]{64}$'),
  amount_native numeric(78, 0) not null check (
    amount_native > 0 and amount_native <= 115792089237316195423570985008687907853269984665640564039457584007913129639935
  ),
  client_name text not null,
  client_email text not null,
  description text not null,
  expires_at timestamptz,
  create_tx_hash text not null check (create_tx_hash ~ '^0x[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  primary key (chain_id, contract_address, merchant_address, invoice_id)
);

create table public.termul_wallet_payment_attempts (
  chain_id bigint not null check (chain_id = 5042),
  contract_address text not null check (contract_address = '0x62209ab89631492e7943ef21baee792d430f5d0e'),
  merchant_address text not null check (merchant_address ~ '^0x[0-9a-f]{40}$'),
  invoice_id text not null check (invoice_id ~ '^0x[0-9a-f]{64}$'),
  payer_address text not null check (payer_address ~ '^0x[0-9a-f]{40}$'),
  attempt_id uuid not null,
  tx_hash text check (tx_hash is null or tx_hash ~ '^0x[0-9a-f]{64}$'),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz,
  primary key (chain_id, contract_address, merchant_address, invoice_id, payer_address)
);

create index termul_wallet_challenge_expiry on public.termul_wallet_challenges (expires_at);
create index termul_wallet_session_expiry on public.termul_wallet_sessions (expires_at);
create index termul_mainnet_attempts_wallet on public.termul_mainnet_payment_attempts
  (chain_id, contract_address, payer_address, merchant_address, invoice_id, updated_at desc);

alter table public.termul_wallet_challenges enable row level security;
alter table public.termul_wallet_sessions enable row level security;
alter table public.termul_wallet_rate_limits enable row level security;
alter table public.termul_wallet_profiles enable row level security;
alter table public.termul_wallet_invoices enable row level security;
alter table public.termul_wallet_payment_attempts enable row level security;

revoke all on public.termul_wallet_challenges, public.termul_wallet_sessions,
  public.termul_wallet_rate_limits, public.termul_wallet_profiles,
  public.termul_wallet_invoices, public.termul_wallet_payment_attempts
  from public, anon, authenticated, service_role;
grant select, insert, update on public.termul_wallet_challenges, public.termul_wallet_sessions,
  public.termul_wallet_profiles, public.termul_wallet_payment_attempts to service_role;
grant select, insert on public.termul_wallet_invoices to service_role;
grant select, insert, update on public.termul_wallet_rate_limits to service_role;

create function public.termul_wallet_confirm_v1(
  p_challenge text, p_message text, p_wallet text, p_session text
) returns boolean language sql set search_path = '' as $$
  with consumed as (
    update public.termul_wallet_challenges
    set consumed_at = statement_timestamp()
    where token_hash = p_challenge and message_hash = p_message and wallet_address = p_wallet
      and consumed_at is null and expires_at > statement_timestamp()
    returning wallet_address
  ), issued as (
    insert into public.termul_wallet_sessions (token_hash, wallet_address, expires_at)
    select p_session, wallet_address, statement_timestamp() + interval '12 minutes' from consumed
    returning 1
  )
  select exists (select 1 from issued);
$$;

create function public.termul_wallet_rate_v1(p_bucket text, p_limit integer)
returns boolean language sql set search_path = '' as $$
  insert into public.termul_wallet_rate_limits as r (bucket, window_start, requests)
  values (p_bucket, date_trunc('minute', statement_timestamp()), 1)
  on conflict (bucket) do update set
    requests = case when r.window_start = excluded.window_start then least(r.requests + 1, p_limit + 1) else 1 end,
    window_start = excluded.window_start
  returning requests <= p_limit;
$$;

create function public.termul_wallet_reserve_v1(
  p_merchant text, p_invoice text, p_payer text, p_attempt uuid
) returns boolean language sql set search_path = '' as $$
  with claim as (
    insert into public.termul_wallet_payment_attempts as previous
      (chain_id, contract_address, merchant_address, invoice_id, payer_address, attempt_id)
    values (5042, '0x62209ab89631492e7943ef21baee792d430f5d0e', p_merchant, p_invoice, p_payer, p_attempt)
    on conflict (chain_id, contract_address, merchant_address, invoice_id, payer_address)
    do update set attempt_id = excluded.attempt_id, tx_hash = null,
      resolved_at = null, updated_at = statement_timestamp()
    where previous.resolved_at is not null
    returning 1
  )
  select exists (select 1 from claim);
$$;

revoke all on function public.termul_wallet_confirm_v1(text, text, text, text),
  public.termul_wallet_rate_v1(text, integer),
  public.termul_wallet_reserve_v1(text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.termul_wallet_confirm_v1(text, text, text, text),
  public.termul_wallet_rate_v1(text, integer),
  public.termul_wallet_reserve_v1(text, text, text, uuid) to service_role;
