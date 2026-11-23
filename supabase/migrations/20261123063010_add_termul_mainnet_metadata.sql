-- Additive rollout. Existing testnet tables, constraints, and records stay in place.
create table public.termul_mainnet_invoices (
  chain_id bigint not null check (chain_id = 5042),
  contract_address text not null check (contract_address ~ '^0x[0-9a-f]{40}$'),
  merchant_address text not null check (merchant_address ~ '^0x[0-9a-f]{40}$'),
  invoice_id text not null check (invoice_id ~ '^0x[0-9a-f]{64}$'),
  merchant_privy_user_id text not null,
  amount_native numeric(78, 0) not null check (
    amount_native > 0 and
    amount_native <= 115792089237316195423570985008687907853269984665640564039457584007913129639935
  ),
  client_name text not null default '',
  client_email text not null default '',
  description text not null default '',
  expires_at timestamptz,
  create_tx_hash text not null check (create_tx_hash ~ '^0x[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  primary key (chain_id, contract_address, merchant_address, invoice_id)
);

create index termul_mainnet_invoices_merchant_idx on public.termul_mainnet_invoices
  (merchant_privy_user_id, chain_id, contract_address, merchant_address, created_at desc);

create table public.termul_mainnet_payment_attempts (
  chain_id bigint not null check (chain_id = 5042),
  contract_address text not null check (contract_address ~ '^0x[0-9a-f]{40}$'),
  merchant_address text not null check (merchant_address ~ '^0x[0-9a-f]{40}$'),
  invoice_id text not null check (invoice_id ~ '^0x[0-9a-f]{64}$'),
  payer_privy_user_id text not null,
  payer_address text not null check (payer_address ~ '^0x[0-9a-f]{40}$'),
  tx_hash text check (tx_hash is null or tx_hash ~ '^0x[0-9a-f]{64}$'),
  updated_at timestamptz not null default now(),
  primary key (chain_id, contract_address, merchant_address, invoice_id, payer_privy_user_id)
);

alter table public.termul_mainnet_invoices enable row level security;
alter table public.termul_mainnet_payment_attempts enable row level security;
revoke all on public.termul_mainnet_invoices, public.termul_mainnet_payment_attempts from public, anon, authenticated, service_role;
grant select, insert on public.termul_mainnet_invoices to service_role;
grant select, insert, update, delete on public.termul_mainnet_payment_attempts to service_role;

comment on table public.termul_mainnet_payment_attempts is
  'Privy-user-scoped submission hints. Only Arc contract state and verified on-chain events establish settlement.';
