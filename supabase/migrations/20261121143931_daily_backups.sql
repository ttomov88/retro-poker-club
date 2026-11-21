create extension if not exists pg_cron;

-- Daily snapshots of all club data, kept 30 days. Not reachable from the app or API.
create table public.backups (
  id bigint generated always as identity primary key,
  taken_at timestamptz not null default now(),
  data jsonb not null
);
alter table public.backups enable row level security; -- no policies: nobody via the API
revoke all on public.backups from anon, authenticated;

create function public.take_backup() returns bigint
language plpgsql security definer set search_path = '' as $$
declare new_id bigint;
begin
  insert into public.backups(data) select jsonb_build_object(
    'players', coalesce((select jsonb_agg(data || jsonb_build_object('id', id) order by id) from public.players), '[]'::jsonb),
    'nights',  coalesce((select jsonb_agg(data || jsonb_build_object('id', id) order by id) from public.nights),  '[]'::jsonb),
    'chips',   coalesce((select jsonb_agg(data || jsonb_build_object('id', id) order by id) from public.chips),   '[]'::jsonb),
    'members', coalesce((select jsonb_agg(jsonb_build_object('email', email, 'role', role) order by email) from public.members), '[]'::jsonb)
  ) returning id into new_id;
  delete from public.backups where taken_at < now() - interval '30 days';
  return new_id;
end $$;

-- Puts a snapshot back (players, events, chips). Run by hand only when needed.
create function public.restore_backup(p_id bigint) returns void
language plpgsql security definer set search_path = '' as $$
declare snap jsonb; t text;
begin
  select data into snap from public.backups where id = p_id;
  if snap is null then raise exception 'No backup %', p_id; end if;
  perform public.take_backup(); -- keep the current state too, just in case
  delete from public.nights; delete from public.players; delete from public.chips;
  foreach t in array array['players','nights','chips'] loop
    execute format('insert into public.%I (id, data) select (r->>''id'')::bigint, r - ''id'' from jsonb_array_elements($1->%L) r', t, t) using snap;
    execute format('select setval(pg_get_serial_sequence(%L, ''id''), coalesce((select max(id) from public.%I), 0) + 1, false)', 'public.'||t, t);
  end loop;
end $$;

revoke execute on function public.take_backup(), public.restore_backup(bigint) from public, anon, authenticated;

-- every day at 01:00 UTC (03:00/04:00 Sofia time)
select cron.schedule('daily-backup', '0 1 * * *', $$select public.take_backup()$$);
