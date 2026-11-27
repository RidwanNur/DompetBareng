create table if not exists public.ai_health_cache (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  month text not null check (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' and left(month, 4) <> '0000'),
  data_fingerprint text not null check (data_fingerprint ~ '^[a-f0-9]{64}$'),
  summary_text text not null check (length(btrim(summary_text)) between 1 and 600),
  recommendations jsonb not null,
  source text not null check (source in ('ai', 'fallback')),
  model_used text,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id, month),
  check (jsonb_typeof(recommendations) = 'array'),
  check (source = 'ai' or model_used is null),
  check (model_used is null or model_used ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$')
);

alter table public.ai_health_cache enable row level security;
revoke all on public.ai_health_cache from public, anon, authenticated, service_role;
grant select on public.ai_health_cache to authenticated;
drop policy if exists ai_health_cache_select_member on public.ai_health_cache;
create policy ai_health_cache_select_member on public.ai_health_cache
  for select to authenticated using (exists (
    select 1 from public.workspace_members as member
    where member.workspace_id = ai_health_cache.workspace_id and member.user_id = (select auth.uid())
  ));

alter table public.transactions add column if not exists updated_at timestamptz;
alter table public.transactions alter column updated_at set default clock_timestamp();

create or replace function app_private.stamp_transaction_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

drop trigger if exists stamp_transaction_update on public.transactions;
create trigger stamp_transaction_update before update on public.transactions
  for each row when (
    (old.workspace_id, old.wallet_id, old.item, old.amount, old.type, old.category, old.occurred_at)
    is distinct from
    (new.workspace_id, new.wallet_id, new.item, new.amount, new.type, new.category, new.occurred_at)
  ) execute function app_private.stamp_transaction_update();

create or replace function app_private.monthly_health_fingerprint(p_workspace_id uuid, p_month text)
returns text
language sql
stable
set search_path = ''
as $$
  with bounds as (
    select case when p_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' and left(p_month, 4) <> '0000'
      then make_date(left(p_month, 4)::integer, right(p_month, 2)::integer, 1)::timestamp end as month_start
  ), groups as (
    select entry.type, entry.category, sum(entry.amount) as total, count(*) as entry_count,
      max(entry.occurred_at) as latest_occurred_at, max(coalesce(entry.updated_at, entry.created_at)) as latest_change_at
    from public.transactions as entry cross join bounds
    where entry.workspace_id = p_workspace_id
      and entry.occurred_at >= (bounds.month_start at time zone 'Asia/Jakarta')
      and entry.occurred_at < ((bounds.month_start + interval '1 month') at time zone 'Asia/Jakarta')
    group by entry.type, entry.category
  )
  select encode(sha256(convert_to(jsonb_build_object(
    'income', coalesce(sum(groups.total) filter (where groups.type = 'income'), 0),
    'expense', coalesce(sum(groups.total) filter (where groups.type = 'expense'), 0),
    'entry_count', coalesce(sum(groups.entry_count), 0),
    'latest_transaction', extract(epoch from max(groups.latest_occurred_at)),
    'latest_change', extract(epoch from max(groups.latest_change_at)),
    'largest', (select jsonb_build_array(expense.category, expense.total) from groups as expense
      where expense.type = 'expense' order by expense.total desc, expense.category limit 1),
    'categories', coalesce(jsonb_agg(jsonb_build_array(groups.type, groups.category, groups.total)
      order by groups.type, groups.category), '[]'::jsonb)
  )::text, 'UTF8')), 'hex') from groups;
$$;

alter table public.monthly_report_analyses add column if not exists legacy_data_fingerprint text;
update public.monthly_report_analyses as cache
set legacy_data_fingerprint = app_private.monthly_health_fingerprint(cache.workspace_id, cache.month)
where cache.analysis is not null and cache.legacy_data_fingerprint is null;

-- Simpan kontrak laporan dan cache lama untuk pembaca yang sudah ada.
do $legacy_report$
begin
  if to_regprocedure('app_private.get_monthly_report_legacy(uuid,text)') is null then
    alter function public.get_monthly_report(uuid, text) set schema app_private;
    alter function app_private.get_monthly_report(uuid, text) rename to get_monthly_report_legacy;
  end if;
end;
$legacy_report$;

create or replace function public.get_monthly_report(p_workspace_id uuid, p_month text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with report as materialized (
    select app_private.get_monthly_report_legacy(p_workspace_id, p_month) as base
    where exists (
      select 1 from public.workspace_members as member
      where member.workspace_id = p_workspace_id and member.user_id = (select auth.uid())
    )
  )
  select report.base || jsonb_build_object(
    'analysis', case when cache.workspace_id is null then report.base->'analysis' else jsonb_build_object(
      'narrative', cache.summary_text, 'suggestions', cache.recommendations
    ) end,
    'analysis_source', case when cache.workspace_id is not null then cache.source
      when report.base->'analysis' <> 'null'::jsonb then 'ai' end,
    'analysis_updated_at', cache.updated_at,
    'analysis_fingerprint', fingerprint.value,
    'analysis_stale', case when cache.workspace_id is null then (report.base->>'analysis_stale')::boolean
      or (report.base->'analysis' <> 'null'::jsonb and legacy.legacy_data_fingerprint is distinct from fingerprint.value)
      else cache.data_fingerprint <> fingerprint.value end,
    'analysis_retry_at', case when cache.data_fingerprint = fingerprint.value and cache.source = 'fallback'
      then cache.updated_at + interval '5 minutes' end
  )
  from report
  cross join lateral (select app_private.monthly_health_fingerprint(p_workspace_id, p_month) as value) as fingerprint
  left join public.monthly_report_analyses as legacy on legacy.workspace_id = p_workspace_id and legacy.month = p_month
  left join public.ai_health_cache as cache on cache.workspace_id = p_workspace_id and cache.month = p_month
  where report.base is not null;
$$;

alter table public.monthly_report_analyses add column if not exists claim_user_id uuid;
alter table public.monthly_report_analyses add column if not exists claim_preserve_ai boolean not null default false;

create or replace function public.begin_monthly_analysis(p_workspace_id uuid, p_month text, p_manual boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  account_id uuid := auth.uid();
  report jsonb;
  claim uuid;
  claimed_at timestamptz;
  valid_ai boolean;
begin
  perform 1 from public.workspace_members where workspace_id = p_workspace_id and user_id = account_id for key share;
  if not found or p_month is null then return jsonb_build_object('status', 'forbidden'); end if;

  perform pg_advisory_xact_lock(hashtextextended('monthly-analysis:' || p_workspace_id::text || ':' || p_month, 0));
  report := public.get_monthly_report(p_workspace_id, p_month);
  if report is null then return jsonb_build_object('status', 'forbidden'); end if;
  if (report->>'transaction_count')::integer = 0 then return jsonb_build_object('status', 'empty', 'report', report); end if;

  claimed_at := clock_timestamp();
  valid_ai := coalesce(report->>'analysis_source' = 'ai' and not (report->>'analysis_stale')::boolean, false);
  if (not coalesce(p_manual, false) and valid_ai)
    or coalesce((report->>'analysis_retry_at')::timestamptz > claimed_at, false) then
    return jsonb_build_object('status', 'cached', 'report', report);
  end if;

  if exists (select 1 from public.monthly_report_analyses
    where workspace_id = p_workspace_id and month = p_month and claim_until > claimed_at) then
    return jsonb_build_object('status', 'busy', 'report', report);
  end if;

  if coalesce(p_manual, false) then
    insert into app_private.monthly_analysis_daily_usage as usage (workspace_id, usage_date, request_count)
    values (p_workspace_id, (claimed_at at time zone 'Asia/Jakarta')::date, 1)
    on conflict (workspace_id, usage_date) do update set request_count = usage.request_count + 1
    where usage.request_count < 5;
    if not found then return jsonb_build_object('status', 'rate_limited', 'report', report); end if;
  end if;

  claim := gen_random_uuid();
  insert into public.monthly_report_analyses (
    workspace_id, month, claim_token, claim_fingerprint, claim_until, claim_user_id, claim_preserve_ai
  ) values (
    p_workspace_id, p_month, claim, report->>'analysis_fingerprint', claimed_at + interval '120 seconds', account_id, valid_ai
  ) on conflict (workspace_id, month) do update set claim_token = excluded.claim_token,
    claim_fingerprint = excluded.claim_fingerprint, claim_until = excluded.claim_until,
    claim_user_id = excluded.claim_user_id, claim_preserve_ai = excluded.claim_preserve_ai;

  return jsonb_build_object('status', 'ready', 'claim_token', claim, 'report', report);
end;
$$;

create or replace function public.release_monthly_analysis(p_workspace_id uuid, p_month text, p_claim_token uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('monthly-analysis:' || p_workspace_id::text || ':' || p_month, 0));
  update public.monthly_report_analyses
  set claim_token = null, claim_fingerprint = null, claim_until = null, claim_user_id = null, claim_preserve_ai = false
  where workspace_id = p_workspace_id and month = p_month and claim_token = p_claim_token;
end;
$$;

create or replace function public.complete_monthly_analysis(
  p_workspace_id uuid, p_month text, p_claim_token uuid, p_analysis jsonb, p_source text, p_model_used text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  ticket public.monthly_report_analyses%rowtype;
  current_fingerprint text;
begin
  if p_source is null or p_source not in ('ai', 'fallback')
    or (p_source = 'fallback' and p_model_used is not null)
    or (p_model_used is not null and p_model_used !~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$')
    or jsonb_typeof(p_analysis) is distinct from 'object'
    or jsonb_typeof(p_analysis->'narrative') is distinct from 'string'
    or length(btrim(p_analysis->>'narrative')) not between 1 and 600
    or jsonb_typeof(p_analysis->'suggestions') is distinct from 'array' then
    return false;
  end if;
  if jsonb_array_length(p_analysis->'suggestions') not between 2 and 3 or exists (
    select 1 from jsonb_array_elements(p_analysis->'suggestions') as suggestion(value)
    where jsonb_typeof(suggestion.value) <> 'string' or length(btrim(suggestion.value #>> '{}')) not between 1 and 240
  ) then return false; end if;

  perform pg_advisory_xact_lock(hashtextextended('monthly-analysis:' || p_workspace_id::text || ':' || p_month, 0));
  select * into ticket from public.monthly_report_analyses
  where workspace_id = p_workspace_id and month = p_month and claim_token = p_claim_token
    and claim_until > clock_timestamp() for update;
  if not found then return false; end if;

  perform 1 from public.workspace_members
  where workspace_id = p_workspace_id and user_id = ticket.claim_user_id for key share;
  if not found then
    perform public.release_monthly_analysis(p_workspace_id, p_month, p_claim_token);
    return false;
  end if;
  current_fingerprint := app_private.monthly_health_fingerprint(p_workspace_id, p_month);
  if ticket.claim_fingerprint is distinct from current_fingerprint then
    perform public.release_monthly_analysis(p_workspace_id, p_month, p_claim_token);
    return false;
  end if;

  if p_source = 'ai' or not ticket.claim_preserve_ai then
    insert into public.ai_health_cache as cache (
      workspace_id, month, data_fingerprint, summary_text, recommendations, source, model_used
    ) values (
      p_workspace_id, p_month, ticket.claim_fingerprint, p_analysis->>'narrative', p_analysis->'suggestions', p_source, p_model_used
    ) on conflict (workspace_id, month) do update set data_fingerprint = excluded.data_fingerprint,
      summary_text = excluded.summary_text, recommendations = excluded.recommendations, source = excluded.source,
      model_used = excluded.model_used, updated_at = excluded.updated_at
    where excluded.source = 'ai' or cache.source <> 'ai' or cache.data_fingerprint <> excluded.data_fingerprint;
  end if;

  perform public.release_monthly_analysis(p_workspace_id, p_month, p_claim_token);
  return true;
end;
$$;

create or replace function public.complete_monthly_analysis(
  p_workspace_id uuid, p_month text, p_claim_token uuid, p_analysis jsonb
)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select public.complete_monthly_analysis(p_workspace_id, p_month, p_claim_token, p_analysis, 'ai', null);
$$;

revoke all on function app_private.get_monthly_report_legacy(uuid, text),
  app_private.stamp_transaction_update(), app_private.monthly_health_fingerprint(uuid, text),
  public.get_monthly_report(uuid, text), public.begin_monthly_analysis(uuid, text, boolean),
  public.complete_monthly_analysis(uuid, text, uuid, jsonb),
  public.complete_monthly_analysis(uuid, text, uuid, jsonb, text, text),
  public.release_monthly_analysis(uuid, text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_monthly_report(uuid, text), public.begin_monthly_analysis(uuid, text, boolean)
  to authenticated;
grant execute on function public.complete_monthly_analysis(uuid, text, uuid, jsonb),
  public.complete_monthly_analysis(uuid, text, uuid, jsonb, text, text),
  public.release_monthly_analysis(uuid, text, uuid) to service_role;
