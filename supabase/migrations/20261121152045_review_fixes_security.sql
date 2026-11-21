-- 1. Tighter grants (TRUNCATE etc. not needed)
revoke truncate, trigger, references on public.members, public.players, public.nights, public.chips from authenticated, anon;

-- 2. Invite codes: an invite (new or reset) is only claimable with a 6-digit code the admin passes on
alter table public.members
  add column if not exists invite_hash text,
  add column if not exists invite_expires timestamptz,
  add column if not exists invite_attempts int not null default 0;

revoke select on public.members from authenticated;
grant select (email, role, user_id, created_at, invite_expires) on public.members to authenticated;
revoke insert on public.members from authenticated;
revoke update on public.members from authenticated;
grant update (role) on public.members to authenticated;
drop policy if exists "editors add" on public.members;

create function public.new_invite_code() returns text
language sql volatile set search_path = '' as $$
  select lpad(((('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint) % 1000000)::text, 6, '0')
$$;
revoke execute on function public.new_invite_code() from public, anon, authenticated;

-- Add a member (or re-invite an unclaimed one); returns the code to pass on.
create function public.invite_member(p_email text, p_role text) returns text
language plpgsql security definer set search_path = '' as $$
declare e text := lower(btrim(p_email)); code text := public.new_invite_code(); existing public.members;
begin
  if not public.is_editor() then raise exception 'Only admins can invite'; end if;
  if p_role not in ('admin','viewer') then raise exception 'Bad role'; end if;
  if e !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then raise exception 'Enter a valid email'; end if;
  select * into existing from public.members where email = e;
  if found then
    if existing.user_id is not null or existing.role = 'owner' then raise exception 'already a member'; end if;
    update public.members set role = p_role, invite_hash = extensions.crypt(code, extensions.gen_salt('bf')),
      invite_expires = now() + interval '7 days', invite_attempts = 0 where email = e;
  else
    insert into public.members(email, role, invite_hash, invite_expires)
      values (e, p_role, extensions.crypt(code, extensions.gen_salt('bf')), now() + interval '7 days');
  end if;
  return code;
end $$;

-- Reset someone's login (forgot password / lost phone): unlinks the account, returns a new code.
create function public.reset_member_login(p_email text) returns text
language plpgsql security definer set search_path = '' as $$
declare e text := lower(btrim(p_email)); code text := public.new_invite_code(); m public.members;
begin
  if not public.is_editor() then raise exception 'Only admins can reset logins'; end if;
  select * into m from public.members where email = e;
  if not found then raise exception 'Not a member'; end if;
  if m.role = 'owner' then raise exception 'The owner login cannot be reset here'; end if;
  update public.members set user_id = null, invite_hash = extensions.crypt(code, extensions.gen_salt('bf')),
    invite_expires = now() + interval '7 days', invite_attempts = 0 where email = e;
  if m.user_id is not null then delete from auth.users where id = m.user_id; end if;
  return code;
end $$;

revoke execute on function public.invite_member(text, text), public.reset_member_login(text) from public, anon;
grant execute on function public.invite_member(text, text), public.reset_member_login(text) to authenticated;

-- Claim needs the code; 5 wrong tries lock the invite until a new code is made.
drop function if exists public.claim_prepare(text);
create function public.claim_prepare(p_email text, p_code text) returns text
language plpgsql security definer set search_path = '' as $$
declare e text := lower(btrim(p_email)); m public.members;
begin
  select * into m from public.members where email = e and user_id is null;
  if not found or m.invite_hash is null then return 'not_invited'; end if;
  if m.invite_expires < now() then return 'expired'; end if;
  if m.invite_attempts >= 5 then return 'locked'; end if;
  if m.invite_hash <> extensions.crypt(coalesce(p_code, ''), m.invite_hash) then
    update public.members set invite_attempts = invite_attempts + 1 where email = e;
    return 'wrong_code';
  end if;
  delete from auth.users where lower(email) = e;
  return 'ok';
end $$;
revoke execute on function public.claim_prepare(text, text) from public, anon, authenticated;
grant execute on function public.claim_prepare(text, text) to service_role;

create or replace function public.only_listed_signups() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.members m where m.email = lower(new.email) and m.user_id is null
                 and m.invite_hash is not null and m.invite_expires >= now()) then
    raise exception 'This email is not invited to Retro Poker Club';
  end if;
  return new;
end $$;
revoke execute on function public.only_listed_signups() from public, anon, authenticated;

create or replace function public.members_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user in ('authenticated','anon') then
    if new.email <> old.email or new.user_id is distinct from old.user_id
       or new.invite_hash is distinct from old.invite_hash then
      raise exception 'Not allowed';
    end if;
  end if;
  return new;
end $$;

-- 3. Import: owner only, validates event dates
create or replace function public.import_all(payload jsonb) returns void
language plpgsql security definer set search_path = '' as $function$
declare t text; r jsonb;
begin
  if not (public.is_editor() and public.app_role() = 'owner') then raise exception 'Only the owner can import'; end if;
  perform public.take_backup();
  delete from public.nights; delete from public.players; delete from public.chips;
  foreach t in array array['players','nights','chips'] loop
    for r in select * from jsonb_array_elements(coalesce(payload -> t, '[]'::jsonb)) loop
      if jsonb_typeof(r) <> 'object' or jsonb_typeof(r -> 'id') <> 'number' then
        raise exception 'The backup has damaged % records. Nothing was changed.', t;
      end if;
      if t = 'nights' and coalesce(r ->> 'date', '') !~ '^\d{4}-\d{2}-\d{2}$' then
        raise exception 'The backup has an event with a bad date. Nothing was changed.';
      end if;
      execute format('insert into public.%I (id, data) values ($1, $2)', t)
        using (r ->> 'id')::bigint, (r - 'id' - '_v');
    end loop;
    execute format('select setval(pg_get_serial_sequence(%L, ''id''), coalesce((select max(id) from public.%I), 0) + 1, false)',
                   'public.' || t, t);
  end loop;
end $function$;

-- 4. Event dates must look like a date (blocks script injection via the date field)
alter table public.nights add constraint nights_date_format
  check ((data ->> 'date') ~ '^\d{4}-\d{2}-\d{2}$') not valid;
alter table public.nights validate constraint nights_date_format;

-- 5. Rename a player everywhere in one transaction
create function public.rename_player(p_id bigint, p_name text) returns void
language plpgsql security invoker set search_path = '' as $$
declare n text := btrim(p_name);
begin
  if not public.is_editor() then raise exception 'Only admins can rename'; end if;
  if n = '' then raise exception 'Name required'; end if;
  update public.players set data = data || jsonb_build_object('name', n) where id = p_id;
  update public.nights set data = jsonb_set(data, '{players}', (
      select jsonb_agg(case when (e ->> 'playerId')::bigint = p_id then e || jsonb_build_object('name', n) else e end order by ord)
      from jsonb_array_elements(data -> 'players') with ordinality as x(e, ord)))
  where data -> 'players' @> jsonb_build_array(jsonb_build_object('playerId', p_id));
end $$;
revoke execute on function public.rename_player(bigint, text) from public, anon;
grant execute on function public.rename_player(bigint, text) to authenticated;
