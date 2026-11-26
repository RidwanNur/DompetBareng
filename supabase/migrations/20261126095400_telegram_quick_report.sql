alter table public.transactions add column if not exists created_at timestamptz;
alter table public.transactions alter column created_at set default clock_timestamp();

create index if not exists transactions_by_workspace_recorded_date
  on public.transactions (workspace_id, occurred_at desc, created_at desc nulls last, id);

create or replace function app_private.telegram_first_name(p_metadata jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select coalesce((
    select first_name.value
    from (values
      (1, p_metadata->'full_name'), (2, p_metadata->'name'), (3, p_metadata->'display_name')
    ) as metadata(priority, value)
    cross join lateral (
      select split_part(btrim(regexp_replace(metadata.value #>> '{}', '[[:space:]]+', ' ', 'g')), ' ', 1)
        as value
    ) as first_name
    where jsonb_typeof(metadata.value) = 'string'
      and first_name.value ~ '^[[:alpha:]][[:alpha:].''’-]{0,39}$'
      and lower(first_name.value) <> 'kamu'
    order by metadata.priority
    limit 1
  ), 'Pasangan');
$$;

create or replace function public.get_telegram_quick_report(
  p_telegram_user_id bigint, p_workspace_type text, p_view text, p_month text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  account_id uuid;
  active_workspace_id uuid;
  selected_workspace_id uuid;
  selected_workspace_type text;
  result jsonb;
  local_date date;
  period_start timestamptz;
  period_end timestamptz;
  view_data jsonb;
begin
  if p_view is null or p_view not in ('balance', 'history', 'today', 'monthly')
    or (p_workspace_type is not null and p_workspace_type not in ('personal', 'household'))
    or (p_view = 'monthly' and (
      p_month is null or p_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' or left(p_month, 4) = '0000'
    )) then
    return jsonb_build_object('status', 'invalid_input');
  end if;

  select link.user_id into account_id from app_private.telegram_links as link
  where link.telegram_user_id = p_telegram_user_id;
  if not found then
    return jsonb_build_object('status', 'unlinked');
  end if;

  if p_workspace_type is null then
    select coalesce(
      (select selection.workspace_id from app_private.active_workspaces as selection where selection.user_id = account_id),
      (select workspace.id from public.workspaces as workspace
        where workspace.owner_id = account_id and workspace.type = 'personal')
    ) into active_workspace_id;
  end if;

  select workspace.id, workspace.type into selected_workspace_id, selected_workspace_type
  from public.workspace_members as member
  join public.workspaces as workspace on workspace.id = member.workspace_id
  where member.user_id = account_id
    and (workspace.type = 'household' or workspace.owner_id = account_id)
    and case when p_workspace_type is null then workspace.id = active_workspace_id
      else workspace.type = p_workspace_type end;
  if not found then
    return jsonb_build_object('status', 'workspace_unavailable');
  end if;

  result := jsonb_build_object('status', 'ok', 'workspace_type', selected_workspace_type, 'has_household', exists (
    select 1 from public.workspace_members as member
    join public.workspaces as workspace on workspace.id = member.workspace_id
    where member.user_id = account_id and workspace.type = 'household'
  ));

  if p_view = 'balance' then
    with wallet_balances as (
      select wallet.id, wallet.name, wallet.type, wallet.archived_at,
        coalesce(opening.amount, 0)::numeric + movements.net as balance
      from public.wallets as wallet
      left join lateral (
        select snapshot.amount from public.wallet_opening_balances as snapshot
        where snapshot.wallet_id = wallet.id and snapshot.workspace_id = selected_workspace_id
        order by snapshot.effective_at desc, snapshot.id desc
        limit 1
      ) as opening on true
      cross join lateral (
        select coalesce(sum(movement.amount), 0) as net from (
          select case entry.type when 'income' then entry.amount else -entry.amount end as amount
          from public.transactions as entry
          where entry.wallet_id = wallet.id and entry.workspace_id = selected_workspace_id
          union all
          select transfer.amount from public.wallet_transfers as transfer
          where transfer.to_wallet_id = wallet.id and transfer.workspace_id = selected_workspace_id
          union all
          select -transfer.amount from public.wallet_transfers as transfer
          where transfer.from_wallet_id = wallet.id and transfer.workspace_id = selected_workspace_id
        ) as movement
      ) as movements
      where wallet.workspace_id = selected_workspace_id
    )
    select jsonb_build_object(
      'total_balance', coalesce(sum(wallet.balance), 0)::text,
      'wallets', coalesce(jsonb_agg(jsonb_build_object(
        'name', wallet.name, 'type', wallet.type, 'balance', wallet.balance::text
      ) order by wallet.name, wallet.id) filter (where wallet.archived_at is null), '[]'::jsonb)
    ) into view_data
    from wallet_balances as wallet;
    return result || view_data;
  end if;

  if p_view in ('history', 'today') then
    if p_view = 'today' then
      local_date := (statement_timestamp() at time zone 'Asia/Jakarta')::date;
      period_start := local_date::timestamp at time zone 'Asia/Jakarta';
      period_end := (local_date + 1)::timestamp at time zone 'Asia/Jakarta';
      select jsonb_build_object(
        'date', to_char(local_date, 'YYYY-MM-DD'),
        'transaction_count', count(*)::integer,
        'total_expense', coalesce(sum(entry.amount), 0)::text
      ) into view_data
      from public.transactions as entry
      where entry.workspace_id = selected_workspace_id and entry.type = 'expense'
        and entry.occurred_at >= period_start and entry.occurred_at < period_end;
      result := result || view_data;
    end if;

    select jsonb_build_object('transactions', coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
      'item', recent.item, 'amount', recent.amount::text, 'type', recent.type, 'occurred_at', recent.occurred_at,
      'wallet_name', wallet.name, 'creator_name', case
        when selected_workspace_type <> 'household' then null
        when recent.created_by = account_id then 'Kamu'
        else app_private.telegram_first_name(profile.raw_user_meta_data)
      end
    )) order by recent.occurred_at desc, recent.created_at desc nulls last, recent.id), '[]'::jsonb)) into view_data
    from (
      select entry.id, entry.item, entry.amount, entry.type, entry.occurred_at, entry.created_at, entry.created_by, entry.wallet_id
      from public.transactions as entry
      where entry.workspace_id = selected_workspace_id and (
        p_view = 'history' or (
          entry.type = 'expense' and entry.occurred_at >= period_start and entry.occurred_at < period_end
        )
      )
      order by entry.occurred_at desc, entry.created_at desc nulls last, entry.id
      limit 5
    ) as recent
    join public.wallets as wallet on wallet.id = recent.wallet_id and wallet.workspace_id = selected_workspace_id
    left join public.workspace_members as creator on selected_workspace_type = 'household'
      and creator.workspace_id = selected_workspace_id and creator.user_id = recent.created_by
      and creator.user_id <> account_id
    left join auth.users as profile on profile.id = creator.user_id;
    return result || view_data;
  end if;

  local_date := make_date(left(p_month, 4)::integer, right(p_month, 2)::integer, 1);
  period_start := local_date::timestamp at time zone 'Asia/Jakarta';
  period_end := (local_date + interval '1 month') at time zone 'Asia/Jakarta';

  with scoped_entries as (
    select entry.type, entry.amount, entry.category, entry.created_by
    from public.transactions as entry
    where entry.workspace_id = selected_workspace_id
      and entry.occurred_at >= period_start and entry.occurred_at < period_end
  ), totals as (
    select coalesce(sum(entry.amount) filter (where entry.type = 'income'), 0) as income,
      coalesce(sum(entry.amount) filter (where entry.type = 'expense'), 0) as expense
    from scoped_entries as entry
  ), top_expenses as (
    select entry.category, sum(entry.amount) as total
    from scoped_entries as entry
    where entry.type = 'expense'
    group by entry.category
    order by total desc, entry.category
    limit 3
  )
  select jsonb_build_object(
    'month', p_month,
    'total_income', totals.income::text,
    'total_expense', totals.expense::text,
    'net_cash_flow', (totals.income - totals.expense)::text,
    'savings_ratio_percent', trim_scale(round(
      (totals.income - totals.expense) * 100.000000000000000000000000000000000000 / nullif(totals.income, 0), 2
    ))::text,
    'top_expenses', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'category', category.category, 'total', category.total::text,
        'percent', trim_scale(round(
          category.total * 100.000000000000000000000000000000000000 / nullif(totals.expense, 0), 2
        ))::text
      ) order by category.total desc, category.category), '[]'::jsonb)
      from top_expenses as category
    )
  ) || case when selected_workspace_type = 'household' then jsonb_build_object('members', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'name', case when member.user_id = account_id then 'Kamu'
        else app_private.telegram_first_name(profile.raw_user_meta_data) end,
      'total_income', member_totals.income::text,
      'total_expense', member_totals.expense::text
    ) order by (member.user_id = account_id) desc, member.user_id), '[]'::jsonb)
    from public.workspace_members as member
    left join auth.users as profile on profile.id = member.user_id and member.user_id <> account_id
    cross join lateral (
      select coalesce(sum(entry.amount) filter (where entry.type = 'income'), 0) as income,
        coalesce(sum(entry.amount) filter (where entry.type = 'expense'), 0) as expense
      from scoped_entries as entry
      where entry.created_by = member.user_id
    ) as member_totals
    where member.workspace_id = selected_workspace_id
  )) else '{}'::jsonb end into view_data
  from totals;

  return result || view_data;
end;
$$;

revoke all on function app_private.telegram_first_name(jsonb),
  public.get_telegram_quick_report(bigint, text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.get_telegram_quick_report(bigint, text, text, text) to service_role;
