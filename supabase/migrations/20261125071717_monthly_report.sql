create table if not exists public.monthly_report_analyses (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  month text not null check (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' and left(month, 4) <> '0000'),
  analysis jsonb,
  analysis_fingerprint text,
  claim_token uuid,
  claim_fingerprint text,
  claim_until timestamptz,
  primary key (workspace_id, month),
  check ((analysis is null) = (analysis_fingerprint is null)),
  check ((claim_token is null) = (claim_fingerprint is null)),
  check ((claim_token is null) = (claim_until is null))
);

alter table public.monthly_report_analyses enable row level security;
revoke all on public.monthly_report_analyses from public, anon, authenticated, service_role;
grant select (workspace_id, month, analysis, analysis_fingerprint)
  on public.monthly_report_analyses to authenticated;

drop policy if exists monthly_report_analyses_select_member on public.monthly_report_analyses;
create policy monthly_report_analyses_select_member on public.monthly_report_analyses
  for select to authenticated using (analysis is not null and exists (
    select 1 from public.workspace_members as member
    where member.workspace_id = monthly_report_analyses.workspace_id and member.user_id = (select auth.uid())
  ));

create table if not exists app_private.monthly_analysis_daily_usage (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  usage_date date not null,
  request_count smallint not null check (request_count between 1 and 5),
  primary key (workspace_id, usage_date)
);

alter table app_private.monthly_analysis_daily_usage enable row level security;
revoke all on app_private.monthly_analysis_daily_usage from public, anon, authenticated, service_role;

create or replace function public.get_monthly_report(p_workspace_id uuid, p_month text)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with selected_workspace as (
    select member.workspace_id from public.workspace_members as member
    where member.workspace_id = p_workspace_id and member.user_id = (select auth.uid())
  ), requested_month as (
    select case
      when p_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' and left(p_month, 4) <> '0000'
      then make_date(left(p_month, 4)::integer, right(p_month, 2)::integer, 1)::timestamp
    end as start_at
  ), month_bounds as (
    select start_at at time zone 'Asia/Jakarta' as start_at,
      (start_at + interval '1 month') at time zone 'Asia/Jakarta' as end_at
    from requested_month
  )
  select report.summary || jsonb_build_object(
    'analysis', cache.analysis,
    'analysis_stale', coalesce(
      cache.analysis_fingerprint <> encode(sha256(convert_to(report.summary::text, 'UTF8')), 'hex'), false
    )
  )
  from selected_workspace as selected
  cross join month_bounds as month
  cross join lateral (
    with category_sums as (
      select entry.type, entry.category, sum(entry.amount) as total, count(*) as transaction_count
      from public.transactions as entry
      where entry.workspace_id = selected.workspace_id
        and entry.occurred_at >= month.start_at and entry.occurred_at < month.end_at
      group by entry.type, entry.category
    )
    select coalesce(sum(category.transaction_count), 0)::integer as transaction_count,
      coalesce(sum(category.total) filter (where category.type = 'income'), 0) as income,
      coalesce(sum(category.total) filter (where category.type = 'expense'), 0) as expense,
      coalesce(jsonb_agg(jsonb_build_object(
        'type', category.type,
        'category', category.category,
        'total', category.total::text
      ) order by category.type, category.total desc, category.category), '[]'::jsonb) as category_totals,
      (
        select jsonb_build_object('category', expense.category, 'total', expense.total::text)
        from category_sums as expense
        where expense.type = 'expense'
        order by expense.total desc, expense.category
        limit 1
      ) as largest_expense
    from category_sums as category
  ) as totals
  cross join lateral (
    select coalesce(jsonb_agg(jsonb_build_object(
      'wallet_id', balances.id,
      'wallet_name', balances.name,
      'balance', balances.balance
    ) order by balances.name, balances.id), '[]'::jsonb) as wallet_balances
    from (
      select wallet.id, wallet.name,
        coalesce(sum(case entry.type when 'income' then entry.amount else -entry.amount end), 0)::text as balance
      from public.wallets as wallet
      left join public.transactions as entry on entry.wallet_id = wallet.id
        and entry.workspace_id = wallet.workspace_id and entry.occurred_at < month.end_at
      where wallet.workspace_id = selected.workspace_id
      group by wallet.id, wallet.name
    ) as balances
  ) as wallets
  cross join lateral (
    select jsonb_build_object(
      'workspace_id', selected.workspace_id,
      'month', p_month,
      'transaction_count', totals.transaction_count,
      'total_income', totals.income::text,
      'total_expense', totals.expense::text,
      'net_cash_flow', (totals.income - totals.expense)::text,
      'expense_ratio_percent', trim_scale(round(
        totals.expense * 100.000000000000000000000000000000000000 / nullif(totals.income, 0), 2
      ))::text,
      'health_status', case
        when totals.income = 0 and totals.expense = 0 then 'Belum Ada Data'
        when totals.expense > totals.income then 'Defisit'
        when totals.expense * 100 <= totals.income * 70 then 'Sehat'
        else 'Waspada'
      end,
      'largest_expense', totals.largest_expense,
      'category_totals', totals.category_totals,
      'wallet_balances', wallets.wallet_balances
    ) as summary
  ) as report
  left join public.monthly_report_analyses as cache
    on cache.workspace_id = selected.workspace_id and cache.month = p_month
  where month.start_at is not null;
$$;

create or replace function public.begin_monthly_analysis(
  p_workspace_id uuid, p_month text, p_manual boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  account_id uuid := auth.uid();
  is_manual boolean := coalesce(p_manual, false);
  report jsonb;
  claim uuid;
  claimed_at timestamptz;
  fingerprint text;
begin
  perform 1 from public.workspace_members
  where workspace_id = p_workspace_id and user_id = account_id
  for key share;
  if not found or p_month is null then
    return jsonb_build_object('status', 'forbidden');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('monthly-analysis:' || p_workspace_id::text || ':' || p_month, 0));
  report := public.get_monthly_report(p_workspace_id, p_month);
  if report is null then
    return jsonb_build_object('status', 'forbidden');
  end if;
  if (report->>'transaction_count')::integer = 0 then
    return jsonb_build_object('status', 'empty');
  end if;
  if not is_manual and report->'analysis' <> 'null'::jsonb then
    return jsonb_build_object('status', 'cached');
  end if;

  claimed_at := clock_timestamp();
  if exists (
    select 1 from public.monthly_report_analyses
    where workspace_id = p_workspace_id and month = p_month and claim_until > claimed_at
  ) then
    return jsonb_build_object('status', 'busy');
  end if;

  if is_manual then
    insert into app_private.monthly_analysis_daily_usage as usage (workspace_id, usage_date, request_count)
    values (p_workspace_id, (claimed_at at time zone 'Asia/Jakarta')::date, 1)
    on conflict (workspace_id, usage_date) do update set request_count = usage.request_count + 1
    where usage.request_count < 5;
    if not found then
      return jsonb_build_object('status', 'rate_limited');
    end if;
  end if;

  claim := gen_random_uuid();
  fingerprint := encode(sha256(convert_to((report - 'analysis' - 'analysis_stale')::text, 'UTF8')), 'hex');
  insert into public.monthly_report_analyses (workspace_id, month, claim_token, claim_fingerprint, claim_until)
  values (p_workspace_id, p_month, claim, fingerprint, claimed_at + interval '120 seconds')
  on conflict (workspace_id, month) do update set claim_token = excluded.claim_token,
    claim_fingerprint = excluded.claim_fingerprint, claim_until = excluded.claim_until;

  return jsonb_build_object('status', 'ready', 'claim_token', claim, 'report', report);
end;
$$;

create or replace function public.complete_monthly_analysis(
  p_workspace_id uuid, p_month text, p_claim_token uuid, p_analysis jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if jsonb_typeof(p_analysis) is distinct from 'object'
    or jsonb_typeof(p_analysis->'narrative') is distinct from 'string'
    or btrim(p_analysis->>'narrative') = ''
    or jsonb_typeof(p_analysis->'suggestions') is distinct from 'array' then
    return false;
  end if;
  if jsonb_array_length(p_analysis->'suggestions') not between 2 and 3 or exists (
    select 1 from jsonb_array_elements(p_analysis->'suggestions') as suggestion(value)
    where jsonb_typeof(suggestion.value) <> 'string' or btrim(suggestion.value #>> '{}') = ''
  ) then
    return false;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('monthly-analysis:' || p_workspace_id::text || ':' || p_month, 0));
  update public.monthly_report_analyses set
    analysis = jsonb_build_object('narrative', p_analysis->'narrative', 'suggestions', p_analysis->'suggestions'),
    analysis_fingerprint = claim_fingerprint,
    claim_token = null, claim_fingerprint = null, claim_until = null
  where workspace_id = p_workspace_id and month = p_month
    and claim_token = p_claim_token and claim_until > clock_timestamp();

  return found;
end;
$$;

create or replace function public.release_monthly_analysis(
  p_workspace_id uuid, p_month text, p_claim_token uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('monthly-analysis:' || p_workspace_id::text || ':' || p_month, 0));
  update public.monthly_report_analyses
  set claim_token = null, claim_fingerprint = null, claim_until = null
  where workspace_id = p_workspace_id and month = p_month and claim_token = p_claim_token;
end;
$$;

revoke all on function public.get_monthly_report(uuid, text), public.begin_monthly_analysis(uuid, text, boolean),
  public.complete_monthly_analysis(uuid, text, uuid, jsonb), public.release_monthly_analysis(uuid, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_monthly_report(uuid, text), public.begin_monthly_analysis(uuid, text, boolean)
  to authenticated;
grant execute on function public.complete_monthly_analysis(uuid, text, uuid, jsonb),
  public.release_monthly_analysis(uuid, text, uuid) to service_role;
