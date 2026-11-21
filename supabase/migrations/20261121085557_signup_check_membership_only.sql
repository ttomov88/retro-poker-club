create or replace function public.only_listed_signups() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.members m where m.email = lower(new.email) and m.user_id is null) then
    raise exception 'This email is not invited to Retro Poker Club';
  end if;
  return new;
end $$;
