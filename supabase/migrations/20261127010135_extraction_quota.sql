alter table app_private.telegram_input_daily_usage
  drop constraint if exists telegram_input_daily_usage_input_count_check;
alter table app_private.telegram_input_daily_usage
  alter column input_count type integer,
  add constraint telegram_input_daily_usage_input_count_check check (input_count > 0);

create table if not exists app_private.telegram_extraction_updates (
  update_id bigint primary key check (update_id >= 0)
);

alter table app_private.telegram_extraction_updates enable row level security;
revoke all on app_private.telegram_extraction_updates from public, anon, authenticated, service_role;

alter table app_private.telegram_input_deliveries
  add column if not exists extraction_update_id bigint
    references app_private.telegram_extraction_updates(update_id),
  add column if not exists extraction_date date;

create index if not exists telegram_input_deliveries_by_extraction_day
  on app_private.telegram_input_deliveries (user_id, extraction_date, lease_until)
  where completed_at is null and claim_token is not null;

create table if not exists app_private.pwa_extraction_claims (
  user_id uuid not null references auth.users(id) on delete cascade,
  input_id uuid not null,
  workspace_id uuid references public.workspaces(id) on delete set null,
  claim_token uuid,
  extraction_date date,
  lease_until timestamptz,
  primary key (user_id, input_id),
  check ((claim_token is null) = (extraction_date is null)),
  check ((claim_token is null) = (lease_until is null))
);

alter table app_private.pwa_extraction_claims enable row level security;
revoke all on app_private.pwa_extraction_claims from public, anon, authenticated, service_role;

create index if not exists pwa_extraction_claims_by_extraction_day
  on app_private.pwa_extraction_claims (user_id, extraction_date, lease_until)
  where claim_token is not null;

create or replace function app_private.lock_extraction_day(p_user_id uuid, p_extraction_date date)
returns void
language sql
set search_path = ''
as $$
  select pg_advisory_xact_lock(hashtextextended(
    'extraction-day:' || p_user_id::text || ':' || (p_extraction_date - date '2000-01-01')::text, 0
  ));
$$;

create or replace function app_private.has_extraction_capacity(
  p_user_id uuid, p_extraction_date date, p_daily_limit integer
)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  checked_at timestamptz;
begin
  perform app_private.lock_extraction_day(p_user_id, p_extraction_date);
  checked_at := clock_timestamp();
  return coalesce((
    select usage.input_count from app_private.telegram_input_daily_usage as usage
    where usage.user_id = p_user_id and usage.usage_date = p_extraction_date
  ), 0) + (
    select count(*) from app_private.telegram_input_deliveries as delivery
    where delivery.user_id = p_user_id and delivery.extraction_date = p_extraction_date
      and delivery.completed_at is null and delivery.claim_token is not null
      and delivery.lease_until > checked_at
  ) + (
    select count(*) from app_private.pwa_extraction_claims as claim
    where claim.user_id = p_user_id and claim.extraction_date = p_extraction_date
      and claim.claim_token is not null and claim.lease_until > checked_at
  ) < p_daily_limit;
end;
$$;

create or replace function app_private.record_extraction_success(p_user_id uuid, p_extraction_date date)
returns void
language sql
set search_path = ''
as $$
  insert into app_private.telegram_input_daily_usage as usage (user_id, usage_date, input_count)
  values (p_user_id, p_extraction_date, 1)
  on conflict (user_id, usage_date) do update set input_count = usage.input_count + 1;
$$;

create or replace function public.reserve_pwa_extraction(
  p_workspace_id uuid, p_input_id uuid, p_daily_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  account_id uuid := auth.uid();
  receipt app_private.pwa_transaction_inputs%rowtype;
  reservation app_private.pwa_extraction_claims%rowtype;
  attempt_date date;
  next_claim uuid;
begin
  if p_input_id is null or p_daily_limit is null or p_daily_limit < 1 then
    return jsonb_build_object('status', 'forbidden');
  end if;

  perform 1 from public.workspace_members
  where user_id = account_id and workspace_id = p_workspace_id
  for key share;
  if not found then
    return jsonb_build_object('status', 'forbidden');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('pwa-input:' || account_id::text || ':' || p_input_id::text, 0));
  select * into receipt from app_private.pwa_transaction_inputs
  where user_id = account_id and input_id = p_input_id;
  if found then
    if receipt.workspace_id is distinct from p_workspace_id then
      return jsonb_build_object('status', 'conflict');
    end if;
    return jsonb_build_object('status', 'duplicate', 'count', receipt.transaction_count);
  end if;

  select * into reservation from app_private.pwa_extraction_claims
  where user_id = account_id and input_id = p_input_id;
  if found then
    if reservation.workspace_id is distinct from p_workspace_id then
      return jsonb_build_object('status', 'conflict');
    end if;
    if reservation.lease_until > clock_timestamp() then
      return jsonb_build_object('status', 'busy');
    end if;
  end if;

  attempt_date := (clock_timestamp() at time zone 'Asia/Jakarta')::date;
  if not app_private.has_extraction_capacity(account_id, attempt_date, p_daily_limit) then
    return jsonb_build_object('status', 'rate_limited');
  end if;

  next_claim := gen_random_uuid();
  insert into app_private.pwa_extraction_claims (
    user_id, input_id, workspace_id, claim_token, extraction_date, lease_until
  ) values (account_id, p_input_id, p_workspace_id, next_claim, attempt_date, clock_timestamp() + interval '90 seconds')
  on conflict (user_id, input_id) do update set claim_token = excluded.claim_token,
    extraction_date = excluded.extraction_date, lease_until = excluded.lease_until;
  return jsonb_build_object('status', 'ready', 'claim_token', next_claim);
end;
$$;

create or replace function public.release_pwa_extraction(p_input_id uuid, p_claim_token uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  account_id uuid := auth.uid();
  attempt_date date;
begin
  if account_id is null or p_input_id is null or p_claim_token is null then
    return;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('pwa-input:' || account_id::text || ':' || p_input_id::text, 0));
  select extraction_date into attempt_date from app_private.pwa_extraction_claims
  where user_id = account_id and input_id = p_input_id and claim_token = p_claim_token;
  if not found then
    return;
  end if;
  perform app_private.lock_extraction_day(account_id, attempt_date);
  update app_private.pwa_extraction_claims set claim_token = null, extraction_date = null, lease_until = null
  where user_id = account_id and input_id = p_input_id;
end;
$$;

create or replace function public.begin_telegram_input_in_workspace(
  p_telegram_user_id bigint,
  p_telegram_message_id bigint,
  p_reply_to_message_id bigint,
  p_workspace_type text,
  p_daily_limit integer,
  p_update_id bigint
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
  attempt_date date;
begin
  if p_telegram_user_id is null or p_telegram_user_id <= 0
    or p_telegram_message_id is null or p_telegram_message_id <= 0
    or p_daily_limit is null or p_daily_limit < 1 or p_update_id < 0 then
    return jsonb_build_object('status', 'not_found');
  end if;

  if p_update_id is not null then
    insert into app_private.telegram_extraction_updates (update_id) values (p_update_id)
    on conflict do nothing;
    if not found then
      return jsonb_build_object('status', 'duplicate');
    end if;
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

  attempt_date := (clock_timestamp() at time zone 'Asia/Jakarta')::date;
  if not app_private.has_extraction_capacity(account_id, attempt_date, p_daily_limit) then
    perform app_private.complete_telegram_input(p_telegram_user_id, p_telegram_message_id);
    return jsonb_build_object('status', 'rate_limited');
  end if;

  next_claim_token := gen_random_uuid();
  insert into app_private.telegram_input_deliveries (
    telegram_user_id, telegram_message_id, user_id, workspace_id, edit_prompt_message_id,
    claim_token, lease_until, extraction_update_id, extraction_date
  ) values (
    p_telegram_user_id, p_telegram_message_id, account_id, input_workspace_id, edit_prompt_id,
    next_claim_token, clock_timestamp() + interval '90 seconds', p_update_id, attempt_date
  )
  on conflict (telegram_user_id, telegram_message_id) do update set
    claim_token = excluded.claim_token, lease_until = excluded.lease_until,
    extraction_update_id = excluded.extraction_update_id, extraction_date = excluded.extraction_date;

  return jsonb_strip_nulls(jsonb_build_object(
    'status', 'ready', 'claim_token', next_claim_token, 'existing', existing_draft
  ));
end;
$$;

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
    p_telegram_user_id, p_telegram_message_id, p_reply_to_message_id, p_workspace_type, 80, null
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

  if delivery.extraction_date is not null then
    perform app_private.record_extraction_success(delivery.user_id, delivery.extraction_date);
  end if;
  perform app_private.complete_telegram_input(p_telegram_user_id, p_telegram_message_id);
  return jsonb_build_object(
    'status', case when target_id is null then 'saved' else 'edited' end, 'transactions', saved_transactions
  );
end;
$$;

create or replace function public.release_telegram_input(
  p_telegram_user_id bigint, p_telegram_message_id bigint, p_claim_token uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  delivery app_private.telegram_input_deliveries%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended('telegram-input:' || p_telegram_user_id::text, 0));
  select * into delivery from app_private.telegram_input_deliveries
  where telegram_user_id = p_telegram_user_id and telegram_message_id = p_telegram_message_id
    and claim_token = p_claim_token and completed_at is null;
  if not found then
    return;
  end if;

  if delivery.extraction_date is not null and delivery.user_id is not null then
    perform app_private.lock_extraction_day(delivery.user_id, delivery.extraction_date);
  end if;

  if delivery.extraction_update_id is not null then
    perform app_private.complete_telegram_input(p_telegram_user_id, p_telegram_message_id);
  else
    update app_private.telegram_input_deliveries set claim_token = null, lease_until = null, extraction_date = null
    where telegram_user_id = p_telegram_user_id and telegram_message_id = p_telegram_message_id;
  end if;
end;
$$;

create or replace function public.save_pwa_transactions(
  p_workspace_id uuid,
  p_input_id uuid,
  p_transactions jsonb,
  p_raw_input text,
  p_extraction_claim_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  account_id uuid := auth.uid();
  receipt app_private.pwa_transaction_inputs%rowtype;
  reservation app_private.pwa_extraction_claims%rowtype;
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

  select * into reservation from app_private.pwa_extraction_claims
  where user_id = account_id and input_id = p_input_id;
  if found and reservation.workspace_id is distinct from p_workspace_id then
    return jsonb_build_object('status', 'conflict', 'count', 0);
  end if;
  if p_extraction_claim_token is not null then
    if reservation.claim_token is distinct from p_extraction_claim_token then
      return jsonb_build_object('status', 'conflict', 'count', 0);
    end if;
    perform app_private.lock_extraction_day(account_id, reservation.extraction_date);
    if reservation.lease_until <= clock_timestamp() then
      return jsonb_build_object('status', 'conflict', 'count', 0);
    end if;
  end if;

  if jsonb_typeof(p_transactions) is distinct from 'array' then
    raise exception 'Rincian transaksi tidak valid.' using errcode = '22023';
  end if;
  saved_count := jsonb_array_length(p_transactions);
  if saved_count = 0 then
    raise exception 'Rincian transaksi belum tersedia.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('workspace-wallets:' || p_workspace_id::text, 0));
  begin
    for draft in select value from jsonb_array_elements(p_transactions) loop
      if jsonb_typeof(draft->'amount') is distinct from 'string'
        or draft->>'amount' !~ '^[1-9][0-9]*$'
        or jsonb_typeof(draft->'item') is distinct from 'string' then
        raise exception 'Nominal atau nama transaksi tidak valid.' using errcode = '22023';
      end if;

      if draft->>'wallet_id' is not null then
        select wallet.id into draft_wallet_id from public.wallets as wallet
        where wallet.id = (draft->>'wallet_id')::uuid and wallet.workspace_id = p_workspace_id
          and wallet.archived_at is null and wallet.type = draft->>'wallet_type'
        for key share;
        if draft_wallet_id is null then
          raise exception 'Dompet transaksi tidak tersedia.' using errcode = 'DW001';
        end if;
      else
        draft_wallet_id := app_private.resolve_transaction_wallet(
          p_workspace_id, draft->>'wallet_type', null
        );
        if draft_wallet_id is null then
          raise exception 'Dompet transaksi tidak tersedia.' using errcode = '22023';
        end if;
      end if;

      insert into public.transactions (
        workspace_id, wallet_id, created_by, item, amount, type, category, occurred_at, raw_input
      ) values (
        p_workspace_id, draft_wallet_id, account_id, btrim(draft->>'item'), (draft->>'amount')::bigint,
        draft->>'type', draft->>'category', statement_timestamp(), p_raw_input
      );
    end loop;
  exception
    when sqlstate 'DW001' or invalid_text_representation then
      return jsonb_build_object('status', 'invalid_wallet', 'count', 0);
  end;

  insert into app_private.pwa_transaction_inputs (user_id, input_id, workspace_id, transaction_count)
  values (account_id, p_input_id, p_workspace_id, saved_count);

  if p_extraction_claim_token is not null then
    perform app_private.record_extraction_success(account_id, reservation.extraction_date);
    update app_private.pwa_extraction_claims set claim_token = null, extraction_date = null, lease_until = null
    where user_id = account_id and input_id = p_input_id;
  end if;

  return jsonb_build_object('status', 'saved', 'count', saved_count);
end;
$$;

create or replace function public.save_pwa_transactions(
  p_workspace_id uuid, p_input_id uuid, p_transactions jsonb, p_raw_input text
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public.save_pwa_transactions(p_workspace_id, p_input_id, p_transactions, p_raw_input, null);
$$;

revoke all on function app_private.lock_extraction_day(uuid, date),
  app_private.has_extraction_capacity(uuid, date, integer), app_private.record_extraction_success(uuid, date),
  public.reserve_pwa_extraction(uuid, uuid, integer), public.release_pwa_extraction(uuid, uuid),
  public.save_pwa_transactions(uuid, uuid, jsonb, text, uuid),
  public.begin_telegram_input_in_workspace(bigint, bigint, bigint, text, integer, bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.reserve_pwa_extraction(uuid, uuid, integer),
  public.release_pwa_extraction(uuid, uuid), public.save_pwa_transactions(uuid, uuid, jsonb, text, uuid)
  to authenticated;
grant execute on function public.begin_telegram_input_in_workspace(bigint, bigint, bigint, text, integer, bigint)
  to service_role;
