create table if not exists app_private.transaction_move_receipts (
  user_id uuid not null references auth.users(id) on delete cascade,
  operation_id text not null,
  request_fingerprint text not null,
  primary key (user_id, operation_id)
);

alter table app_private.transaction_move_receipts enable row level security;
revoke all on app_private.transaction_move_receipts from public, anon, authenticated, service_role;

create or replace function app_private.telegram_transaction_receipt(p_account_id uuid, p_transaction_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', entry.id, 'item', entry.item, 'amount', entry.amount::text, 'category', entry.category,
    'workspace_id', workspace.id, 'workspace_name', workspace.name, 'workspace_type', workspace.type,
    'wallet_id', wallet.id, 'wallet_name', wallet.name, 'can_move', exists (
      select 1 from public.workspace_members as other_member
      join public.workspaces as other_workspace on other_workspace.id = other_member.workspace_id
      where other_member.user_id = p_account_id and other_workspace.type <> workspace.type
        and (other_workspace.type = 'household' or other_workspace.owner_id = p_account_id)
    )
  )
  from public.transactions as entry
  join public.workspaces as workspace on workspace.id = entry.workspace_id
  join public.wallets as wallet on wallet.id = entry.wallet_id and wallet.workspace_id = workspace.id
  join public.workspace_members as member on member.workspace_id = workspace.id and member.user_id = p_account_id
  where entry.id = p_transaction_id and entry.created_by = p_account_id;
$$;

create or replace function app_private.move_transaction_for_account(
  p_account_id uuid, p_source_workspace_id uuid, p_transaction_id uuid, p_target_workspace_id uuid,
  p_target_wallet_id uuid, p_operation_id text, p_edit jsonb
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  allowed_count integer;
  entry public.transactions%rowtype;
  source_wallet_type text;
  next_wallet_id uuid;
  next_item text;
  next_amount bigint;
  next_type text;
  next_category text;
  next_occurred_at timestamptz;
  fingerprint text;
  previous_fingerprint text;
  result text;
begin
  if p_account_id is null or p_source_workspace_id is null or p_target_workspace_id is null
    or p_transaction_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  if p_source_workspace_id = p_target_workspace_id
    or (p_operation_id is not null and (length(p_operation_id) > 128 or btrim(p_operation_id) = '')) then
    return jsonb_build_object('status', 'invalid_input');
  end if;

  perform 1 from public.workspace_members as member
  join public.workspaces as workspace on workspace.id = member.workspace_id
  where member.user_id = p_account_id and member.workspace_id in (p_source_workspace_id, p_target_workspace_id)
    and (workspace.type = 'household' or workspace.owner_id = p_account_id)
  order by member.workspace_id
  for key share of member;
  get diagnostics allowed_count = row_count;
  if allowed_count <> 2 or not exists (
    select 1 from public.workspaces as source
    join public.workspaces as destination on destination.id = p_target_workspace_id
    where source.id = p_source_workspace_id and source.type <> destination.type
  ) then
    return jsonb_build_object('status', 'not_found');
  end if;

  if p_operation_id is not null then
    perform pg_advisory_xact_lock(hashtextextended(
      'transaction-move:' || p_account_id::text || ':' || p_operation_id, 0
    ));
    fingerprint := encode(sha256(convert_to(jsonb_build_object(
      'transaction_id', p_transaction_id, 'source', p_source_workspace_id, 'target', p_target_workspace_id,
      'wallet', p_target_wallet_id, 'edit', p_edit
    )::text, 'UTF8')), 'hex');
    select request_fingerprint into previous_fingerprint from app_private.transaction_move_receipts
    where user_id = p_account_id and operation_id = p_operation_id;
    if found and previous_fingerprint <> fingerprint then
      return jsonb_build_object('status', 'conflict');
    end if;
  end if;

  select * into entry from public.transactions
  where id = p_transaction_id and created_by = p_account_id
    and workspace_id in (p_source_workspace_id, p_target_workspace_id)
  for update;
  if not found or entry.type not in ('income', 'expense') then
    return jsonb_build_object('status', 'not_found');
  end if;

  if previous_fingerprint is not null or entry.workspace_id = p_target_workspace_id then
    result := 'already_moved';
  else
    if p_target_wallet_id is not null then
      select wallet.id into next_wallet_id from public.wallets as wallet
      where wallet.id = p_target_wallet_id and wallet.workspace_id = p_target_workspace_id
        and wallet.archived_at is null
      for key share;
    else
      select wallet.type into source_wallet_type from public.wallets as wallet
      where wallet.id = entry.wallet_id and wallet.workspace_id = p_source_workspace_id;

      select wallet.id into next_wallet_id from public.wallets as wallet
      where wallet.workspace_id = p_target_workspace_id and wallet.archived_at is null
      order by (wallet.type = source_wallet_type) desc, wallet.name, wallet.id
      limit 1 for key share;
    end if;
    if next_wallet_id is null then
      return jsonb_build_object('status', 'invalid_wallet');
    end if;

    next_item := entry.item;
    next_amount := entry.amount;
    next_type := entry.type;
    next_category := entry.category;
    next_occurred_at := entry.occurred_at;
    begin
      if p_edit is not null then
        if jsonb_typeof(p_edit) is distinct from 'object'
          or jsonb_typeof(p_edit->'item') is distinct from 'string' or btrim(p_edit->>'item') = ''
          or jsonb_typeof(p_edit->'amount') is distinct from 'string'
          or length(p_edit->>'amount') > 19 or p_edit->>'amount' !~ '^[1-9][0-9]*$'
          or jsonb_typeof(p_edit->'type') is distinct from 'string'
          or jsonb_typeof(p_edit->'category') is distinct from 'string'
          or jsonb_typeof(p_edit->'occurred_at') is distinct from 'string' then
          return jsonb_build_object('status', 'invalid_input');
        end if;

        next_item := btrim(p_edit->>'item');
        next_amount := (p_edit->>'amount')::bigint;
        next_type := p_edit->>'type';
        next_category := p_edit->>'category';
        next_occurred_at := (p_edit->>'occurred_at')::timestamptz;
        if not isfinite(next_occurred_at) then
          return jsonb_build_object('status', 'invalid_input');
        end if;
      end if;

      update public.transactions set workspace_id = p_target_workspace_id, wallet_id = next_wallet_id,
        item = next_item, amount = next_amount, type = next_type, category = next_category,
        occurred_at = next_occurred_at
      where id = p_transaction_id;
    exception
      when check_violation or numeric_value_out_of_range or invalid_datetime_format or datetime_field_overflow then
        return jsonb_build_object('status', 'invalid_input');
    end;
    result := 'moved';
  end if;

  if p_operation_id is not null and previous_fingerprint is null then
    insert into app_private.transaction_move_receipts (user_id, operation_id, request_fingerprint)
    values (p_account_id, p_operation_id, fingerprint);
  end if;

  return jsonb_build_object(
    'status', result, 'transaction', app_private.telegram_transaction_receipt(p_account_id, p_transaction_id)
  );
end;
$$;

create or replace function public.move_transaction(
  p_source_workspace_id uuid,
  p_transaction_id uuid,
  p_target_workspace_id uuid,
  p_target_wallet_id uuid default null,
  p_operation_id text default null,
  p_edit jsonb default null
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select app_private.move_transaction_for_account(
    auth.uid(), p_source_workspace_id, p_transaction_id, p_target_workspace_id,
    p_target_wallet_id, p_operation_id, p_edit
  );
$$;

create or replace function public.move_telegram_transaction(
  p_telegram_user_id bigint, p_transaction_id uuid, p_target_workspace_type text, p_operation_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  account_id uuid;
  source_workspace_id uuid;
  target_workspace_id uuid;
begin
  if p_target_workspace_type is null or p_target_workspace_type not in ('personal','household') then
    return jsonb_build_object('status', 'invalid_input');
  end if;
  select user_id into account_id from app_private.telegram_links where telegram_user_id = p_telegram_user_id;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  select workspace.id into target_workspace_id from public.workspace_members as member
  join public.workspaces as workspace on workspace.id = member.workspace_id
  where member.user_id = account_id and workspace.type = p_target_workspace_type
    and (workspace.type = 'household' or workspace.owner_id = account_id);

  select workspace.id into source_workspace_id from public.workspace_members as member
  join public.workspaces as workspace on workspace.id = member.workspace_id
  where member.user_id = account_id and workspace.type <> p_target_workspace_type
    and (workspace.type = 'household' or workspace.owner_id = account_id);

  return app_private.move_transaction_for_account(
    account_id, source_workspace_id, p_transaction_id, target_workspace_id, null,
    case when p_operation_id is not null then 'telegram:' || p_operation_id end, null
  );
end;
$$;

create or replace function public.get_telegram_transaction_receipts(
  p_telegram_user_id bigint, p_transaction_ids uuid[]
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(receipt.value order by requested.position), '[]'::jsonb)
  from app_private.telegram_links as link
  cross join lateral unnest(p_transaction_ids) with ordinality as requested(id, position)
  cross join lateral (
    select app_private.telegram_transaction_receipt(link.user_id, requested.id) as value
  ) as receipt
  where link.telegram_user_id = p_telegram_user_id and cardinality(p_transaction_ids) <= 20
    and receipt.value is not null;
$$;

create or replace function public.get_telegram_workspace_state(p_telegram_user_id bigint)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'active_workspace_type', coalesce((
      select workspace.type from app_private.active_workspaces as selection
      join public.workspaces as workspace on workspace.id = selection.workspace_id
      where selection.user_id = link.user_id
    ), 'personal'),
    'has_household', exists (
      select 1 from public.workspace_members as member
      join public.workspaces as workspace on workspace.id = member.workspace_id
      where member.user_id = link.user_id and workspace.type = 'household'
    )
  )
  from app_private.telegram_links as link
  where link.telegram_user_id = p_telegram_user_id;
$$;

create or replace function public.set_telegram_workspace(p_telegram_user_id bigint, p_workspace_type text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  account_id uuid;
  target_workspace_id uuid;
begin
  select user_id into account_id from app_private.telegram_links where telegram_user_id = p_telegram_user_id;
  if not found then
    return 'unlinked';
  end if;

  select workspace.id into target_workspace_id from public.workspace_members as member
  join public.workspaces as workspace on workspace.id = member.workspace_id
  where member.user_id = account_id and workspace.type = p_workspace_type
    and (workspace.type = 'household' or workspace.owner_id = account_id)
  for key share of member;
  if not found then
    return 'workspace_unavailable';
  end if;

  insert into app_private.active_workspaces (user_id, workspace_id)
  values (account_id, target_workspace_id)
  on conflict (user_id) do update set workspace_id = excluded.workspace_id;
  return 'ok';
end;
$$;

create or replace function public.join_household(p_code text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  account_id uuid := auth.uid();
  household_id uuid;
  previous_household_id uuid;
  previous_owner_id uuid;
  locked_membership integer;
  attempted_at timestamptz;
  failure_window timestamptz;
  failure_count smallint;
begin
  if account_id is null then
    raise exception 'Sesi autentikasi diperlukan.' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('household-member:' || account_id::text, 0));

  select workspace.id, workspace.owner_id into previous_household_id, previous_owner_id
  from public.workspace_members as member
  join public.workspaces as workspace on workspace.id = member.workspace_id
  where member.user_id = account_id and workspace.type = 'household';

  if previous_household_id is not null and (
    previous_owner_id <> account_id
    or (select count(*) from public.workspace_members where workspace_id = previous_household_id) <> 1
  ) then
    return 'already_household';
  end if;

  attempted_at := clock_timestamp();
  select window_started_at, failed_attempts into failure_window, failure_count
  from app_private.household_join_failures
  where user_id = account_id and window_started_at > attempted_at - interval '15 minutes';

  if failure_count >= 5 then
    return 'rate_limited';
  end if;

  select workspace_id into household_id
  from app_private.household_invites
  where code = p_code and active and expires_at > attempted_at;

  if household_id is not null and household_id is distinct from previous_household_id then
    -- Kunci kedua ruang dalam urutan yang sama, termasuk saat dua pemilik saling mengundang.
    perform 1 from public.workspaces as workspace
    where workspace.id in (household_id, previous_household_id) and workspace.type = 'household'
    order by workspace.id
    for no key update;

    perform 1 from app_private.household_invites as invite
    where invite.code = p_code and invite.workspace_id = household_id
      and invite.active and invite.expires_at > clock_timestamp()
    for update;

    if found and (select count(*) from public.workspace_members where workspace_id = household_id) = 1 then
      if previous_household_id is not null then
        -- Semua penulis ledger aplikasi mengambil kunci bersama pada keanggotaan.
        perform 1 from public.workspace_members as member
        where member.workspace_id = previous_household_id
        order by member.user_id
        for update;
        get diagnostics locked_membership = row_count;
        if locked_membership <> 1 or not exists (
          select 1 from public.workspace_members
          where workspace_id = previous_household_id and user_id = account_id
        ) then
          return 'already_household';
        end if;

        perform 1 from public.workspaces
        where id = previous_household_id and owner_id = account_id for update;
        if not found then
          return 'already_household';
        end if;
        if exists (select 1 from public.transactions where workspace_id = previous_household_id)
          or exists (select 1 from public.wallet_opening_balances where workspace_id = previous_household_id)
          or exists (select 1 from public.wallet_transfers where workspace_id = previous_household_id) then
          return 'household_has_data';
        end if;
      end if;

      update app_private.household_invites set active = false
      where code = p_code and workspace_id = household_id and active and expires_at > clock_timestamp();
      if found then
        if previous_household_id is not null then
          delete from public.workspaces where id = previous_household_id;
        end if;

        insert into public.workspace_members (workspace_id, user_id)
        values (household_id, account_id);
        perform public.set_active_workspace(household_id);
        delete from app_private.household_join_failures where user_id = account_id;
        return 'ok';
      end if;
    end if;
  end if;

  insert into app_private.household_join_failures (user_id, window_started_at, failed_attempts)
  values (account_id, coalesce(failure_window, attempted_at), coalesce(failure_count, 0) + 1)
  on conflict (user_id) do update set
    window_started_at = excluded.window_started_at,
    failed_attempts = excluded.failed_attempts;

  return 'invalid_code';
end;
$$;

create or replace function public.begin_telegram_input_in_workspace(
  p_telegram_user_id bigint,
  p_telegram_message_id bigint,
  p_reply_to_message_id bigint,
  p_workspace_type text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  delivery app_private.telegram_input_deliveries%rowtype;
  account_id uuid;
  input_workspace_id uuid;
  edit_workspace_id uuid;
  edit_prompt_id bigint;
  edit_target_id uuid;
  existing_draft jsonb;
  next_claim_token uuid;
  claimed_at timestamptz;
begin
  if p_telegram_user_id is null or p_telegram_user_id <= 0
    or p_telegram_message_id is null or p_telegram_message_id <= 0 then
    return jsonb_build_object('status', 'not_found');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('telegram-input:' || p_telegram_user_id::text, 0));
  select * into delivery from app_private.telegram_input_deliveries
  where telegram_user_id = p_telegram_user_id and telegram_message_id = p_telegram_message_id;

  if delivery.completed_at is not null or exists (
    select 1 from app_private.telegram_link_deliveries
    where telegram_user_id = p_telegram_user_id and telegram_message_id = p_telegram_message_id
  ) then
    return jsonb_build_object('status', 'duplicate');
  end if;
  if delivery.lease_until > clock_timestamp() then
    return jsonb_build_object('status', 'busy');
  end if;

  select user_id into account_id from app_private.telegram_links
  where telegram_user_id = p_telegram_user_id;
  if account_id is null then
    perform app_private.complete_telegram_input(p_telegram_user_id, p_telegram_message_id);
    return jsonb_build_object('status', 'unlinked');
  end if;

  if delivery.telegram_message_id is not null then
    if delivery.user_id is distinct from account_id or delivery.workspace_id is null then
      perform app_private.complete_telegram_input(p_telegram_user_id, p_telegram_message_id);
      return jsonb_build_object('status', 'not_found');
    end if;
    input_workspace_id := delivery.workspace_id;
    edit_prompt_id := delivery.edit_prompt_message_id;
  else
    edit_prompt_id := p_reply_to_message_id;
  end if;

  if edit_prompt_id is not null then
    select entry.workspace_id, entry.id, jsonb_build_object(
      'item', entry.item,
      'amount', entry.amount::text,
      'type', entry.type,
      'category', entry.category,
      'wallet_type', wallet.type
    ) into edit_workspace_id, edit_target_id, existing_draft
    from app_private.telegram_edit_prompts as prompt
    join public.transactions as entry on entry.id = prompt.transaction_id
    join public.wallets as wallet on wallet.id = entry.wallet_id
    where prompt.telegram_user_id = p_telegram_user_id and prompt.prompt_message_id = edit_prompt_id
      and prompt.spent_at is null and entry.created_by = account_id;

    if edit_workspace_id is null
      or (input_workspace_id is not null and input_workspace_id <> edit_workspace_id) then
      perform app_private.complete_telegram_input(p_telegram_user_id, p_telegram_message_id);
      return jsonb_build_object('status', 'not_found');
    end if;
    input_workspace_id := edit_workspace_id;

    -- Ambil draf koreksi setelah klaim koreksi sebelumnya selesai atau kedaluwarsa.
    if exists (
      select 1 from app_private.telegram_input_deliveries as active_claim
      join app_private.telegram_edit_prompts as prompt
        on prompt.telegram_user_id = active_claim.telegram_user_id
        and prompt.prompt_message_id = active_claim.edit_prompt_message_id
      where active_claim.telegram_user_id = p_telegram_user_id
        and active_claim.telegram_message_id <> p_telegram_message_id
        and active_claim.completed_at is null and active_claim.lease_until > clock_timestamp()
        and prompt.transaction_id = edit_target_id
    ) then
      return jsonb_build_object('status', 'busy');
    end if;
  elsif input_workspace_id is null and p_workspace_type is not null then
    select workspace.id into input_workspace_id
    from public.workspace_members as member
    join public.workspaces as workspace on workspace.id = member.workspace_id
    where member.user_id = account_id and workspace.type = p_workspace_type
      and (workspace.type = 'household' or workspace.owner_id = account_id);

    if input_workspace_id is null then
      perform app_private.complete_telegram_input(p_telegram_user_id, p_telegram_message_id);
      return jsonb_build_object('status', 'workspace_unavailable');
    end if;
  elsif input_workspace_id is null then
    select coalesce(
      (select workspace_id from app_private.active_workspaces where user_id = account_id),
      (select id from public.workspaces where owner_id = account_id and type = 'personal')
    ) into input_workspace_id;
  end if;

  if not exists (
    select 1 from public.workspace_members
    where workspace_id = input_workspace_id and user_id = account_id
  ) then
    perform app_private.complete_telegram_input(p_telegram_user_id, p_telegram_message_id);
    return jsonb_build_object('status', 'not_found');
  end if;

  claimed_at := clock_timestamp();
  insert into app_private.telegram_input_daily_usage as usage (user_id, usage_date, input_count)
  values (account_id, (claimed_at at time zone 'Asia/Jakarta')::date, 1)
  on conflict (user_id, usage_date) do update set input_count = usage.input_count + 1
  where usage.input_count < 30;
  if not found then
    perform app_private.complete_telegram_input(p_telegram_user_id, p_telegram_message_id);
    return jsonb_build_object('status', 'rate_limited');
  end if;

  next_claim_token := gen_random_uuid();
  insert into app_private.telegram_input_deliveries (
    telegram_user_id, telegram_message_id, user_id, workspace_id, edit_prompt_message_id, claim_token, lease_until
  ) values (
    p_telegram_user_id, p_telegram_message_id, account_id, input_workspace_id, edit_prompt_id,
    next_claim_token, claimed_at + interval '90 seconds'
  )
  on conflict (telegram_user_id, telegram_message_id) do update set
    claim_token = excluded.claim_token, lease_until = excluded.lease_until;

  return jsonb_strip_nulls(jsonb_build_object(
    'status', 'ready', 'claim_token', next_claim_token, 'existing', existing_draft
  ));
end;
$$;

create or replace function public.begin_telegram_input(
  p_telegram_user_id bigint, p_telegram_message_id bigint, p_reply_to_message_id bigint default null
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public.begin_telegram_input_in_workspace(
    p_telegram_user_id, p_telegram_message_id, p_reply_to_message_id, null
  );
$$;

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

    saved_transactions := saved_transactions || jsonb_build_array(
      app_private.telegram_transaction_receipt(delivery.user_id, saved_entry.id)
    );
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

revoke all on function app_private.telegram_transaction_receipt(uuid, uuid),
  app_private.move_transaction_for_account(uuid, uuid, uuid, uuid, uuid, text, jsonb),
  public.move_transaction(uuid, uuid, uuid, uuid, text, jsonb),
  public.move_telegram_transaction(bigint, uuid, text, text), public.get_telegram_transaction_receipts(bigint, uuid[]),
  public.get_telegram_workspace_state(bigint), public.set_telegram_workspace(bigint, text),
  public.begin_telegram_input_in_workspace(bigint, bigint, bigint, text)
  from public, anon, authenticated, service_role;

grant execute on function public.move_transaction(uuid, uuid, uuid, uuid, text, jsonb) to authenticated;
grant execute on function public.move_telegram_transaction(bigint, uuid, text, text),
  public.get_telegram_transaction_receipts(bigint, uuid[]),
  public.get_telegram_workspace_state(bigint), public.set_telegram_workspace(bigint, text),
  public.begin_telegram_input_in_workspace(bigint, bigint, bigint, text) to service_role;
