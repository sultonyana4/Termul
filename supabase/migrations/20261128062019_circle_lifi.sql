-- Share wallet-wide bridge exclusivity and the compare-and-swap reservation.
alter table public.termul_circle_bridges
  add column workflow text not null default 'cctp' check(workflow in ('cctp', 'lifi'));
create index termul_circle_workflow_history on public.termul_circle_bridges(workflow, wallet, updated_at desc);
create index termul_circle_workflow_due on public.termul_circle_bridges(workflow, updated_at)
  where state in ('submitting','source-pending','destination-pending');

create or replace function public.termul_circle_bridge_update_v1(
  p_id uuid, p_wallet text, p_revision integer, p_details jsonb, p_session text default null
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  candidate public.termul_circle_bridges%rowtype;
  next_state text := p_details->>'status';
begin
  -- Lock SIWE before the bridge row, including on a competing request or revocation.
  if next_state = 'submitting' and p_session is not null then
    perform 1 from public.termul_wallet_sessions
      where token_hash = p_session and wallet_address = p_wallet
        and revoked_at is null and expires_at > clock_timestamp()
        and verified_at between clock_timestamp() - interval '5 minutes' and clock_timestamp()
      for share;
    if not found then return null; end if;
  end if;
  select * into candidate from public.termul_circle_bridges
    where id = p_id and wallet = p_wallet and revision = p_revision for update;
  if not found or next_state is null or jsonb_typeof(p_details) <> 'object' or
    (p_details - array['status','review','step','history','sourceHash','sourceMessage','destinationHash','received','fee','scanFrom','recovery'])
    is distinct from
    (candidate.details - array['status','review','step','history','sourceHash','sourceMessage','destinationHash','received','fee','scanFrom','recovery'])
  then return null; end if;
  if p_session is not null and (candidate.state <> 'ready' or next_state <> 'submitting') then return null; end if;
  if not (case candidate.state
    when 'ready' then next_state in ('ready','closed','submitting')
    when 'submitting' then next_state in ('source-pending','destination-pending','ready','reverted','rejected','submitting')
    when 'source-pending' then next_state in ('source-pending','destination-pending','ready','reverted','rejected')
    when 'destination-pending' then next_state in ('destination-pending','settled')
    else false end) then return null; end if;
  if next_state = 'submitting' and candidate.state = 'ready' and (
    p_session is null or (candidate.details->'review'->>'expiresAt')::bigint <= extract(epoch from clock_timestamp()) * 1000
    or candidate.details->'review'->>'sessionHash' is distinct from p_session
    or ((p_details->'step') - array['key','challengeId','providerHash','fromBlock'])
      is distinct from ((candidate.details->'review') - array['sessionHash','fromBlock'])
    or coalesce((p_details->'step'->>'fromBlock')::bigint, -1) < (candidate.details->'review'->>'fromBlock')::bigint
    or (p_details->'step'->>'key') is null
  ) then return null; end if;
  update public.termul_circle_bridges set
    state = next_state, details = p_details, revision = revision + 1, updated_at = statement_timestamp()
  where id = p_id returning * into candidate;
  return to_jsonb(candidate);
end;
$$;
