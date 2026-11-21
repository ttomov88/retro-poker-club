-- import_all now takes a backup first (later made owner-only in review_fixes_security)
CREATE OR REPLACE FUNCTION public.import_all(payload jsonb)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
declare t text; r jsonb;
begin
  if not public.is_editor() then raise exception 'Only admins can import'; end if;
  perform public.take_backup();
  delete from public.nights; delete from public.players; delete from public.chips;
  foreach t in array array['players','nights','chips'] loop
    for r in select * from jsonb_array_elements(coalesce(payload -> t, '[]'::jsonb)) loop
      if jsonb_typeof(r) <> 'object' or jsonb_typeof(r -> 'id') <> 'number' then
        raise exception 'The backup has damaged % records. Nothing was changed.', t;
      end if;
      execute format('insert into public.%I (id, data) values ($1, $2)', t)
        using (r ->> 'id')::bigint, (r - 'id' - '_v');
    end loop;
    execute format('select setval(pg_get_serial_sequence(%L, ''id''), coalesce((select max(id) from public.%I), 0) + 1, false)',
                   'public.' || t, t);
  end loop;
end $function$;
