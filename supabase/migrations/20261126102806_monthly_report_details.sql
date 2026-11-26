create or replace function public.get_transaction_history(
  p_workspace_id uuid,
  p_month text,
  p_wallet_id uuid,
  p_category text,
  p_recorder text,
  p_search text,
  p_before_at timestamptz,
  p_before_id uuid,
  p_type text
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with selected_workspace as (
    select member.workspace_id, member.user_id
    from public.workspace_members as member
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
  select jsonb_build_object(
    'workspace_id', selected.workspace_id,
    'wallets', options.wallets,
    'transactions', history.transactions,
    'next_cursor', history.next_cursor
  )
  from selected_workspace as selected
  cross join month_bounds as month
  cross join lateral (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', wallet.id, 'name', wallet.name
    ) order by wallet.name, wallet.id), '[]'::jsonb) as wallets
    from public.wallets as wallet
    where wallet.workspace_id = selected.workspace_id
  ) as options
  cross join lateral (
    with matching as (
      select entry.id, entry.item, entry.amount, entry.type, entry.category, entry.occurred_at,
        entry.wallet_id, wallet.name as wallet_name,
        case when entry.created_by = selected.user_id then 'self' else 'partner' end as recorded_by
      from public.transactions as entry
      join public.wallets as wallet
        on wallet.id = entry.wallet_id and wallet.workspace_id = entry.workspace_id
      where entry.workspace_id = selected.workspace_id
        and (p_month is null or (entry.occurred_at >= month.start_at and entry.occurred_at < month.end_at))
        and (p_wallet_id is null or entry.wallet_id = p_wallet_id)
        and (p_category is null or entry.category = p_category)
        and (p_type is null or entry.type = p_type)
        and (p_recorder is null or p_recorder =
          case when entry.created_by = selected.user_id then 'self' else 'partner' end)
        and (p_search is null or strpos(lower(entry.item), lower(p_search)) > 0)
        and (
          (p_before_at is null and p_before_id is null)
          or (p_before_at is not null and p_before_id is not null and (
            entry.occurred_at < p_before_at or (entry.occurred_at = p_before_at and entry.id > p_before_id)
          ))
        )
      order by entry.occurred_at desc, entry.id
      limit 26
    ), page as (
      select * from matching order by occurred_at desc, id limit 25
    )
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', entry.id,
      'item', entry.item,
      'amount', entry.amount::text,
      'type', entry.type,
      'category', entry.category,
      'occurred_at', entry.occurred_at,
      'recorded_by', entry.recorded_by,
      'wallet_id', entry.wallet_id,
      'wallet_name', entry.wallet_name
    ) order by entry.occurred_at desc, entry.id), '[]'::jsonb) as transactions,
      case when (select count(*) from matching) > 25 then (
        select jsonb_build_object('occurred_at', last_entry.occurred_at, 'id', last_entry.id)
        from page as last_entry
        order by last_entry.occurred_at asc, last_entry.id desc
        limit 1
      ) end as next_cursor
    from page as entry
  ) as history;
$$;

create or replace function public.get_transaction_history(
  p_workspace_id uuid,
  p_month text default null,
  p_wallet_id uuid default null,
  p_category text default null,
  p_recorder text default null,
  p_search text default null,
  p_before_at timestamptz default null,
  p_before_id uuid default null
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select public.get_transaction_history(p_workspace_id, p_month, p_wallet_id, p_category, p_recorder,
    p_search, p_before_at, p_before_id, null::text);
$$;

create or replace function public.get_monthly_report_details(p_workspace_id uuid, p_month text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  account_id uuid := auth.uid();
  workspace_type text;
  base_report jsonb;
  previous_month jsonb;
  category_stats jsonb;
  largest_expenses jsonb;
  local_today date := (statement_timestamp() at time zone 'Asia/Jakarta')::date;
  month_start date;
  month_end date;
  ceiling_month date := date_trunc('month', local_today::timestamp)::date;
  period_start timestamptz;
  period_end timestamptz;
  previous_start date;
  elapsed_days integer;
begin
  if p_month is null or p_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' or left(p_month, 4) = '0000' then
    return null;
  end if;

  select workspace.type into workspace_type
  from public.workspaces as workspace
  join public.workspace_members as member on member.workspace_id = workspace.id
  where workspace.id = p_workspace_id and member.user_id = account_id
    and (workspace.type = 'household' or workspace.owner_id = account_id);
  if not found then
    return null;
  end if;

  base_report := public.get_monthly_report(p_workspace_id, p_month);
  if base_report is null then
    return null;
  end if;

  month_start := make_date(left(p_month, 4)::integer, right(p_month, 2)::integer, 1);
  month_end := (month_start + interval '1 month')::date;
  period_start := month_start::timestamp at time zone 'Asia/Jakarta';
  period_end := month_end::timestamp at time zone 'Asia/Jakarta';
  elapsed_days := case
    when month_start > ceiling_month then 0
    when month_start = ceiling_month then extract(day from local_today)::integer
    else month_end - month_start
  end;

  if month_start > date '0001-01-01' then
    previous_start := (month_start - interval '1 month')::date;
    select jsonb_build_object(
      'month', to_char(previous_start, 'YYYY-MM'),
      'total_income', sums.income::text,
      'total_expense', sums.expense::text,
      'net_cash_flow', (sums.income - sums.expense)::text
    ) into previous_month
    from (
      select coalesce(sum(entry.amount) filter (where entry.type = 'income'), 0) as income,
        coalesce(sum(entry.amount) filter (where entry.type = 'expense'), 0) as expense
      from public.transactions as entry
      where entry.workspace_id = p_workspace_id
        and entry.occurred_at >= (previous_start::timestamp at time zone 'Asia/Jakarta')
        and entry.occurred_at < period_start
    ) as sums;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'type', category.type,
    'category', category.category,
    'transaction_count', category.transaction_count,
    'total', category.total::text,
    'percent', trim_scale(round(
      category.total * 100.000000000000000000000000000000000000 /
        nullif(case category.type when 'income' then (base_report->>'total_income')::numeric
          else (base_report->>'total_expense')::numeric end, 0), 2
    ))::text
  ) order by category.type, category.total desc, category.category), '[]'::jsonb) into category_stats
  from (
    select entry.type, entry.category, count(*)::integer as transaction_count, sum(entry.amount) as total
    from public.transactions as entry
    where entry.workspace_id = p_workspace_id
      and entry.occurred_at >= period_start and entry.occurred_at < period_end
    group by entry.type, entry.category
  ) as category;

  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'id', expense.id,
    'item', expense.item,
    'amount', expense.amount::text,
    'category', expense.category,
    'occurred_at', expense.occurred_at,
    'wallet_name', wallet.name,
    'creator_name', case
      when workspace_type <> 'household' then null
      when expense.created_by = account_id then 'Kamu'
      else app_private.telegram_first_name(profile.raw_user_meta_data)
    end
  )) order by expense.amount desc, expense.occurred_at desc, expense.created_at desc nulls last, expense.id),
    '[]'::jsonb) into largest_expenses
  from (
    select entry.id, entry.item, entry.amount, entry.category, entry.occurred_at, entry.created_at,
      entry.wallet_id, entry.created_by
    from public.transactions as entry
    where entry.workspace_id = p_workspace_id and entry.type = 'expense'
      and entry.occurred_at >= period_start and entry.occurred_at < period_end
    order by entry.amount desc, entry.occurred_at desc, entry.created_at desc nulls last, entry.id
    limit 3
  ) as expense
  join public.wallets as wallet on wallet.id = expense.wallet_id and wallet.workspace_id = p_workspace_id
  left join public.workspace_members as creator on workspace_type = 'household'
    and creator.workspace_id = p_workspace_id and creator.user_id = expense.created_by
    and creator.user_id <> account_id
  left join auth.users as profile on profile.id = creator.user_id;

  return jsonb_build_object(
    'workspace_id', p_workspace_id, 'month', p_month, 'base_report', base_report,
    'previous_month', previous_month, 'category_stats', category_stats,
    'average_daily_expense', case when elapsed_days = 0 then '0'
      else round((base_report->>'total_expense')::numeric * 1.0000 / elapsed_days)::text end,
    'largest_expenses', largest_expenses
  );
end;
$$;

revoke all on function public.get_monthly_report_details(uuid, text),
  public.get_transaction_history(uuid, text, uuid, text, text, text, timestamptz, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.get_monthly_report_details(uuid, text),
  public.get_transaction_history(uuid, text, uuid, text, text, text, timestamptz, uuid, text) to authenticated;
