#!/usr/bin/env bash
# Apply migrations only to the disposable PostgreSQL cluster created here.
set -euo pipefail
cd "$(dirname "$0")/.."
pgbin="$(pg_config --bindir)"
work="$(mktemp -d /tmp/termul-wallet-postgres.XXXXXX)"
"$pgbin/initdb" -D "$work/db" -A trust --no-locale >/dev/null
"$pgbin/pg_ctl" -D "$work/db" -o "-k $work -c listen_addresses='' -p 55362" -l "$work/server.log" start >/dev/null
trap '"$pgbin/pg_ctl" -D "$work/db" -m fast stop >/dev/null' EXIT
export PGHOST="$work" PGPORT=55362 PGDATABASE=postgres PGUSER="$(id -un)"
db() { env -u PGSERVICE -u PGHOSTADDR "$pgbin/psql" -X -v ON_ERROR_STOP=1 "$@"; }

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
