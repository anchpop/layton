-- Fresh consent is required for writes. Existing connections stay read-only
-- and retain their original expiration; new connections last 12 calendar months.
alter table public.mcp_connections add column can_edit boolean not null default false;
alter table public.mcp_connections alter column expires_at set default (now() + interval '12 months');

-- Retain the old signature for existing deployed clients; its grants stay read-only.
create function public.create_mcp_edit_connection(
  p_client_id text, p_client_name text, p_redirect_uri text,
  p_secret_hash text, p_include_private boolean, p_can_edit boolean
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'Sign in required' using errcode = '42501'; end if;
  -- Serialize re-consent for this account, including against vault changes.
  perform 1 from public.user_keys where user_id = auth.uid() for update;
  if not found then raise exception 'Vault required' using errcode = '42501'; end if;
  v_id := public.create_mcp_connection(p_client_id, p_client_name, p_redirect_uri, p_secret_hash, p_include_private);
  update public.mcp_connections set can_edit = p_can_edit, expires_at = now() + interval '12 months' where id = v_id;
  return v_id;
end;
$$;
revoke all on function public.create_mcp_edit_connection(text,text,text,text,boolean,boolean) from public;
grant execute on function public.create_mcp_edit_connection(text,text,text,text,boolean,boolean) to authenticated;

-- Receipts make retries safe even after log compaction. The request hash is an
-- HMAC made with the connection secret, so it does not expose guesses of prose.
create table public.mcp_edit_receipts (
  connection_id uuid not null references public.mcp_connections(id) on delete cascade,
  operation_id uuid not null,
  book_id uuid not null references public.books(id) on delete cascade,
  request_hash text not null,
  revision bigint not null,
  primary key (connection_id, operation_id)
);
alter table public.mcp_edit_receipts enable row level security;
revoke all on public.mcp_edit_receipts from anon, authenticated;

create function public.mcp_write(
  p_connection_id uuid, p_secret text, p_book_id uuid,
  p_operation_id uuid, p_request_hash text, p_wrapped_key text,
  p_expected_revision bigint, p_payload text default null, p_title_cipher text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_grant public.mcp_connections;
  v_book public.books;
  v_receipt public.mcp_edit_receipts;
  v_revision bigint;
begin
  -- A revocation/downgrade waits for an already authorized transaction to finish;
  -- once it completes, no later transaction can write with this capability.
  select * into v_grant from public.mcp_connections where id = p_connection_id
    and secret_hash = encode(sha256(convert_to(p_secret, 'UTF8')), 'hex')
    and expires_at > now() and can_edit for share;
  if v_grant.id is null then raise exception 'Editing not authorized' using errcode = '42501'; end if;
  select * into v_book from public.books where id = p_book_id and owner_id = v_grant.owner_id for update;
  if v_book.id is null or v_book.wrapped_key is distinct from p_wrapped_key then
    raise exception 'Story not available' using errcode = '42501';
  end if;
  if p_operation_id is null or p_request_hash is null or p_request_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid operation';
  end if;
  select * into v_receipt from public.mcp_edit_receipts
    where connection_id = p_connection_id and operation_id = p_operation_id;
  if found then
    if v_receipt.book_id <> p_book_id or v_receipt.request_hash <> p_request_hash then
      raise exception 'Operation ID reused with different input' using errcode = '23505';
    end if;
    return jsonb_build_object('revision', v_receipt.revision::text, 'replayed', true);
  end if;
  -- A receipt lookup has no payload. This lets a retry succeed even when its
  -- original text no longer matches, without applying the operation a second time.
  if p_payload is null then return null; end if;
  if octet_length(p_payload) > 1048576 or length(p_payload) < 40
    or octet_length(p_title_cipher) > 16384 then raise exception 'Invalid payload'; end if;
  select coalesce(max(id), 0) into v_revision from public.book_updates
    where book_id = p_book_id and owner_id = v_grant.owner_id;
  if v_revision is distinct from p_expected_revision then
    raise exception 'Story changed; read it again before editing' using errcode = '40001';
  end if;
  insert into public.book_updates(book_id, owner_id, kind, payload)
    values(p_book_id, v_grant.owner_id, 'update', p_payload) returning id into v_revision;
  if p_title_cipher is not null then
    update public.books set title_cipher = p_title_cipher where id = p_book_id;
  end if;
  insert into public.mcp_edit_receipts(connection_id, operation_id, book_id, request_hash, revision)
    values(p_connection_id, p_operation_id, p_book_id, p_request_hash, v_revision);
  return jsonb_build_object('revision', v_revision::text, 'replayed', false);
end;
$$;
revoke all on function public.mcp_write(uuid,text,uuid,uuid,text,text,bigint,text,text) from public;
grant execute on function public.mcp_write(uuid,text,uuid,uuid,text,text,bigint,text,text) to anon, authenticated;

create or replace function public.mcp_read(
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
    return jsonb_build_object('owner_id', v_grant.owner_id, 'include_private', v_grant.include_private, 'can_edit', v_grant.can_edit);
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

-- Keep the legacy consent contract during rolling deployments.
create or replace function public.create_mcp_connection(
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
  insert into public.mcp_connections(owner_id, client_id, client_name, redirect_uri, secret_hash, include_private, expires_at)
    values (auth.uid(), p_client_id, p_client_name, p_redirect_uri, p_secret_hash, p_include_private, now() + interval '30 days')
    returning id into v_id;
  return v_id;
end;
$$;
