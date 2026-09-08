-- A revocable, read-only capability. No password, content key, or login token
-- is stored here. Only its hash; the secret lives in encrypted OAuth props.
create table public.mcp_connections (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  client_id text not null,
  client_name text not null,
  redirect_uri text not null,
  secret_hash text not null check (secret_hash ~ '^[0-9a-f]{64}$'),
  include_private boolean not null default false,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 days')
);
create index mcp_connections_owner on public.mcp_connections(owner_id);
alter table public.mcp_connections enable row level security;
revoke all on public.mcp_connections from anon, authenticated;
grant select, delete on public.mcp_connections to authenticated;
create policy mcp_connections_select on public.mcp_connections for select to authenticated
  using (owner_id = auth.uid());
create policy mcp_connections_delete on public.mcp_connections for delete to authenticated
  using (owner_id = auth.uid());

create function public.create_mcp_connection(
  p_client_id text, p_client_name text, p_redirect_uri text,
  p_secret_hash text, p_include_private boolean
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'Sign in required' using errcode = '42501'; end if;
  if length(p_client_id) > 2048 or length(p_client_name) > 200 or length(p_redirect_uri) > 4096 then
    raise exception 'Invalid client';
  end if;
  -- Re-consenting without private access revokes the previous capability too,
  -- independently of the OAuth provider's eventually consistent KV storage.
  delete from public.mcp_connections where owner_id = auth.uid()
    and client_id = p_client_id and redirect_uri = p_redirect_uri;
  insert into public.mcp_connections(owner_id, client_id, client_name, redirect_uri, secret_hash, include_private)
    values (auth.uid(), p_client_id, p_client_name, p_redirect_uri, p_secret_hash, p_include_private)
    returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.create_mcp_connection(text,text,text,text,boolean) from public;
grant execute on function public.create_mcp_connection(text,text,text,text,boolean) to authenticated;

-- All selects in this STABLE function share one database snapshot, so a
-- concurrent compaction cannot remove updates between fetching the snapshot
-- and its tail. Reads always return the CURRENT wrapping, never a cached key.
create function public.mcp_read(
  p_connection_id uuid, p_secret text, p_operation text,
  p_book_id uuid default null, p_after uuid default null
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_grant public.mcp_connections;
  v_book public.books;
  v_rows jsonb;
  v_snapshot bigint;
  v_size bigint;
begin
  select * into v_grant from public.mcp_connections where id = p_connection_id
    and secret_hash = encode(sha256(convert_to(p_secret, 'UTF8')), 'hex')
    and expires_at > now();
  if v_grant.id is null then raise exception 'Connection expired or revoked' using errcode = '42501'; end if;
  if p_operation = 'check' then
    return jsonb_build_object('owner_id', v_grant.owner_id, 'include_private', v_grant.include_private);
  elsif p_operation = 'list' then
    select coalesce(jsonb_agg(to_jsonb(b) order by b.id), '[]'::jsonb) into v_rows from (
      select id, title_cipher, wrapped_key, updated_at, archived_at from public.books
      where owner_id = v_grant.owner_id and (p_after is null or id > p_after)
      order by id limit 100
    ) b;
    return v_rows;
  elsif p_operation = 'read' then
    select * into v_book from public.books where id = p_book_id and owner_id = v_grant.owner_id;
    if v_book.id is null then return 'null'::jsonb; end if;
    select max(id) into v_snapshot from public.book_updates
      where book_id = p_book_id and owner_id = v_grant.owner_id and kind = 'snapshot';
    select coalesce(sum(octet_length(payload)), 0) into v_size from public.book_updates
      where book_id = p_book_id and owner_id = v_grant.owner_id and id >= coalesce(v_snapshot, 0);
    if v_size > 16777216 then raise exception 'Story exceeds MCP size limit' using errcode = '54000'; end if;
    select coalesce(jsonb_agg(jsonb_build_object('id', id::text, 'payload', payload) order by id), '[]'::jsonb)
      into v_rows from public.book_updates where book_id = p_book_id and owner_id = v_grant.owner_id
      and id >= coalesce(v_snapshot, 0);
    return jsonb_build_object('book', to_jsonb(v_book) - 'owner_id', 'updates', v_rows);
  else
    raise exception 'Invalid operation';
  end if;
end;
$$;
revoke all on function public.mcp_read(uuid,text,text,uuid,uuid) from public;
grant execute on function public.mcp_read(uuid,text,text,uuid,uuid) to anon, authenticated;

-- Changing/erasing the vault also revokes outstanding MCP capabilities.
create function public.revoke_vault_mcp_connections() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.mcp_connections where owner_id = old.user_id;
  return old;
end;
$$;
create trigger vault_revoke_mcp after update or delete on public.user_keys
  for each row execute function public.revoke_vault_mcp_connections();
