alter table public.wallets add column if not exists archived_at timestamptz;

create table if not exists public.wallet_opening_balances (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  wallet_id uuid not null,
  created_by uuid not null references auth.users(id) on delete cascade,
  amount bigint not null,
  effective_at timestamptz not null default clock_timestamp(),
  foreign key (wallet_id, workspace_id) references public.wallets(id, workspace_id)
);

create index if not exists wallet_opening_balances_by_effective_at
  on public.wallet_opening_balances (wallet_id, effective_at desc, id desc);

create table if not exists public.wallet_transfers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  from_wallet_id uuid not null,
  to_wallet_id uuid not null,
  created_by uuid not null references auth.users(id) on delete cascade,
  amount bigint not null check (amount > 0),
  occurred_at timestamptz not null default clock_timestamp(),
  check (from_wallet_id <> to_wallet_id),
  foreign key (from_wallet_id, workspace_id) references public.wallets(id, workspace_id),
  foreign key (to_wallet_id, workspace_id) references public.wallets(id, workspace_id)
);

create index if not exists wallet_transfers_by_source_date
  on public.wallet_transfers (from_wallet_id, occurred_at);
create index if not exists wallet_transfers_by_destination_date
  on public.wallet_transfers (to_wallet_id, occurred_at);

alter table public.wallet_opening_balances enable row level security;
alter table public.wallet_transfers enable row level security;
revoke all on public.wallet_opening_balances, public.wallet_transfers
  from public, anon, authenticated, service_role;
grant select on public.wallet_opening_balances, public.wallet_transfers to authenticated;

drop policy if exists wallet_opening_balances_select_member on public.wallet_opening_balances;
create policy wallet_opening_balances_select_member on public.wallet_opening_balances
  for select to authenticated using (exists (
    select 1 from public.workspace_members as member
    where member.workspace_id = wallet_opening_balances.workspace_id and member.user_id = (select auth.uid())
  ));

drop policy if exists wallet_transfers_select_member on public.wallet_transfers;
create policy wallet_transfers_select_member on public.wallet_transfers
  for select to authenticated using (exists (
    select 1 from public.workspace_members as member
    where member.workspace_id = wallet_transfers.workspace_id and member.user_id = (select auth.uid())
  ));

create table if not exists app_private.wallet_action_receipts (
  user_id uuid not null references auth.users(id) on delete cascade,
  operation_id uuid not null,
  workspace_id uuid references public.workspaces(id) on delete set null,
  action_fingerprint text not null,
  outcome text not null check (outcome in ('created', 'updated', 'adjusted', 'transferred', 'deleted', 'archived')),
  primary key (user_id, operation_id)
);

create index if not exists wallet_action_receipts_by_workspace
  on app_private.wallet_action_receipts (workspace_id) where workspace_id is not null;

alter table app_private.wallet_action_receipts enable row level security;
revoke all on app_private.wallet_action_receipts from public, anon, authenticated, service_role;

create or replace function public.get_wallet_balance_snapshot(p_workspace_id uuid, p_before timestamptz)
returns table (
  wallet_id uuid, wallet_name text, wallet_type text, opening_balance text, balance text, archived boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  select wallet.id, wallet.name, wallet.type, coalesce(opening.amount, 0)::text,
    (coalesce(opening.amount, 0)::numeric + movements.net)::text,
    wallet.archived_at is not null
  from public.wallets as wallet
  left join lateral (
    select snapshot.amount
    from public.wallet_opening_balances as snapshot
    where snapshot.wallet_id = wallet.id and snapshot.workspace_id = wallet.workspace_id
      and (p_before is null or snapshot.effective_at < p_before)
    order by snapshot.effective_at desc, snapshot.id desc
    limit 1
  ) as opening on true
  cross join lateral (
    select coalesce(sum(movement.amount), 0) as net
    from (
      select case entry.type when 'income' then entry.amount else -entry.amount end as amount
      from public.transactions as entry
      where entry.wallet_id = wallet.id and entry.workspace_id = wallet.workspace_id
        and (p_before is null or entry.occurred_at < p_before)
      union all
      select transfer.amount from public.wallet_transfers as transfer
      where transfer.to_wallet_id = wallet.id and transfer.workspace_id = wallet.workspace_id
        and (p_before is null or transfer.occurred_at < p_before)
      union all
      select -transfer.amount from public.wallet_transfers as transfer
      where transfer.from_wallet_id = wallet.id and transfer.workspace_id = wallet.workspace_id
        and (p_before is null or transfer.occurred_at < p_before)
    ) as movement
  ) as movements
  where wallet.workspace_id = p_workspace_id and exists (
    select 1 from public.workspace_members as member
    where member.workspace_id = p_workspace_id and member.user_id = (select auth.uid())
  );
$$;

create or replace function public.get_wallet_overview(p_workspace_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object('workspace_id', member.workspace_id, 'wallets', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', wallet.wallet_id, 'name', wallet.wallet_name, 'type', wallet.wallet_type,
      'balance', wallet.balance, 'opening_balance', wallet.opening_balance, 'archived', wallet.archived
    ) order by wallet.archived, wallet.wallet_name, wallet.wallet_id), '[]'::jsonb)
    from public.get_wallet_balance_snapshot(member.workspace_id, null) as wallet
  ))
  from public.workspace_members as member
  where member.workspace_id = p_workspace_id and member.user_id = (select auth.uid());
$$;

create or replace function public.apply_wallet_action(
  p_workspace_id uuid, p_operation_id uuid, p_action jsonb
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  account_id uuid := auth.uid();
  action_name text := p_action->>'action';
  fingerprint text;
  receipt app_private.wallet_action_receipts%rowtype;
  target_wallet public.wallets%rowtype;
  target_wallet_id uuid;
  source_id uuid;
  destination_id uuid;
  wallet_name text;
  wallet_type text;
  amount_text text;
  result text;
begin
  perform 1 from public.workspace_members
  where workspace_id = p_workspace_id and user_id = account_id
  for key share;
  if not found then
    return 'forbidden';
  end if;

  if p_operation_id is null or jsonb_typeof(p_action) is distinct from 'object' then
    return 'invalid_input';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('wallet-operation:' || account_id::text || ':' || p_operation_id::text, 0));
  fingerprint := encode(sha256(convert_to(p_action::text, 'UTF8')), 'hex');
  select * into receipt from app_private.wallet_action_receipts
  where user_id = account_id and operation_id = p_operation_id;
  if found then
    if receipt.workspace_id is distinct from p_workspace_id or receipt.action_fingerprint <> fingerprint then
      return 'conflict';
    end if;
    return receipt.outcome;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('workspace-wallets:' || p_workspace_id::text, 0));

  begin
    if action_name in ('create', 'update') then
      wallet_name := btrim(p_action->>'name');
      wallet_type := p_action->>'type';
      if jsonb_typeof(p_action->'name') is distinct from 'string' or wallet_name !~ '[^[:space:]]'
        or wallet_type is null or wallet_type not in ('cash', 'bank', 'ewallet') then
        return 'invalid_input';
      end if;
    end if;

    if action_name in ('update', 'adjust', 'delete') then
      target_wallet_id := (p_action->>'wallet_id')::uuid;
      select * into target_wallet from public.wallets as wallet
      where wallet.id = target_wallet_id and wallet.workspace_id = p_workspace_id
      for update;
      if not found or (target_wallet.archived_at is not null and action_name <> 'delete') then
        return 'not_found';
      end if;
    end if;

    case action_name
      when 'create' then
        insert into public.wallets (workspace_id, name, type) values (p_workspace_id, wallet_name, wallet_type);
        result := 'created';
      when 'update' then
        update public.wallets set name = wallet_name, type = wallet_type where id = target_wallet_id;
        result := 'updated';
      when 'adjust' then
        amount_text := p_action->>'opening_balance';
        if jsonb_typeof(p_action->'opening_balance') is distinct from 'string'
          or length(amount_text) > 20 or amount_text !~ '^(0|-?[1-9][0-9]*)$' then
          return 'invalid_input';
        end if;
        insert into public.wallet_opening_balances (workspace_id, wallet_id, created_by, amount)
        values (p_workspace_id, target_wallet_id, account_id, amount_text::bigint);
        result := 'adjusted';
      when 'transfer' then
        source_id := (p_action->>'from_wallet_id')::uuid;
        destination_id := (p_action->>'to_wallet_id')::uuid;
        amount_text := p_action->>'amount';
        if source_id is null or destination_id is null or source_id = destination_id
          or jsonb_typeof(p_action->'amount') is distinct from 'string'
          or length(amount_text) > 19 or amount_text !~ '^[1-9][0-9]*$' then
          return 'invalid_input';
        end if;

        if (select count(*) from public.wallets
          where workspace_id = p_workspace_id and id in (source_id, destination_id) and archived_at is null) <> 2 then
          return 'not_found';
        end if;
        insert into public.wallet_transfers (workspace_id, from_wallet_id, to_wallet_id, created_by, amount)
        values (p_workspace_id, source_id, destination_id, account_id, amount_text::bigint);
        result := 'transferred';
      when 'delete' then
        if target_wallet.archived_at is not null
          or exists (select 1 from public.transactions as entry where entry.wallet_id = target_wallet_id)
          or exists (select 1 from public.wallet_opening_balances as opening where opening.wallet_id = target_wallet_id)
          or exists (
            select 1 from public.wallet_transfers as transfer
            where transfer.from_wallet_id = target_wallet_id or transfer.to_wallet_id = target_wallet_id
          ) then
          update public.wallets set archived_at = coalesce(archived_at, clock_timestamp()) where id = target_wallet_id;
          result := 'archived';
        else
          delete from public.wallets where id = target_wallet_id;
          result := 'deleted';
        end if;
      else
        return 'invalid_input';
    end case;
  exception
    when invalid_text_representation or numeric_value_out_of_range or check_violation then
      return 'invalid_input';
  end;

  insert into app_private.wallet_action_receipts (user_id, operation_id, workspace_id, action_fingerprint, outcome)
  values (account_id, p_operation_id, p_workspace_id, fingerprint, result);
  return result;
end;
$$;

create or replace function app_private.resolve_transaction_wallet(
  p_workspace_id uuid, p_wallet_type text, p_original_wallet_id uuid
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  label text := case p_wallet_type when 'cash' then 'Tunai' when 'bank' then 'Bank' when 'ewallet' then 'E-Wallet' end;
  resolved_id uuid;
begin
  if label is null then
    return null;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('workspace-wallets:' || p_workspace_id::text, 0));
  select wallet.id into resolved_id from public.wallets as wallet
  where wallet.workspace_id = p_workspace_id and wallet.type = p_wallet_type
    and (wallet.archived_at is null or wallet.id = p_original_wallet_id)
  order by (wallet.id = p_original_wallet_id) desc nulls last, (wallet.name = label) desc, wallet.id
  limit 1;

  if resolved_id is null and p_original_wallet_id is null then
    insert into public.wallets (workspace_id, type, name) values (p_workspace_id, p_wallet_type, label)
    returning id into resolved_id;
  end if;
  return resolved_id;
end;
$$;

revoke all on function app_private.resolve_transaction_wallet(uuid, text, uuid),
  public.get_wallet_balance_snapshot(uuid, timestamptz), public.get_wallet_overview(uuid),
  public.apply_wallet_action(uuid, uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.get_wallet_balance_snapshot(uuid, timestamptz), public.get_wallet_overview(uuid),
  public.apply_wallet_action(uuid, uuid, jsonb) to authenticated;

create or replace function public.finish_telegram_input(
  p_telegram_user_id bigint,
  p_telegram_message_id bigint,
  p_claim_token uuid,
  p_transactions jsonb,
  p_raw_input text,
  p_occurred_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  delivery app_private.telegram_input_deliveries%rowtype;
  target_id uuid;
  target_wallet_id uuid;
  draft jsonb;
  draft_wallet_id uuid;
  saved_entry public.transactions%rowtype;
  saved_transactions jsonb := '[]'::jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended('telegram-input:' || p_telegram_user_id::text, 0));
  select * into delivery from app_private.telegram_input_deliveries
  where telegram_user_id = p_telegram_user_id and telegram_message_id = p_telegram_message_id;

  if not found or delivery.completed_at is not null or p_claim_token is null
    or delivery.claim_token is distinct from p_claim_token or delivery.lease_until <= clock_timestamp() then
    return jsonb_build_object('status', 'obsolete', 'transactions', saved_transactions);
  end if;

  perform 1 from public.workspace_members as member
  join app_private.telegram_links as link on link.user_id = member.user_id
  where member.workspace_id = delivery.workspace_id and member.user_id = delivery.user_id
    and link.telegram_user_id = p_telegram_user_id
  for key share of member;
  if not found then
    perform app_private.complete_telegram_input(p_telegram_user_id, p_telegram_message_id);
    return jsonb_build_object('status', 'not_found', 'transactions', saved_transactions);
  end if;

  if jsonb_typeof(p_transactions) is distinct from 'array' then
    raise exception 'Rincian transaksi tidak valid.' using errcode = '22023';
  end if;

  if delivery.edit_prompt_message_id is not null then
    select entry.id, entry.wallet_id into target_id, target_wallet_id
    from app_private.telegram_edit_prompts as prompt
    join public.transactions as entry on entry.id = prompt.transaction_id
    where prompt.telegram_user_id = p_telegram_user_id
      and prompt.prompt_message_id = delivery.edit_prompt_message_id and prompt.spent_at is null
      and entry.workspace_id = delivery.workspace_id and entry.created_by = delivery.user_id
    for update of entry;
    if not found then
      perform app_private.complete_telegram_input(p_telegram_user_id, p_telegram_message_id);
      return jsonb_build_object('status', 'not_found', 'transactions', saved_transactions);
    end if;
    if jsonb_array_length(p_transactions) > 1 then
      raise exception 'Koreksi harus memuat satu transaksi.' using errcode = '22023';
    end if;
  end if;

  if jsonb_array_length(p_transactions) = 0 then
    perform app_private.complete_telegram_input(p_telegram_user_id, p_telegram_message_id);
    return jsonb_build_object('status', 'empty', 'transactions', saved_transactions);
  end if;

  for draft in select value from jsonb_array_elements(p_transactions) loop
    if jsonb_typeof(draft->'amount') is distinct from 'string'
      or draft->>'amount' !~ '^[1-9][0-9]*$'
      or jsonb_typeof(draft->'item') is distinct from 'string' then
      raise exception 'Nominal atau nama transaksi tidak valid.' using errcode = '22023';
    end if;

    draft_wallet_id := app_private.resolve_transaction_wallet(
      delivery.workspace_id, draft->>'wallet_type', target_wallet_id
    );
    if draft_wallet_id is null then
      raise exception 'Dompet transaksi tidak tersedia.' using errcode = '22023';
    end if;

    if target_id is null then
      insert into public.transactions (workspace_id, wallet_id, created_by, item, amount, type, category, occurred_at, raw_input)
      values (
        delivery.workspace_id, draft_wallet_id, delivery.user_id, btrim(draft->>'item'),
        (draft->>'amount')::bigint, draft->>'type', draft->>'category', p_occurred_at, p_raw_input
      )
      returning * into saved_entry;
    else
      update public.transactions set wallet_id = draft_wallet_id, item = btrim(draft->>'item'),
        amount = (draft->>'amount')::bigint, type = draft->>'type', category = draft->>'category',
        raw_input = p_raw_input
      where id = target_id returning * into saved_entry;
    end if;

    saved_transactions := saved_transactions || jsonb_build_array(jsonb_build_object(
      'id', saved_entry.id, 'item', saved_entry.item, 'amount', saved_entry.amount::text, 'category', saved_entry.category
    ));
  end loop;

  if target_id is not null then
    update app_private.telegram_edit_prompts set spent_at = clock_timestamp()
    where telegram_user_id = p_telegram_user_id and prompt_message_id = delivery.edit_prompt_message_id;
  end if;

  perform app_private.complete_telegram_input(p_telegram_user_id, p_telegram_message_id);
  return jsonb_build_object(
    'status', case when target_id is null then 'saved' else 'edited' end, 'transactions', saved_transactions
  );
end;
$$;

create or replace function public.save_pwa_transactions(
  p_workspace_id uuid,
  p_input_id uuid,
  p_transactions jsonb,
  p_raw_input text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  account_id uuid := auth.uid();
  receipt app_private.pwa_transaction_inputs%rowtype;
  draft jsonb;
  draft_wallet_id uuid;
  saved_count integer;
begin
  perform 1 from public.workspace_members
  where user_id = account_id and workspace_id = p_workspace_id
  for key share;
  if not found then
    return jsonb_build_object('status', 'forbidden', 'count', 0);
  end if;

  if p_input_id is null then
    raise exception 'Identitas input transaksi tidak valid.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('pwa-input:' || account_id::text || ':' || p_input_id::text, 0));

  select * into receipt from app_private.pwa_transaction_inputs
  where user_id = account_id and input_id = p_input_id;
  if found then
    if receipt.workspace_id is distinct from p_workspace_id then
      return jsonb_build_object('status', 'conflict', 'count', 0);
    end if;
    return jsonb_build_object('status', 'duplicate', 'count', receipt.transaction_count);
  end if;

  if jsonb_typeof(p_transactions) is distinct from 'array' then
    raise exception 'Rincian transaksi tidak valid.' using errcode = '22023';
  end if;
  saved_count := jsonb_array_length(p_transactions);
  if saved_count = 0 then
    raise exception 'Rincian transaksi belum tersedia.' using errcode = '22023';
  end if;

  for draft in select value from jsonb_array_elements(p_transactions) loop
    if jsonb_typeof(draft->'amount') is distinct from 'string'
      or draft->>'amount' !~ '^[1-9][0-9]*$'
      or jsonb_typeof(draft->'item') is distinct from 'string' then
      raise exception 'Nominal atau nama transaksi tidak valid.' using errcode = '22023';
    end if;

    draft_wallet_id := app_private.resolve_transaction_wallet(
      p_workspace_id, draft->>'wallet_type', null
    );
    if draft_wallet_id is null then
      raise exception 'Dompet transaksi tidak tersedia.' using errcode = '22023';
    end if;

    insert into public.transactions (
      workspace_id, wallet_id, created_by, item, amount, type, category, occurred_at, raw_input
    ) values (
      p_workspace_id, draft_wallet_id, account_id, btrim(draft->>'item'), (draft->>'amount')::bigint,
      draft->>'type', draft->>'category', statement_timestamp(), p_raw_input
    );
  end loop;

  insert into app_private.pwa_transaction_inputs (user_id, input_id, workspace_id, transaction_count)
  values (account_id, p_input_id, p_workspace_id, saved_count);

  return jsonb_build_object('status', 'saved', 'count', saved_count);
end;
$$;

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
    'total_balance', (
      select coalesce(sum(wallet.balance::numeric), 0)::text
      from public.get_wallet_balance_snapshot(selected.workspace_id, null) as wallet
    ),
    'total_income', totals.income,
    'total_expense', totals.expense,
    'transactions', recent.transactions
  )
  from selected_workspace as selected
  cross join month_bounds as month
  cross join lateral (
    select coalesce(sum(entry.amount) filter (
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
      'wallet_id', balances.wallet_id,
      'wallet_name', balances.wallet_name,
      'balance', balances.balance
    ) order by balances.wallet_name, balances.wallet_id), '[]'::jsonb) as wallet_balances
    from public.get_wallet_balance_snapshot(selected.workspace_id, month.end_at) as balances
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
  original_wallet_id uuid;
begin
  perform 1 from public.workspace_members
  where user_id = account_id and workspace_id = p_workspace_id
  for key share;
  if not found then
    return 'not_found';
  end if;

  select wallet_id into original_wallet_id from public.transactions
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
    and (archived_at is null or id = original_wallet_id)
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

-- Supabase sudah mengaktifkan RLS pada realtime.messages.
do $realtime_setup$
begin
  if to_regclass('realtime.messages') is null
    or to_regprocedure('realtime.topic()') is null
    or to_regprocedure('realtime.send(jsonb,text,text,boolean)') is null then
    return;
  end if;

  if not (select relrowsecurity from pg_catalog.pg_class where oid = 'realtime.messages'::regclass) then
    raise exception 'Row Level Security belum aktif untuk Supabase Realtime.';
  end if;

  drop policy if exists dompetbareng_workspace_broadcast on realtime.messages;
  create policy dompetbareng_workspace_broadcast on realtime.messages
    for select to authenticated using (
      extension = 'broadcast' and topic = (select realtime.topic())
      and exists (
        select 1 from public.workspace_members as member
        where member.user_id = (select auth.uid())
          and realtime.messages.topic = 'workspace:' || member.workspace_id::text
      )
    );

  create or replace function app_private.broadcast_workspace_change()
  returns trigger
  language plpgsql
  security definer
  set search_path = ''
  as $$
  begin
    if tg_op = 'DELETE' then
      perform realtime.send('{}'::jsonb, 'changed', 'workspace:' || old.workspace_id::text, true);
    else
      perform realtime.send('{}'::jsonb, 'changed', 'workspace:' || new.workspace_id::text, true);
      if tg_op = 'UPDATE' and old.workspace_id <> new.workspace_id then
        perform realtime.send('{}'::jsonb, 'changed', 'workspace:' || old.workspace_id::text, true);
      end if;
    end if;
    return null;
  end;
  $$;

  revoke all on function app_private.broadcast_workspace_change()
    from public, anon, authenticated, service_role;

  drop trigger if exists broadcast_workspace_change on public.transactions;
  create trigger broadcast_workspace_change after insert or update or delete on public.transactions
    for each row execute function app_private.broadcast_workspace_change();

  drop trigger if exists broadcast_workspace_change on public.wallets;
  create trigger broadcast_workspace_change after insert or update or delete on public.wallets
    for each row execute function app_private.broadcast_workspace_change();

  drop trigger if exists broadcast_workspace_change on public.wallet_opening_balances;
  create trigger broadcast_workspace_change after insert or update or delete on public.wallet_opening_balances
    for each row execute function app_private.broadcast_workspace_change();

  drop trigger if exists broadcast_workspace_change on public.wallet_transfers;
  create trigger broadcast_workspace_change after insert or update or delete on public.wallet_transfers
    for each row execute function app_private.broadcast_workspace_change();
end;
$realtime_setup$;
