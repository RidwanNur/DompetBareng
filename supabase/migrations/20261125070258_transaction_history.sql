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

create or replace function public.update_history_transaction(
  p_workspace_id uuid,
  p_transaction_id uuid,
  p_item text,
  p_amount text,
  p_type text,
  p_category text,
  p_wallet_id uuid,
  p_occurred_at timestamptz
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  account_id uuid := auth.uid();
begin
  perform 1 from public.workspace_members
  where user_id = account_id and workspace_id = p_workspace_id
  for key share;
  if not found then
    return 'not_found';
  end if;

  perform 1 from public.transactions
  where id = p_transaction_id and workspace_id = p_workspace_id and created_by = account_id
  for update;
  if not found then
    return 'not_found';
  end if;

  if p_item is null or btrim(p_item) = '' or p_amount is null or length(p_amount) > 19
    or p_amount !~ '^[1-9][0-9]*$' or p_type is null or p_category is null
    or p_occurred_at is null or not isfinite(p_occurred_at) then
    return 'invalid_input';
  end if;

  perform 1 from public.wallets
  where id = p_wallet_id and workspace_id = p_workspace_id
  for key share;
  if not found then
    return 'invalid_wallet';
  end if;

  begin
    update public.transactions
    set item = btrim(p_item), amount = p_amount::bigint, type = p_type,
      category = p_category, wallet_id = p_wallet_id, occurred_at = p_occurred_at
    where id = p_transaction_id and workspace_id = p_workspace_id and created_by = account_id;
  exception
    when check_violation or numeric_value_out_of_range then
      return 'invalid_input';
  end;

  return 'updated';
end;
$$;

create or replace function public.delete_history_transaction(p_workspace_id uuid, p_transaction_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  account_id uuid := auth.uid();
begin
  perform 1 from public.workspace_members
  where user_id = account_id and workspace_id = p_workspace_id
  for key share;
  if not found then
    return 'not_found';
  end if;

  delete from public.transactions
  where id = p_transaction_id and workspace_id = p_workspace_id and created_by = account_id;

  if found then
    return 'deleted';
  end if;
  return 'not_found';
end;
$$;

revoke all on function public.get_transaction_history(uuid, text, uuid, text, text, text, timestamptz, uuid),
  public.update_history_transaction(uuid, uuid, text, text, text, text, uuid, timestamptz),
  public.delete_history_transaction(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_transaction_history(uuid, text, uuid, text, text, text, timestamptz, uuid),
  public.update_history_transaction(uuid, uuid, text, text, text, text, uuid, timestamptz),
  public.delete_history_transaction(uuid, uuid) to authenticated;
