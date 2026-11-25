create table if not exists app_private.pwa_transaction_inputs (
  user_id uuid not null references auth.users(id) on delete cascade,
  input_id uuid not null,
  workspace_id uuid references public.workspaces(id) on delete set null,
  transaction_count integer not null check (transaction_count > 0),
  primary key (user_id, input_id)
);

create index if not exists pwa_transaction_inputs_by_workspace
  on app_private.pwa_transaction_inputs (workspace_id) where workspace_id is not null;

alter table app_private.pwa_transaction_inputs enable row level security;
revoke all on app_private.pwa_transaction_inputs from public, anon, authenticated, service_role;

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

    select wallet.id into draft_wallet_id from public.wallets as wallet
    where wallet.workspace_id = p_workspace_id and wallet.type = draft->>'wallet_type'
    order by (wallet.name = case wallet.type
      when 'cash' then 'Tunai' when 'bank' then 'Bank' when 'ewallet' then 'E-Wallet'
    end) desc, wallet.id
    limit 1;
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

revoke all on function public.save_pwa_transactions(uuid, uuid, jsonb, text)
  from public, anon, authenticated, service_role;
grant execute on function public.save_pwa_transactions(uuid, uuid, jsonb, text) to authenticated;
