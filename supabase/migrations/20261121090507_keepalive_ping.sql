-- Tiny public function the daily GitHub keep-alive calls, so the free project never pauses.
create function public.ping() returns boolean language sql stable security invoker set search_path = '' as $$ select true $$;
grant execute on function public.ping() to anon;
