begin;

create schema if not exists app_private;
revoke all on schema app_private from public, anon, authenticated, service_role;

create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  type text not null check (type in ('personal', 'household')),
  name text not null
);

create unique index if not exists workspaces_one_personal_per_owner
  on public.workspaces (owner_id) where type = 'personal';

create table if not exists public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  primary key (workspace_id, user_id)
);

create index if not exists workspace_members_by_user
  on public.workspace_members (user_id, workspace_id);

create table if not exists public.wallets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  type text not null check (type in ('cash', 'bank', 'ewallet')),
  name text not null
);

create index if not exists wallets_by_workspace on public.wallets (workspace_id);

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.wallets enable row level security;

revoke all on public.workspaces, public.workspace_members, public.wallets
  from public, anon, authenticated, service_role;
grant select on public.workspaces, public.workspace_members, public.wallets to authenticated;

drop policy if exists workspace_members_select_own on public.workspace_members;
create policy workspace_members_select_own on public.workspace_members
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists workspaces_select_member on public.workspaces;
create policy workspaces_select_member on public.workspaces
  for select to authenticated using (exists (
    select 1
    from public.workspace_members as member
    where member.workspace_id = workspaces.id and member.user_id = (select auth.uid())
  ));

drop policy if exists wallets_select_member on public.wallets;
create policy wallets_select_member on public.wallets
  for select to authenticated using (exists (
    select 1
    from public.workspace_members as member
    where member.workspace_id = wallets.workspace_id and member.user_id = (select auth.uid())
  ));

create or replace function app_private.create_personal_workspace(account_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  personal_workspace_id uuid;
begin
  insert into public.workspaces (owner_id, type, name)
  values (account_id, 'personal', 'Pribadi')
  on conflict (owner_id) where type = 'personal' do nothing
  returning id into personal_workspace_id;

  if personal_workspace_id is null then
    return;
  end if;

  insert into public.workspace_members (workspace_id, user_id)
  values (personal_workspace_id, account_id);

  insert into public.wallets (workspace_id, type, name) values
    (personal_workspace_id, 'cash', 'Tunai'),
    (personal_workspace_id, 'bank', 'Bank'),
    (personal_workspace_id, 'ewallet', 'E-Wallet');
end;
$$;

create or replace function app_private.initialize_dompetbareng_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app_private.create_personal_workspace(new.id);
  return new;
end;
$$;

revoke all on function app_private.create_personal_workspace(uuid),
  app_private.initialize_dompetbareng_user() from public, anon, authenticated, service_role;

drop trigger if exists initialize_dompetbareng_user on auth.users;
create trigger initialize_dompetbareng_user
  after insert on auth.users
  for each row execute function app_private.initialize_dompetbareng_user();

do $$
declare
  account_id uuid;
begin
  for account_id in
    select account.id from auth.users as account
    where not exists (
      select 1 from public.workspaces as workspace
      where workspace.owner_id = account.id and workspace.type = 'personal'
    )
  loop
    perform app_private.create_personal_workspace(account_id);
  end loop;
end;
$$;

create table if not exists app_private.telegram_links (
  user_id uuid primary key references auth.users(id) on delete cascade,
  telegram_user_id bigint not null unique check (telegram_user_id > 0)
);

create table if not exists app_private.telegram_link_tokens (
  user_id uuid primary key references auth.users(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null
);

-- ID pesan Telegram unik dalam satu chat pribadi.
create table if not exists app_private.telegram_link_deliveries (
  telegram_user_id bigint not null check (telegram_user_id > 0),
  telegram_message_id bigint not null check (telegram_message_id > 0),
  primary key (telegram_user_id, telegram_message_id)
);

alter table app_private.telegram_links enable row level security;
alter table app_private.telegram_link_tokens enable row level security;
alter table app_private.telegram_link_deliveries enable row level security;

revoke all on app_private.telegram_links, app_private.telegram_link_tokens,
  app_private.telegram_link_deliveries from public, anon, authenticated, service_role;

create or replace function public.get_telegram_link_status()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app_private.telegram_links where user_id = auth.uid()
  );
$$;

create or replace function public.issue_telegram_link(p_token_hash text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  account_id uuid := auth.uid();
begin
  if account_id is null then
    raise exception 'Sesi autentikasi diperlukan.' using errcode = '42501';
  end if;

  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Hash kode Telegram tidak valid.' using errcode = '22023';
  end if;

  -- Penerbitan dan penukaran kode memakai kunci yang sama untuk setiap akun.
  perform pg_advisory_xact_lock(hashtextextended('telegram-link:' || account_id::text, 0));

  if exists (select 1 from app_private.telegram_links where user_id = account_id) then
    return false;
  end if;

  insert into app_private.telegram_link_tokens (user_id, token_hash, expires_at)
  values (account_id, p_token_hash, clock_timestamp() + interval '10 minutes')
  on conflict (user_id) do update set
    token_hash = excluded.token_hash,
    expires_at = excluded.expires_at;

  return true;
end;
$$;

create or replace function public.redeem_telegram_link(
  p_token_hash text,
  p_telegram_user_id bigint,
  p_telegram_message_id bigint
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  account_id uuid;
begin
  if p_telegram_user_id is null or p_telegram_user_id <= 0
    or p_telegram_message_id is null or p_telegram_message_id <= 0 then
    return 'invalid';
  end if;

  insert into app_private.telegram_link_deliveries (telegram_user_id, telegram_message_id)
  values (p_telegram_user_id, p_telegram_message_id)
  on conflict do nothing;

  if not found then
    return 'duplicate';
  end if;

  select user_id into account_id
  from app_private.telegram_link_tokens
  where token_hash = p_token_hash and expires_at > clock_timestamp();

  if not found then
    return 'invalid';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('telegram-link:' || account_id::text, 0));

  -- Kode bisa diganti atau kedaluwarsa ketika penukaran menunggu kunci.
  if not exists (
    select 1 from app_private.telegram_link_tokens
    where user_id = account_id and token_hash = p_token_hash and expires_at > clock_timestamp()
  ) then
    return 'invalid';
  end if;

  if exists (select 1 from app_private.telegram_links where user_id = account_id) then
    return 'already_linked';
  end if;

  insert into app_private.telegram_links (user_id, telegram_user_id)
  values (account_id, p_telegram_user_id)
  on conflict (telegram_user_id) do nothing;

  if not found then
    return 'telegram_in_use';
  end if;

  delete from app_private.telegram_link_tokens where user_id = account_id;
  return 'linked';
end;
$$;

revoke all on function public.get_telegram_link_status(), public.issue_telegram_link(text),
  public.redeem_telegram_link(text, bigint, bigint) from public, anon, authenticated, service_role;
grant execute on function public.get_telegram_link_status(), public.issue_telegram_link(text)
  to authenticated;
grant execute on function public.redeem_telegram_link(text, bigint, bigint) to service_role;

create unique index if not exists workspaces_one_household_per_owner
  on public.workspaces (owner_id) where type = 'household';

create table if not exists app_private.active_workspaces (
  user_id uuid primary key,
  workspace_id uuid not null,
  foreign key (workspace_id, user_id)
    references public.workspace_members(workspace_id, user_id) on delete cascade
);

create table if not exists app_private.household_invites (
  code text primary key check (code ~ '^[0-9]{6}$'),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  expires_at timestamptz not null,
  active boolean not null default true
);

create index if not exists household_invites_by_workspace
  on app_private.household_invites (workspace_id);
create unique index if not exists household_invites_one_active_per_workspace
  on app_private.household_invites (workspace_id) where active;

create table if not exists app_private.household_join_failures (
  user_id uuid primary key references auth.users(id) on delete cascade,
  window_started_at timestamptz not null,
  failed_attempts smallint not null check (failed_attempts between 1 and 5)
);

alter table app_private.active_workspaces enable row level security;
alter table app_private.household_invites enable row level security;
alter table app_private.household_join_failures enable row level security;
revoke all on app_private.active_workspaces, app_private.household_invites,
  app_private.household_join_failures from public, anon, authenticated, service_role;

create or replace function public.get_workspace_state()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with account as (
    select auth.uid() as id
  ),
  personal as (
    select workspace.id, workspace.name, workspace.type
    from public.workspaces as workspace, account
    where workspace.owner_id = account.id and workspace.type = 'personal'
  ),
  household as (
    select workspace.id, workspace.name, workspace.type,
      workspace.owner_id = account.id as is_owner,
      (select count(*) from public.workspace_members as other_member
        where other_member.workspace_id = workspace.id) as member_count
    from public.workspace_members as member
    join public.workspaces as workspace on workspace.id = member.workspace_id
    join account on account.id = member.user_id
    where workspace.type = 'household'
  ),
  invitation as (
    select invite.code, invite.expires_at
    from app_private.household_invites as invite
    join household on household.id = invite.workspace_id
    where household.is_owner and household.member_count = 1
      and invite.active and invite.expires_at > statement_timestamp()
  )
  select jsonb_build_object(
    'personal', (select to_jsonb(personal) from personal),
    'household', (select to_jsonb(household) from household),
    'active_workspace_id', coalesce(
      (select selection.workspace_id from app_private.active_workspaces as selection
        join account on account.id = selection.user_id),
      (select id from personal)
    ),
    'invitation', (select to_jsonb(invitation) from invitation)
  );
$$;

create or replace function public.set_active_workspace(p_workspace_id uuid)
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
    return 'not_member';
  end if;

  insert into app_private.active_workspaces (user_id, workspace_id)
  values (account_id, p_workspace_id)
  on conflict (user_id) do update set workspace_id = excluded.workspace_id;

  return 'ok';
end;
$$;

create or replace function app_private.random_household_code()
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  entropy bytea;
  sample integer;
begin
  loop
    -- Tiga byte pertama UUID v4 acak. Buang sisanya yang tidak terbagi rata.
    entropy := uuid_send(gen_random_uuid());
    sample := get_byte(entropy, 0) * 65536 + get_byte(entropy, 1) * 256 + get_byte(entropy, 2);
    if sample < 16000000 then
      return lpad((sample % 1000000)::text, 6, '0');
    end if;
  end loop;
end;
$$;

create or replace function public.issue_household_invite()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  account_id uuid := auth.uid();
  household_id uuid;
  household_owner_id uuid;
  previous_code text;
  candidate_code text;
begin
  if account_id is null then
    raise exception 'Sesi autentikasi diperlukan.' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('household-member:' || account_id::text, 0));

  select workspace.id, workspace.owner_id into household_id, household_owner_id
  from public.workspace_members as member
  join public.workspaces as workspace on workspace.id = member.workspace_id
  where member.user_id = account_id and workspace.type = 'household';

  if household_id is null then
    insert into public.workspaces (owner_id, type, name)
    values (account_id, 'household', 'Rumah Tangga') returning id into household_id;

    insert into public.workspace_members (workspace_id, user_id)
    values (household_id, account_id);
  elsif household_owner_id <> account_id then
    return 'not_owner';
  end if;

  -- Bergabung dan menerbitkan ulang kode memakai kunci ruang yang sama.
  perform 1 from public.workspaces where id = household_id for no key update;

  if (select count(*) from public.workspace_members where workspace_id = household_id) >= 2 then
    return 'household_full';
  end if;

  -- Serialkan alokasi kode yang juga dapat membebaskan kode kedaluwarsa.
  perform pg_advisory_xact_lock(hashtextextended('household-code-allocation', 0));

  update app_private.household_invites set active = false
  where workspace_id = household_id and active returning code into previous_code;

  for attempt in 1..128 loop
    candidate_code := app_private.random_household_code();
    if candidate_code = previous_code then
      continue;
    end if;

    delete from app_private.household_invites
    where code = candidate_code and expires_at <= clock_timestamp();

    insert into app_private.household_invites (code, workspace_id, expires_at)
    values (candidate_code, household_id, clock_timestamp() + interval '24 hours')
    on conflict (code) do nothing;

    if found then
      perform public.set_active_workspace(household_id);
      return 'ok';
    end if;
  end loop;

  raise exception 'Kode undangan belum dapat dibuat.' using errcode = '54000';
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
  attempted_at timestamptz;
  failure_window timestamptz;
  failure_count smallint;
begin
  if account_id is null then
    raise exception 'Sesi autentikasi diperlukan.' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('household-member:' || account_id::text, 0));

  if exists (
    select 1 from public.workspace_members as member
    join public.workspaces as workspace on workspace.id = member.workspace_id
    where member.user_id = account_id and workspace.type = 'household'
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

  if household_id is not null then
    perform 1 from public.workspaces
    where id = household_id and type = 'household' for no key update;

    -- Validasi ulang setelah menunggu perubahan yang mungkin terjadi pada ruang atau kode.
    if found and (select count(*) from public.workspace_members where workspace_id = household_id) < 2 then
      update app_private.household_invites set active = false
      where code = p_code and workspace_id = household_id and active and expires_at > clock_timestamp();

      if found then
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

revoke all on function app_private.random_household_code(), public.get_workspace_state(),
  public.set_active_workspace(uuid), public.issue_household_invite(), public.join_household(text)
  from public, anon, authenticated, service_role;
grant execute on function public.get_workspace_state(), public.set_active_workspace(uuid),
  public.issue_household_invite(), public.join_household(text) to authenticated;

create or replace function app_private.add_household_wallets()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.wallets (workspace_id, type, name) values
    (new.id, 'cash', 'Tunai'),
    (new.id, 'bank', 'Bank'),
    (new.id, 'ewallet', 'E-Wallet');
  return new;
end;
$$;

revoke all on function app_private.add_household_wallets()
  from public, anon, authenticated, service_role;
drop trigger if exists add_household_wallets on public.workspaces;
create trigger add_household_wallets
  after insert on public.workspaces
  for each row when (new.type = 'household')
  execute function app_private.add_household_wallets();

insert into public.wallets (workspace_id, type, name)
select workspace.id, default_wallet.type, default_wallet.name
from public.workspaces as workspace
cross join (values
  ('cash', 'Tunai'), ('bank', 'Bank'), ('ewallet', 'E-Wallet')
) as default_wallet(type, name)
where workspace.type = 'household' and not exists (
  select 1 from public.wallets as wallet
  where wallet.workspace_id = workspace.id and wallet.type = default_wallet.type
);

create unique index if not exists wallets_id_workspace_key
  on public.wallets (id, workspace_id);

create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  wallet_id uuid not null,
  created_by uuid not null references auth.users(id) on delete cascade,
  item text not null check (length(btrim(item)) > 0),
  amount bigint not null check (amount > 0),
  type text not null,
  category text not null,
  occurred_at timestamptz not null,
  raw_input text,
  foreign key (wallet_id, workspace_id) references public.wallets(id, workspace_id),
  check (
    (type = 'income' and category in (
      'Gaji', 'Bonus & Tunjangan', 'Usaha / Sampingan', 'Hadiah / Transfer Masuk', 'Lainnya'
    ))
    or
    (type = 'expense' and category in (
      'Makan & Minum', 'Belanja Harian', 'Transportasi', 'Tagihan & Utilitas',
      'Rumah Tangga', 'Kesehatan', 'Hiburan & Gaya Hidup', 'Pendidikan',
      'Sosial & Hadiah', 'Lainnya'
    ))
  )
);

create index if not exists transactions_by_workspace_date
  on public.transactions (workspace_id, occurred_at desc, id);
create index if not exists transactions_by_wallet on public.transactions (wallet_id);
create index if not exists transactions_by_creator on public.transactions (created_by);

alter table public.transactions enable row level security;
revoke all on public.transactions from public, anon, authenticated, service_role;
grant select on public.transactions to authenticated;

drop policy if exists transactions_select_member on public.transactions;
create policy transactions_select_member on public.transactions
  for select to authenticated using (exists (
    select 1 from public.workspace_members as member
    where member.workspace_id = transactions.workspace_id and member.user_id = (select auth.uid())
  ));

create table if not exists app_private.telegram_input_daily_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  usage_date date not null,
  input_count smallint not null check (input_count between 1 and 30),
  primary key (user_id, usage_date)
);

-- Pertahankan konteks prompt setelah transaksi dihapus atau prompt dipakai.
create table if not exists app_private.telegram_edit_prompts (
  telegram_user_id bigint not null check (telegram_user_id > 0),
  prompt_message_id bigint not null check (prompt_message_id > 0),
  transaction_id uuid not null,
  spent_at timestamptz,
  primary key (telegram_user_id, prompt_message_id)
);

create table if not exists app_private.telegram_input_deliveries (
  telegram_user_id bigint not null check (telegram_user_id > 0),
  telegram_message_id bigint not null check (telegram_message_id > 0),
  user_id uuid references auth.users(id) on delete set null,
  workspace_id uuid references public.workspaces(id) on delete set null,
  edit_prompt_message_id bigint,
  claim_token uuid,
  lease_until timestamptz,
  completed_at timestamptz,
  primary key (telegram_user_id, telegram_message_id),
  foreign key (telegram_user_id, edit_prompt_message_id)
    references app_private.telegram_edit_prompts(telegram_user_id, prompt_message_id),
  check ((claim_token is null) = (lease_until is null)),
  check (completed_at is null or claim_token is null)
);

alter table app_private.telegram_input_daily_usage enable row level security;
alter table app_private.telegram_edit_prompts enable row level security;
alter table app_private.telegram_input_deliveries enable row level security;
revoke all on app_private.telegram_input_daily_usage, app_private.telegram_edit_prompts,
  app_private.telegram_input_deliveries from public, anon, authenticated, service_role;

create or replace function app_private.complete_telegram_input(
  p_telegram_user_id bigint, p_telegram_message_id bigint
)
returns void
language sql
set search_path = ''
as $$
  insert into app_private.telegram_input_deliveries (telegram_user_id, telegram_message_id, completed_at)
  values (p_telegram_user_id, p_telegram_message_id, clock_timestamp())
  on conflict (telegram_user_id, telegram_message_id) do update set
    completed_at = excluded.completed_at, claim_token = null, lease_until = null;
$$;

revoke all on function app_private.complete_telegram_input(bigint, bigint)
  from public, anon, authenticated, service_role;

create or replace function public.begin_telegram_input(
  p_telegram_user_id bigint,
  p_telegram_message_id bigint,
  p_reply_to_message_id bigint default null
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

    select wallet.id into draft_wallet_id from public.wallets as wallet
    where wallet.workspace_id = delivery.workspace_id and wallet.type = draft->>'wallet_type'
    order by (wallet.id = target_wallet_id) desc nulls last, (wallet.name = case wallet.type
      when 'cash' then 'Tunai' when 'bank' then 'Bank' when 'ewallet' then 'E-Wallet'
    end) desc, wallet.id
    limit 1;
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

create or replace function public.release_telegram_input(
  p_telegram_user_id bigint, p_telegram_message_id bigint, p_claim_token uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('telegram-input:' || p_telegram_user_id::text, 0));
  update app_private.telegram_input_deliveries set claim_token = null, lease_until = null
  where telegram_user_id = p_telegram_user_id and telegram_message_id = p_telegram_message_id
    and claim_token = p_claim_token and completed_at is null;
end;
$$;

create or replace function public.get_telegram_edit_target(p_telegram_user_id bigint, p_transaction_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select entry.item from public.transactions as entry
  join app_private.telegram_links as link on link.user_id = entry.created_by
  join public.workspace_members as member on member.workspace_id = entry.workspace_id and member.user_id = link.user_id
  where link.telegram_user_id = p_telegram_user_id and entry.id = p_transaction_id;
$$;

create or replace function public.save_telegram_edit_prompt(
  p_telegram_user_id bigint, p_prompt_message_id bigint, p_transaction_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_prompt_message_id is null or p_prompt_message_id <= 0
    or public.get_telegram_edit_target(p_telegram_user_id, p_transaction_id) is null then
    return false;
  end if;

  insert into app_private.telegram_edit_prompts (telegram_user_id, prompt_message_id, transaction_id)
  values (p_telegram_user_id, p_prompt_message_id, p_transaction_id)
  on conflict do nothing;

  return found or exists (
    select 1 from app_private.telegram_edit_prompts
    where telegram_user_id = p_telegram_user_id and prompt_message_id = p_prompt_message_id
      and transaction_id = p_transaction_id and spent_at is null
  );
end;
$$;

create or replace function public.delete_telegram_transaction(p_telegram_user_id bigint, p_transaction_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('telegram-input:' || p_telegram_user_id::text, 0));
  perform 1 from public.transactions as entry
  join app_private.telegram_links as link on link.user_id = entry.created_by
  join public.workspace_members as member on member.workspace_id = entry.workspace_id and member.user_id = link.user_id
  where link.telegram_user_id = p_telegram_user_id and entry.id = p_transaction_id
  for key share of member;
  if not found then
    return false;
  end if;

  delete from public.transactions where id = p_transaction_id;
  return found;
end;
$$;

revoke all on function public.begin_telegram_input(bigint, bigint, bigint),
  public.finish_telegram_input(bigint, bigint, uuid, jsonb, text, timestamptz),
  public.release_telegram_input(bigint, bigint, uuid), public.get_telegram_edit_target(bigint, uuid),
  public.save_telegram_edit_prompt(bigint, bigint, uuid), public.delete_telegram_transaction(bigint, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.begin_telegram_input(bigint, bigint, bigint),
  public.finish_telegram_input(bigint, bigint, uuid, jsonb, text, timestamptz),
  public.release_telegram_input(bigint, bigint, uuid), public.get_telegram_edit_target(bigint, uuid),
  public.save_telegram_edit_prompt(bigint, bigint, uuid), public.delete_telegram_transaction(bigint, uuid)
  to service_role;

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

commit;
