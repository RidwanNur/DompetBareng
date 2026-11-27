create or replace function public.begin_telegram_input_in_workspace(
  p_telegram_user_id bigint, p_telegram_message_id bigint, p_reply_to_message_id bigint,
  p_workspace_type text
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public.begin_telegram_input_in_workspace(
    p_telegram_user_id, p_telegram_message_id, p_reply_to_message_id, p_workspace_type, 60, null
  );
$$;

create or replace function app_private.parse_telegram_transaction_date(p_value jsonb)
returns timestamptz
language plpgsql
stable
set search_path = ''
as $$
declare
  date_text text;
begin
  if p_value is null or p_value = 'null'::jsonb then
    return null;
  end if;
  if jsonb_typeof(p_value) <> 'string' then
    raise exception 'Tanggal transaksi tidak valid.' using errcode = '22023';
  end if;
  date_text := p_value #>> '{}';
  if left(date_text, 4) = '0000'
    or date_text !~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])(T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]([.][0-9]{1,6})?(Z|[+-](0[0-9]|1[0-4]):[0-5][0-9]))?$' then
    raise exception 'Tanggal transaksi tidak valid.' using errcode = '22023';
  end if;
  if length(date_text) = 10 then
    return date_text::date::timestamp at time zone 'Asia/Jakarta';
  end if;
  return date_text::timestamptz;
exception
  when datetime_field_overflow or invalid_datetime_format then
    raise exception 'Tanggal transaksi tidak valid.' using errcode = '22023';
end;
$$;

create or replace function app_private.telegram_transaction_receipt(p_account_id uuid, p_transaction_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', entry.id, 'item', entry.item, 'amount', entry.amount::text, 'category', entry.category,
    'type', entry.type, 'occurred_at', entry.occurred_at,
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
  draft_occurred_at timestamptz;
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

  if delivery.extraction_date is not null then
    perform app_private.lock_extraction_day(delivery.user_id, delivery.extraction_date);
    if delivery.lease_until <= clock_timestamp() then
      return jsonb_build_object('status', 'obsolete', 'transactions', saved_transactions);
    end if;
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

    draft_occurred_at := app_private.parse_telegram_transaction_date(draft->'occurred_at');

    draft_wallet_id := app_private.resolve_transaction_wallet(
      delivery.workspace_id, draft->>'wallet_type', target_wallet_id
    );
    if draft_wallet_id is null then
      raise exception 'Dompet transaksi tidak tersedia.' using errcode = '22023';
    end if;

    if target_id is null then
      draft_occurred_at := coalesce(draft_occurred_at, p_occurred_at);
      if draft_occurred_at is null or not isfinite(draft_occurred_at) then
        raise exception 'Tanggal transaksi tidak valid.' using errcode = '22023';
      end if;

      insert into public.transactions (workspace_id, wallet_id, created_by, item, amount, type, category, occurred_at, raw_input)
      values (
        delivery.workspace_id, draft_wallet_id, delivery.user_id, btrim(draft->>'item'),
        (draft->>'amount')::bigint, draft->>'type', draft->>'category', draft_occurred_at, p_raw_input
      )
      returning * into saved_entry;
    else
      update public.transactions set wallet_id = draft_wallet_id, item = btrim(draft->>'item'),
        amount = (draft->>'amount')::bigint, type = draft->>'type', category = draft->>'category',
        occurred_at = coalesce(draft_occurred_at, occurred_at), raw_input = p_raw_input
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

  if delivery.extraction_date is not null then
    perform app_private.record_extraction_success(delivery.user_id, delivery.extraction_date);
  end if;
  perform app_private.complete_telegram_input(p_telegram_user_id, p_telegram_message_id);
  return jsonb_build_object(
    'status', case when target_id is null then 'saved' else 'edited' end, 'transactions', saved_transactions
  );
end;
$$;

create table if not exists app_private.telegram_transaction_flip_receipts (
  user_id uuid not null references auth.users(id) on delete cascade,
  operation_id text not null,
  transaction_id uuid not null,
  target_type text not null check (target_type in ('income', 'expense')),
  primary key (user_id, operation_id)
);

alter table app_private.telegram_transaction_flip_receipts enable row level security;
revoke all on app_private.telegram_transaction_flip_receipts from public, anon, authenticated, service_role;

create or replace function public.flip_telegram_transaction(
  p_telegram_user_id bigint, p_transaction_id uuid, p_target_type text, p_operation_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  account_id uuid;
  source_workspace_id uuid;
  entry_type text;
  previous app_private.telegram_transaction_flip_receipts%rowtype;
  result text;
begin
  if p_target_type is null or p_target_type not in ('income', 'expense')
    or p_operation_id is null or btrim(p_operation_id) = '' or length(p_operation_id) > 128 then
    return jsonb_build_object('status', 'invalid_input');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('telegram-input:' || p_telegram_user_id::text, 0));
  select link.user_id into account_id from app_private.telegram_links as link
  where link.telegram_user_id = p_telegram_user_id;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  select entry.workspace_id into source_workspace_id from public.transactions as entry
  where entry.id = p_transaction_id and entry.created_by = account_id;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  perform 1 from public.workspace_members as member
  join public.workspaces as workspace on workspace.id = member.workspace_id
  where member.workspace_id = source_workspace_id and member.user_id = account_id
    and (workspace.type = 'household' or workspace.owner_id = account_id)
  for key share of member;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  select entry.type into entry_type from public.transactions as entry
  where entry.id = p_transaction_id and entry.workspace_id = source_workspace_id
    and entry.created_by = account_id
  for update;
  if not found or entry_type not in ('income', 'expense') then
    return jsonb_build_object('status', 'not_found');
  end if;

  select * into previous from app_private.telegram_transaction_flip_receipts
  where user_id = account_id and operation_id = p_operation_id;
  if found then
    if previous.transaction_id <> p_transaction_id or previous.target_type <> p_target_type then
      return jsonb_build_object('status', 'conflict');
    end if;
    result := 'already_flipped';
  else
    if entry_type <> p_target_type then
      update public.transactions set type = p_target_type, category = 'Lainnya'
      where id = p_transaction_id;
      result := 'flipped';
    else
      result := 'already_flipped';
    end if;

    insert into app_private.telegram_transaction_flip_receipts (user_id, operation_id, transaction_id, target_type)
    values (account_id, p_operation_id, p_transaction_id, p_target_type);
  end if;

  return jsonb_build_object(
    'status', result, 'transaction', app_private.telegram_transaction_receipt(account_id, p_transaction_id)
  );
end;
$$;

revoke all on function app_private.parse_telegram_transaction_date(jsonb),
  public.flip_telegram_transaction(bigint, uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.flip_telegram_transaction(bigint, uuid, text, text) to service_role;
