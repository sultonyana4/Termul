-- Managed ARC reviews and non-secret attempt metadata. Browser credentials are sealed separately.
create table public.termul_circle_browser_sessions (
  handle_hash text primary key check (handle_hash ~ '^[a-f0-9]{64}$'),
  sealed text not null check (char_length(sealed) between 40 and 12500),
  expires_at timestamptz not null
);
create index termul_circle_browser_expiry on public.termul_circle_browser_sessions(expires_at);
alter table public.termul_circle_browser_sessions enable row level security;
revoke all on public.termul_circle_browser_sessions from public, anon, authenticated, service_role;
grant select, insert, delete on public.termul_circle_browser_sessions to service_role;

create function public.termul_circle_browser_session_v1(p_previous text, p_handle text, p_sealed text, p_expiry timestamptz)
returns boolean language plpgsql set search_path = '' as $$
begin
  if not coalesce(p_expiry > clock_timestamp() and p_expiry <= clock_timestamp() + interval '10 minutes', false)
    then return false;
  end if;
  if p_previous is not null then
    delete from public.termul_circle_browser_sessions where handle_hash = p_previous;
    if not found then return false; end if;
  end if;
  insert into public.termul_circle_browser_sessions values (p_handle, p_sealed, p_expiry);
  return true;
end;
$$;

revoke all on function public.termul_circle_browser_session_v1(text, text, text, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.termul_circle_browser_session_v1(text, text, text, timestamptz) to service_role;

create table public.termul_circle_initialization (
  owner_hash text primary key check (owner_hash ~ '^[a-f0-9]{64}$'),
  details jsonb not null check (jsonb_typeof(details) = 'object')
);

create table public.termul_circle_reviews (
  review_id uuid primary key,
  owner_hash text not null check (owner_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz not null,
  review jsonb not null check (jsonb_typeof(review) = 'object'),
  consumed_at timestamptz
);

create table public.termul_circle_attempts (
  attempt_id uuid primary key,
  chain_id integer not null check (chain_id = 5042),
  wallet text not null check (wallet ~ '^0x[a-f0-9]{40}$'),
  payment_key text check (payment_key ~ '^0x[a-f0-9]{40}:0x[a-f0-9]{64}$'),
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  resolved boolean not null default false,
  details jsonb not null check (jsonb_typeof(details) = 'object')
);

create index termul_circle_review_expiry on public.termul_circle_reviews(expires_at);
create index termul_circle_attempt_due on public.termul_circle_attempts(updated_at, attempt_id) where not resolved;
create index termul_circle_attempt_history on public.termul_circle_attempts(wallet, created_at desc);
create unique index termul_circle_wallet_pending on public.termul_circle_attempts(chain_id, wallet) where not resolved;
create unique index termul_circle_payment_pending on public.termul_circle_attempts(chain_id, payment_key) where payment_key is not null and (not resolved or details->>'status' = 'verified');
create unique index termul_circle_creation_once on public.termul_circle_attempts
  (chain_id, wallet, (details->>'invoiceId'))
  where details->>'kind' = 'app-creation' and (not resolved or details->>'status' = 'verified');

alter table public.termul_circle_initialization enable row level security;
revoke all on public.termul_circle_initialization from public, anon, authenticated, service_role;
grant select, insert, update on public.termul_circle_initialization to service_role;

alter table public.termul_circle_reviews enable row level security;
alter table public.termul_circle_attempts enable row level security;
revoke all on public.termul_circle_reviews, public.termul_circle_attempts from public, anon, authenticated, service_role;
grant select, insert, update, delete on public.termul_circle_reviews to service_role;
grant select, insert, update on public.termul_circle_attempts to service_role;

create function public.termul_circle_initialization_v1(p_owner text, p_before jsonb, p_after jsonb)
returns jsonb language plpgsql set search_path = '' as $$
declare
  current_details jsonb;
begin
  if p_before is null then
    insert into public.termul_circle_initialization(owner_hash, details) values (p_owner, p_after)
      on conflict do nothing;
  else
    update public.termul_circle_initialization set details = p_after
      where owner_hash = p_owner and details = p_before;
  end if;
  select details into current_details from public.termul_circle_initialization where owner_hash = p_owner;
  return current_details;
end;
$$;

revoke all on function public.termul_circle_initialization_v1(text, jsonb, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.termul_circle_initialization_v1(text, jsonb, jsonb) to service_role;

create function public.termul_circle_reserve_v1(p_owner text, p_review uuid, p_attempt jsonb, p_session text)
returns boolean language plpgsql set search_path = '' as $$
declare
  chosen jsonb;
  reserved uuid;
begin
  -- Lock the still-valid ownership session through reservation so logout cannot race the insert.
  perform 1 from public.termul_wallet_sessions
    where token_hash = p_session and wallet_address = lower(p_attempt->>'walletAddress')
      and revoked_at is null and expires_at > clock_timestamp()
      and verified_at <= clock_timestamp() and verified_at > clock_timestamp() - interval '5 minutes'
    for share;
  if not found then return false; end if;
  select review into chosen from public.termul_circle_reviews
    where review_id = p_review and owner_hash = p_owner
      and consumed_at is null and expires_at > clock_timestamp()
    for update;
  if chosen is null or p_attempt->>'status' is distinct from 'requesting'
    or not coalesce(p_attempt->>'kind' in ('app-creation', 'payment', 'arc-swap'), false)
    or p_attempt->>'walletAddress' is distinct from chosen->>'walletAddress'
    or p_attempt->>'walletId' is distinct from chosen->>'walletId'
    or p_attempt->>'chainId' is distinct from chosen->>'chainId'
    or p_attempt->>'kind' is distinct from chosen->>'kind'
    or p_attempt->>'gasLimit' is distinct from chosen->>'gasLimit'
    or p_attempt->>'maxFeePerGas' is distinct from chosen->>'maxFeePerGas'
    or p_attempt->>'priorityFeePerGas' is distinct from chosen->>'priorityFeePerGas'
    or (p_attempt->>'gasLimit')::numeric <= 0
    or (p_attempt->>'maxFeePerGas')::numeric <= 0
    or (p_attempt->>'priorityFeePerGas')::numeric not between 0 and (p_attempt->>'maxFeePerGas')::numeric
  then return false;
  end if;
  if chosen->>'kind' = 'arc-swap' then
    if p_attempt->>'id' is distinct from chosen->'q'->>'id'
      or p_attempt->>'invoiceId' is distinct from chosen->'q'->>'id'
      or p_attempt->>'integrator' is distinct from chosen->'q'->>'integrator'
      or p_attempt->>'phase' is distinct from chosen->>'phase'
      or p_attempt->>'from' is distinct from chosen->>'from'
      or p_attempt->>'to' is distinct from chosen->>'to'
      or p_attempt->>'target' is distinct from chosen->>'target'
      or p_attempt->>'amount' is distinct from chosen->>'amount'
      or p_attempt->>'minimum' is distinct from chosen->>'minimum'
      or p_attempt->>'allowanceValue' is distinct from chosen->>'allowanceValue'
      or p_attempt->>'dataHash' is distinct from chosen->>'calldataHash'
      or p_attempt->>'paymentKey' is not null
      or p_attempt->>'account' is distinct from chosen->>'walletAddress'
      or (p_attempt->>'gasLimit')::numeric * (p_attempt->>'maxFeePerGas')::numeric is distinct from (chosen->>'budget')::numeric
    then return false;
    end if;
  else
    if (p_attempt->>'gasLimit')::numeric * (p_attempt->>'maxFeePerGas')::numeric > 10000000000000000
      or p_attempt->>'merchant' is distinct from chosen->>'merchant'
      or p_attempt->>'invoiceId' is distinct from chosen->>'invoiceId'
      or p_attempt->>'amountBase' is distinct from chosen->>'amountBase'
      or p_attempt->>'expiresAt' is distinct from chosen->>'expiresAt'
      or p_attempt->>'calldataHash' is distinct from chosen->>'calldataHash'
      or (p_attempt->>'paymentKey') is distinct from
        (case when chosen->>'kind' = 'payment' then lower(chosen->>'merchant') || ':' || (chosen->>'invoiceId') else null end)
    then return false;
    end if;
  end if;
  insert into public.termul_circle_attempts(attempt_id, chain_id, wallet, payment_key, details)
    values ((p_attempt->>'idempotencyKey')::uuid, (p_attempt->>'chainId')::integer, lower(p_attempt->>'walletAddress'), p_attempt->>'paymentKey', p_attempt)
    on conflict do nothing returning attempt_id into reserved;
  if reserved is null then return false; end if;
  update public.termul_circle_reviews set consumed_at = statement_timestamp() where review_id = p_review;
  return true;
end;
$$;

-- CAS prevents racing stale provider reads from replacing newer or terminal evidence.
create function public.termul_circle_update_v1(p_before jsonb, p_after jsonb)
returns jsonb language plpgsql set search_path = '' as $$
declare
  current_details jsonb;
  id uuid := (p_before->>'idempotencyKey')::uuid;
begin
  if (p_after - array['status','challengeId','challengeStatus','transactionId','transactionHash',
     'transactionStatus','diagnostic','verificationSource','gasUsed','costUsdc','blockNumber',
     'invoiceStatusAtReceipt','latestInvoice','providerHash','spent','received']) is distinct from
     (p_before - array['status','challengeId','challengeStatus','transactionId','transactionHash',
     'transactionStatus','diagnostic','verificationSource','gasUsed','costUsdc','blockNumber',
     'invoiceStatusAtReceipt','latestInvoice','providerHash','spent','received'])
     then raise exception 'Immutable Circle attempt metadata changed'; end if;
  update public.termul_circle_attempts set details = p_after, updated_at = statement_timestamp(),
    resolved = p_after->>'status' in ('verified','reverted','rejected','expired')
    where attempt_id = id and not resolved and details = p_before
    returning details into current_details;
  if current_details is null then
    select details into current_details from public.termul_circle_attempts where attempt_id = id;
  end if;
  return current_details;
end;
$$;

revoke all on function public.termul_circle_reserve_v1(text, uuid, jsonb, text),
  public.termul_circle_update_v1(jsonb, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.termul_circle_reserve_v1(text, uuid, jsonb, text),
  public.termul_circle_update_v1(jsonb, jsonb) to service_role;
