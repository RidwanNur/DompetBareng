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
