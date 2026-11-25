create or replace function public.get_dashboard_summary(p_workspace_id uuid)
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
  ), local_month as (
    select date_trunc('month', statement_timestamp() at time zone 'Asia/Jakarta') as start_at
  ), month_bounds as (
    select start_at at time zone 'Asia/Jakarta' as start_at,
      (start_at + interval '1 month') at time zone 'Asia/Jakarta' as end_at
    from local_month
  )
  select jsonb_build_object(
    'workspace_id', selected.workspace_id,
    'total_balance', totals.balance,
    'total_income', totals.income,
    'total_expense', totals.expense,
    'transactions', recent.transactions
  )
  from selected_workspace as selected
  cross join month_bounds as month
  cross join lateral (
    select coalesce(sum(case entry.type when 'income' then entry.amount else -entry.amount end), 0)::text as balance,
      coalesce(sum(entry.amount) filter (
        where entry.type = 'income' and entry.occurred_at >= month.start_at and entry.occurred_at < month.end_at
      ), 0)::text as income,
      coalesce(sum(entry.amount) filter (
        where entry.type = 'expense' and entry.occurred_at >= month.start_at and entry.occurred_at < month.end_at
      ), 0)::text as expense
    from public.transactions as entry
    where entry.workspace_id = selected.workspace_id
  ) as totals
  cross join lateral (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', latest.id,
      'item', latest.item,
      'amount', latest.amount::text,
      'type', latest.type,
      'category', latest.category,
      'occurred_at', latest.occurred_at,
      'recorded_by', case when latest.created_by = selected.user_id then 'self' else 'partner' end,
      'wallet_name', wallet.name
    ) order by latest.occurred_at desc, latest.id), '[]'::jsonb) as transactions
    from (
      select entry.id, entry.item, entry.amount, entry.type, entry.category,
        entry.occurred_at, entry.created_by, entry.wallet_id
      from public.transactions as entry
      where entry.workspace_id = selected.workspace_id
      order by entry.occurred_at desc, entry.id
      limit 5
    ) as latest
    join public.wallets as wallet on wallet.id = latest.wallet_id and wallet.workspace_id = selected.workspace_id
  ) as recent;
$$;

revoke all on function public.get_dashboard_summary(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_dashboard_summary(uuid) to authenticated;
