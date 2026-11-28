#!/usr/bin/env bash
# Apply migrations only to the disposable PostgreSQL cluster created here.
set -euo pipefail
cd "$(dirname "$0")/.."
pgbin="$(pg_config --bindir)"
work="$(mktemp -d "$PWD/.env.postgres.XXXXXX")"
"$pgbin/initdb" -D "$work/db" -A trust --no-locale >/dev/null
"$pgbin/pg_ctl" -D "$work/db" -o "-k $work -c listen_addresses='' -p 55362" -l "$work/server.log" start >/dev/null
trap '"$pgbin/pg_ctl" -D "$work/db" -m fast stop >/dev/null && rm -rf -- "$work"' EXIT
export PGHOST="$work" PGPORT=55362 PGDATABASE=postgres PGUSER="$(id -un)"
db() { env -u PGSERVICE -u PGHOSTADDR -u PGOPTIONS "$pgbin/psql" -X -v ON_ERROR_STOP=1 "$@"; }

db >/dev/null <<'SQL'
create role anon;
create role authenticated;
create role service_role bypassrls;
create table public.merchant_invoices(id integer);
insert into public.merchant_invoices values (7);
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
SQL
for migration in supabase/migrations/*.sql; do db -f "$migration" >/dev/null; done

db >/dev/null <<'SQL'
do $$
begin
  if (select id from public.merchant_invoices) <> 7 then raise exception 'Legacy table changed'; end if;
  if (select count(*) from pg_class where relname like 'termul_wallet_%' and relkind = 'r' and relrowsecurity) <> 6 then
    raise exception 'RLS missing';
  end if;
  if has_table_privilege('anon','public.termul_wallet_invoices','SELECT')
    or has_table_privilege('authenticated','public.termul_wallet_sessions','SELECT')
    or has_function_privilege('anon','public.termul_wallet_confirm_v1(text,text,text,text)','EXECUTE')
    or has_table_privilege('service_role','public.termul_wallet_payment_attempts','TRUNCATE') then
    raise exception 'Unexpected database grant';
  end if;
end
$$;
set role service_role;
insert into public.termul_wallet_challenges(token_hash,message_hash,wallet_address,expires_at) values
 (repeat('a',64),repeat('b',64),'0x'||repeat('c',40),now()+interval '1 minute'),
 (repeat('d',64),repeat('b',64),'0x'||repeat('c',40),now()-interval '1 minute');
do $$
begin
  if public.termul_wallet_confirm_v1(repeat('d',64),repeat('b',64),'0x'||repeat('c',40),repeat('e',64)) then
    raise exception 'Expired challenge accepted';
  end if;
  if not public.termul_wallet_rate_v1('fixture',1) or public.termul_wallet_rate_v1('fixture',1) then
    raise exception 'Unexpected rate limit result';
  end if;
end
$$;
SQL

single_winner() {
  local first="$1" second="$2"
  db -At -c "set role service_role; select $first" > "$work/first" &
  local first_pid=$!
  db -At -c "set role service_role; select $second" > "$work/second" &
  local second_pid=$!
  wait "$first_pid" "$second_pid"
  test "$(cat "$work/first" "$work/second" | rg '^[tf]$' | sort | paste -sd,)" = f,t
}
single_winner \
  "public.termul_wallet_confirm_v1(repeat('a',64),repeat('b',64),'0x'||repeat('c',40),repeat('e',64))" \
  "public.termul_wallet_confirm_v1(repeat('a',64),repeat('b',64),'0x'||repeat('c',40),repeat('f',64))"
single_winner \
  "public.termul_wallet_reserve_v1('0x'||repeat('a',40),'0x'||repeat('b',64),'0x'||repeat('c',40),'00000000-0000-4000-8000-000000000001')" \
  "public.termul_wallet_reserve_v1('0x'||repeat('a',40),'0x'||repeat('b',64),'0x'||repeat('c',40),'00000000-0000-4000-8000-000000000002')"
printf 'Local PostgreSQL migrations, RLS, grants, expiry, rate limit, and single-winner challenge and reservation tests passed.\n'

db >/dev/null <<'SQL'
do $$
begin
  if not (select relrowsecurity from pg_class where oid='public.termul_circle_bridges'::regclass)
    or has_table_privilege('anon','public.termul_circle_bridges','SELECT')
    or has_table_privilege('authenticated','public.termul_circle_bridges','UPDATE')
    or has_table_privilege('service_role','public.termul_circle_bridges','DELETE')
    or has_function_privilege('anon','public.termul_circle_bridge_update_v1(uuid,text,integer,jsonb,text)','EXECUTE')
  then raise exception 'Unexpected Circle bridge permission'; end if;
end $$;
set role anon;
do $$
begin
  perform * from public.termul_circle_bridges;
  raise exception 'Public bridge read was accepted';
exception when insufficient_privilege then null;
end $$;
reset role;
set role authenticated;
do $$
begin
  perform public.termul_circle_bridge_update_v1(gen_random_uuid(),'0x'||repeat('c',40),0,'{}');
  raise exception 'Public bridge update was accepted';
exception when insufficient_privilege then null;
end $$;
reset role;
set role service_role;
insert into public.termul_wallet_sessions(token_hash,wallet_address,expires_at)
values (repeat('7',64),'0x'||repeat('c',40),now()+interval '2 minutes');
insert into public.termul_circle_bridges(id,wallet,state,details) values
 ('006767cc-5236-48da-8db9-2b17834e2e42','0x'||repeat('c',40),'ready',
  jsonb_build_object('status','ready','walletAddress','0x'||repeat('c',40),'amount','10000000','history','[]'::jsonb,
    'review',jsonb_build_object('sessionHash',repeat('7',64),'fromBlock','100','expiresAt',(extract(epoch from now())*1000)::bigint+45000,'phase','burn')));
do $$
declare
  route public.termul_circle_bridges%rowtype;
  next jsonb;
begin
  select * into strict route from public.termul_circle_bridges;
  next := (route.details - 'review') || jsonb_build_object('status','submitting','step',
    ((route.details->'review') - 'sessionHash') || jsonb_build_object('key',gen_random_uuid()));
  if public.termul_circle_bridge_update_v1(route.id,route.wallet,0,next,null) is not null
    or public.termul_circle_bridge_update_v1(route.id,'0x'||repeat('b',40),0,next,repeat('7',64)) is not null
    or public.termul_circle_bridge_update_v1(route.id,route.wallet,0,next||'{"amount":"90000000"}',repeat('7',64)) is not null
    or public.termul_circle_bridge_update_v1(route.id,route.wallet,0,next||'{"status":"settled"}',null) is not null
  then raise exception 'Unauthenticated or invalid bridge transition'; end if;
  begin
    insert into public.termul_circle_bridges(id,wallet,state,details) values (gen_random_uuid(),route.wallet,'ready','{}');
    raise exception 'Duplicate open route accepted';
  exception when unique_violation then null;
  end;
end $$;
SQL

claim="set role service_role; select public.termul_circle_bridge_update_v1(id,wallet,revision,
  (details - 'review') || jsonb_build_object('status','submitting','step',((details->'review') - 'sessionHash') ||
  jsonb_build_object('key',gen_random_uuid())),repeat('7',64)) is not null from public.termul_circle_bridges"
db -At -c "$claim" > "$work/bridge-first" &
bridge_first=$!
db -At -c "$claim" > "$work/bridge-second" &
bridge_second=$!
wait "$bridge_first" "$bridge_second"
test "$(cat "$work/bridge-first" "$work/bridge-second" | rg '^[tf]$' | sort | paste -sd,)" = f,t

"$pgbin/pg_ctl" -D "$work/db" -m fast -o "-k $work -c listen_addresses='' -p 55362" restart >/dev/null

db >/dev/null <<'SQL'
set role service_role;
do $$
declare
  route public.termul_circle_bridges%rowtype;
  transition jsonb;
begin
  select * into strict route from public.termul_circle_bridges;
  if route.state <> 'submitting' or route.revision <> 1 or route.details->'step'->>'key' is null then
    raise exception 'Durable bridge reservation missing after reconnect';
  end if;
  transition := public.termul_circle_bridge_update_v1(route.id,route.wallet,route.revision,
    route.details||'{"status":"destination-pending","sourceHash":"synthetic-source"}',null);
  if transition->>'state' is distinct from 'destination-pending' then raise exception 'Recovery transition failed'; end if;
  if public.termul_circle_bridge_update_v1(route.id,route.wallet,route.revision,route.details||'{"status":"reverted"}',null) is not null
  then raise exception 'Stale revision clobbered recovered route'; end if;
  transition := public.termul_circle_bridge_update_v1(route.id,route.wallet,2,
    (transition->'details')||'{"status":"settled","destinationHash":"synthetic-mint"}',null);
  if transition->>'state' is distinct from 'settled' then raise exception 'Settlement transition failed'; end if;
end $$;
SQL
printf 'Circle bridge RLS, grants, wallet scope, competing claims, durable recovery and stale revision tests passed.\n'

db >/dev/null <<'SQL'
set role service_role;
do $$
declare
  wallet text := '0x'||repeat('c',40);
  owner_key text := repeat('8',64);
  session_key text := repeat('7',64);
  invoice_review uuid := gen_random_uuid();
  swap_review uuid := gen_random_uuid();
  common jsonb;
  invoice jsonb;
  swap jsonb;
  recovered jsonb;
begin
  common := jsonb_build_object('walletAddress',wallet,'walletId',gen_random_uuid(),'chainId',5042,
    'gasLimit','100000','maxFeePerGas','25000000000','priorityFeePerGas','1000000000');
  invoice := common||jsonb_build_object('kind','app-creation','merchant',wallet,'invoiceId','0x'||repeat('a',64),
    'amountBase','10000000000000000','expiresAt','1800000000','calldataHash','0x'||repeat('b',64));
  swap := common||jsonb_build_object('kind','arc-swap','phase','swap','from','USDC','to','EURC','target',wallet,
    'amount','10000000','minimum','8000000','calldataHash','0x'||repeat('d',64),'budget','2500000000000000',
    'q',jsonb_build_object('id','0x'||repeat('e',64),'integrator','termul'));
  insert into public.termul_circle_reviews(review_id,owner_hash,expires_at,review) values
    (invoice_review,owner_key,now()+interval '1 minute',invoice),(swap_review,owner_key,now()+interval '1 minute',swap);
  invoice := invoice||jsonb_build_object('idempotencyKey',gen_random_uuid(),'status','requesting');
  swap := (swap - array['calldataHash','budget','q']) || jsonb_build_object('dataHash','0x'||repeat('d',64),
    'id','0x'||repeat('e',64),'invoiceId','0x'||repeat('e',64),'integrator','termul','account',wallet,
    'idempotencyKey',gen_random_uuid(),'status','requesting');
  if not public.termul_circle_reserve_v1(owner_key,invoice_review,invoice,session_key)
    or public.termul_circle_reserve_v1(owner_key,invoice_review,invoice,session_key)
    or public.termul_circle_reserve_v1(owner_key,swap_review,swap,session_key)
  then raise exception 'Managed invoice journal reservation is not exclusive'; end if;
  recovered := public.termul_circle_update_v1(invoice,invoice||'{"status":"verified"}');
  if recovered->>'status' is distinct from 'verified' then raise exception 'Managed invoice journal recovery failed'; end if;
  if not public.termul_circle_reserve_v1(owner_key,swap_review,swap,session_key) then
    raise exception 'Managed swap journal reservation failed';
  end if;
  recovered := public.termul_circle_update_v1(swap,swap||'{"status":"verified","received":"8100000"}');
  if recovered->>'received' is distinct from '8100000' then raise exception 'Managed swap journal recovery failed'; end if;
end $$;
SQL
printf 'Hosted managed invoice and swap journal reservation, expiry scope and recovery passed.\n'

db >/dev/null <<'SQL'
set role service_role;
do $$
declare
  owner text := '0x'||repeat('c',40);
  route_id uuid := gen_random_uuid();
  route public.termul_circle_bridges%rowtype;
  review jsonb := jsonb_build_object('sessionHash',repeat('7',64),'fromBlock','100','expiresAt',
    (extract(epoch from now())*1000)::bigint+45000,'phase','transfer','plan',jsonb_build_object('fromChain',8453,'toChain',10));
  metadata jsonb;
  saved jsonb;
begin
  metadata := jsonb_build_object('status','ready','walletAddress',owner,'fromChain',8453,'toChain',10,'amount','10000000','review',review);
  insert into public.termul_circle_bridges(id,workflow,wallet,state,details)
    values(route_id,'lifi',owner,'ready',metadata);
  begin
    insert into public.termul_circle_bridges(id,workflow,wallet,state,details) values(gen_random_uuid(),'cctp',owner,'ready','{}');
    raise exception 'A CCTP route bypassed the LI.FI reservation';
  exception when unique_violation then null;
  end;
  saved := public.termul_circle_bridge_update_v1(route_id,owner,0,
    metadata||jsonb_build_object('status','submitting','step',(review-'sessionHash')||jsonb_build_object('key',gen_random_uuid())),
    repeat('7',64));
  if saved->>'workflow' <> 'lifi' or saved->>'state' is distinct from 'submitting' then
    raise exception 'LI.FI reservation failed';
  end if;
  select * into strict route from public.termul_circle_bridges where id=route_id and workflow='lifi';
  saved := public.termul_circle_bridge_update_v1(route.id,route.wallet,route.revision,
     route.details||'{"status":"destination-pending","sourceHash":"source-fixture"}');
  saved := public.termul_circle_bridge_update_v1(route.id,route.wallet,route.revision+1,
     (saved->'details')||'{"recovery":"refund-reported"}');
  if saved->>'state' is distinct from 'destination-pending' or (saved->'details'->>'recovery') is distinct from 'refund-reported'
    then raise exception 'Refund hint released the LI.FI reservation'; end if;
  if public.termul_circle_bridge_update_v1(route.id,route.wallet,route.revision,route.details||'{"status":"rejected"}') is not null
    then raise exception 'Stale LI.FI recovery write was permitted'; end if;
end $$;
SQL
printf 'LI.FI/CCTP wallet exclusivity and durable unresolved refund state passed.\n'

db >/dev/null <<'SQL'
set role service_role;
insert into public.termul_wallet_sessions(token_hash,wallet_address,expires_at)
values(repeat('9',64),'0x'||repeat('d',40),now()+interval '2 minutes');
insert into public.termul_circle_bridges(id,workflow,wallet,state,details) values
  ('006767cc-5236-48da-8db9-2b17834e2e49','lifi','0x'||repeat('d',40),'ready',
    jsonb_build_object('status','ready','amount','10000000','walletAddress','0x'||repeat('d',40),
      'review',jsonb_build_object('fromBlock','100','sessionHash',repeat('9',64),'phase','transfer',
      'expiresAt',(extract(epoch from now())*1000)::bigint+45000)));
SQL
lifi_claim="(select public.termul_circle_bridge_update_v1(id,wallet,revision,
  details||jsonb_build_object('status','submitting','step',((details->'review')-'sessionHash')||jsonb_build_object('key',gen_random_uuid())),
  repeat('9',64)) is not null from public.termul_circle_bridges where id='006767cc-5236-48da-8db9-2b17834e2e49')"
single_winner "$lifi_claim" "$lifi_claim"
"$pgbin/pg_ctl" -D "$work/db" -m fast -o "-k $work -c listen_addresses='' -p 55362" restart >/dev/null
test "$(db -At -c "select state||':'||revision from public.termul_circle_bridges where id='006767cc-5236-48da-8db9-2b17834e2e49'")" = submitting:1
printf 'Concurrent LI.FI step reservation survived a PostgreSQL restart with one winner.\n'
