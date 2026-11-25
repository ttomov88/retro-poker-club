-- Forgot password: email + current Google Authenticator code → new password.
-- The TOTP secret never leaves the database; the code is checked here.
alter table public.members
  add column if not exists reset_attempts int not null default 0,
  add column if not exists reset_locked_until timestamptz,
  add column if not exists reset_last_step bigint;

create function public.base32_decode(s text) returns bytea
language plpgsql immutable set search_path = '' as $$
declare
  alphabet constant text := 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  clean text := upper(replace(replace(s, '=', ''), ' ', ''));
  bits text := '';
  out bytea := ''::bytea;
  i int; v int;
begin
  for i in 1..length(clean) loop
    v := strpos(alphabet, substr(clean, i, 1)) - 1;
    if v < 0 then raise exception 'bad base32'; end if;
    bits := bits || v::bit(5)::text;
  end loop;
  i := 1;
  while i + 7 <= length(bits) loop
    out := out || set_byte('\x00'::bytea, 0, substr(bits, i, 8)::bit(8)::int);
    i := i + 8;
  end loop;
  return out;
end $$;

-- RFC 6238 TOTP (SHA-1, 6 digits, 30 s steps) — verified against the RFC test vectors
create function public.totp_code(secret bytea, step bigint) returns text
language plpgsql immutable set search_path = '' as $$
declare h bytea; off int; bin bigint;
begin
  h := extensions.hmac(int8send(step), secret, 'sha1');
  off := get_byte(h, 19) & 15;
  bin := ((get_byte(h, off) & 127)::bigint << 24) | (get_byte(h, off + 1)::bigint << 16)
       | (get_byte(h, off + 2)::bigint << 8) | get_byte(h, off + 3)::bigint;
  return lpad((bin % 1000000)::text, 6, '0');
end $$;

-- Returns 'ok:<user id>' (and signs the account out everywhere), 'invalid' or 'locked'.
-- 5 wrong codes lock it for 15 minutes; a code can't be used twice.
create function public.reset_prepare(p_email text, p_code text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  e text := lower(btrim(p_email));
  m public.members;
  sec text;
  now_step bigint := floor(extract(epoch from now()) / 30);
  k int;
  hit bigint := null;
begin
  select * into m from public.members where email = e and user_id is not null;
  if not found then return 'invalid'; end if;
  if m.reset_locked_until > now() then return 'locked'; end if;
  select f.secret into sec from auth.mfa_factors f
    where f.user_id = m.user_id and f.factor_type = 'totp' and f.status = 'verified'
    order by f.created_at desc limit 1;
  if sec is not null and p_code ~ '^\d{6}$' then
    for k in -1..1 loop
      if now_step + k > coalesce(m.reset_last_step, 0)
         and public.totp_code(public.base32_decode(sec), now_step + k) = p_code then
        hit := now_step + k;
        exit;
      end if;
    end loop;
  end if;
  if hit is null then
    update public.members set
      reset_attempts = case when reset_attempts + 1 >= 5 then 0 else reset_attempts + 1 end,
      reset_locked_until = case when reset_attempts + 1 >= 5 then now() + interval '15 minutes' else reset_locked_until end
      where email = e;
    return 'invalid';
  end if;
  update public.members set reset_attempts = 0, reset_locked_until = null, reset_last_step = hit where email = e;
  delete from auth.sessions where user_id = m.user_id; -- sign out on every phone
  return 'ok:' || m.user_id;
end $$;

revoke execute on function public.base32_decode(text), public.totp_code(bytea, bigint) from public, anon, authenticated;
revoke execute on function public.reset_prepare(text, text) from public, anon, authenticated;
grant execute on function public.reset_prepare(text, text) to service_role;
