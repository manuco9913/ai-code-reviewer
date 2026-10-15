-- DevFlow AI schema. Run once in the Supabase SQL editor (safe to re-run).
-- All access goes through the service key from the Worker / indexer, so RLS is enabled with no
-- policies: the public anon key can read or write nothing.

create extension if not exists vector;

-- ---------------------------------------------------------------------------
-- Repository index
-- ---------------------------------------------------------------------------

create table if not exists repositories (
  repo         text primary key,                 -- "owner/name"
  last_commit  text,
  file_count   int not null default 0,
  chunk_count  int not null default 0,
  indexed_at   timestamptz
);

create table if not exists code_files (
  repo       text not null,
  path       text not null,
  language   text not null,
  file_hash  text not null,                      -- sha256 of content; unchanged files are skipped
  imports    text[] not null default '{}',       -- resolved repo-internal paths
  packages   text[] not null default '{}',       -- external package specifiers
  indexed_at timestamptz not null default now(),
  primary key (repo, path)
);

create index if not exists code_files_imports_idx on code_files using gin (imports);

create table if not exists code_chunks (
  id          bigserial primary key,
  repo        text not null,
  path        text not null,
  symbol      text,
  kind        text not null,                     -- function | class | method | type | block | module | section
  language    text not null,
  start_line  int not null,
  end_line    int not null,
  content     text not null,
  embedding   vector(768) not null,
  -- Full-text search over identifiers: split camelCase and snake_case so "getUserById"
  -- matches a query for "user id".
  fts tsvector generated always as (
    to_tsvector(
      'simple',
      regexp_replace(
        translate(coalesce(symbol, '') || ' ' || path || ' ' || content, '_./-', '    '),
        '([a-z0-9])([A-Z])', '\1 \2', 'g'
      )
    )
  ) stored
);

create index if not exists code_chunks_repo_path_idx on code_chunks (repo, path);
create index if not exists code_chunks_fts_idx on code_chunks using gin (fts);
create index if not exists code_chunks_embedding_idx on code_chunks using hnsw (embedding vector_cosine_ops);

-- Hybrid search: semantic (cosine) and keyword (full-text) result lists fused with
-- Reciprocal Rank Fusion. Keyword terms are OR-ed so natural-language questions still match.
-- Code only by default; p_include_docs adds Markdown sections (READMEs, PRDs, research notes).
-- Dropped first: a changed parameter list would otherwise create a second overload.
drop function if exists hybrid_search(text, text, vector, int, text, int);
create or replace function hybrid_search(
  p_repo          text,
  p_query         text,
  p_embedding     vector(768),
  p_match_count   int default 8,
  p_path_prefix   text default null,
  p_include_docs  boolean default false,
  p_rrf_k         int default 50
)
returns table (
  id bigint, path text, symbol text, kind text, language text,
  start_line int, end_line int, content text, score double precision
)
language sql stable
as $$
  with q as (
    select nullif(
      regexp_replace(
        trim(regexp_replace(
          regexp_replace(translate(p_query, '_./-', '    '), '([a-z0-9])([A-Z])', '\1 \2', 'g'),
          '[^[:alnum:][:space:]]', ' ', 'g')),
        '\s+', ' or ', 'g'),
      '') as terms
  ),
  scoped as (
    select c.* from code_chunks c
    where c.repo = p_repo
      and (p_path_prefix is null or c.path like p_path_prefix || '%')
      and (p_include_docs or c.language <> 'markdown')
  ),
  keyword as (
    select s.id, row_number() over (order by ts_rank_cd(s.fts, websearch_to_tsquery('simple', q.terms)) desc) as rank_ix
    from scoped s, q
    where q.terms is not null and s.fts @@ websearch_to_tsquery('simple', q.terms)
    order by rank_ix
    limit p_match_count * 3
  ),
  semantic as (
    select s.id, row_number() over (order by s.embedding <=> p_embedding) as rank_ix
    from scoped s
    order by rank_ix
    limit p_match_count * 3
  )
  select c.id, c.path, c.symbol, c.kind, c.language, c.start_line, c.end_line, c.content,
         coalesce(1.0 / (p_rrf_k + k.rank_ix), 0.0) + coalesce(1.0 / (p_rrf_k + s.rank_ix), 0.0) as score
  from keyword k
  full outer join semantic s on k.id = s.id
  join code_chunks c on c.id = coalesce(k.id, s.id)
  order by score desc
  limit p_match_count;
$$;

-- ---------------------------------------------------------------------------
-- Reviews and approvals
-- ---------------------------------------------------------------------------

create table if not exists reviews (
  id          uuid primary key default gen_random_uuid(),
  repo        text not null,
  pr_number   int not null,
  head_sha    text not null,
  result      jsonb not null,
  created_at  timestamptz not null default now(),
  unique (repo, pr_number, head_sha)
);

-- Every external write is proposed here first and executed only after a human approves it.
create table if not exists pending_actions (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('pr_review', 'pr_comment', 'issue_update')),
  repo        text not null,
  title       text not null,
  payload     jsonb not null,
  status      text not null default 'pending'
              check (status in ('pending', 'approved', 'rejected', 'executed', 'failed')),
  result      jsonb,
  created_at  timestamptz not null default now(),
  decided_at  timestamptz
);

create index if not exists pending_actions_status_idx on pending_actions (status, created_at desc);

alter table repositories    enable row level security;
alter table code_files      enable row level security;
alter table code_chunks     enable row level security;
alter table reviews         enable row level security;
alter table pending_actions enable row level security;

-- Called by the indexer at the end of a run; derives the chunk total server-side.
create or replace function record_index_run(p_repo text, p_commit text, p_file_count int)
returns void
language sql
as $$
  insert into repositories (repo, last_commit, file_count, chunk_count, indexed_at)
  values (p_repo, p_commit, p_file_count, (select count(*) from code_chunks where repo = p_repo), now())
  on conflict (repo) do update
    set last_commit = excluded.last_commit,
        file_count  = excluded.file_count,
        chunk_count = excluded.chunk_count,
        indexed_at  = excluded.indexed_at;
$$;

-- ---------------------------------------------------------------------------
-- Privileges. Newer Supabase projects don't auto-grant API roles access to new tables, so grant
-- the server-side role (the secret / service_role key) exactly what DevFlow uses. anon and
-- authenticated get nothing.
-- ---------------------------------------------------------------------------

grant usage on schema public to service_role;
grant select, insert, update, delete on repositories, code_files, code_chunks, reviews, pending_actions to service_role;
grant usage, select on sequence code_chunks_id_seq to service_role;
grant execute on function hybrid_search(text, text, vector, int, text, boolean, int) to service_role;
grant execute on function record_index_run(text, text, int) to service_role;
