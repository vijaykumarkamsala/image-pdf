-- The first schema: accounts, the files they own, the work queued against them,
-- and what their plan allows.
--
-- One rule shapes all of it: Postgres holds state, Cloud Storage holds bytes.
-- Not one column here is a bytea. A 40 MB scan in a row makes every backup,
-- every replica and every "SELECT *" carry it, and the object store already
-- solves storage far better than a database row does. What Postgres is for is
-- the part an object store cannot do: relating things, enforcing uniqueness,
-- and answering a question about many rows at once.
--
-- Times are timestamptz and default to now(), taken from the server. The
-- application is forbidden from reading a wall clock (the repository bans
-- datetime.now for determinism), and it would be the wrong clock anyway: rows
-- written by three Cloud Run instances must be orderable against each other,
-- and only the database sees a single clock.

-- ---------------------------------------------------------------- accounts --
-- "subject" is who the identity provider says this is - the sub claim, not an
-- email. Emails get reassigned inside a company and people change them; a
-- subject is stable for the life of the account, which is what a foreign key
-- needs. Email is kept for display and support, and deliberately not unique:
-- two accounts legitimately share a shared mailbox.
CREATE TABLE accounts (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    subject       text        NOT NULL UNIQUE,
    email         text        NOT NULL,
    display_name  text        NOT NULL DEFAULT '',
    status        text        NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'suspended', 'closed')),
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------ assets --
-- One uploaded original. object_name is the key in the bucket; sha256 is the
-- digest of the bytes.
--
-- The unique constraint is on (account_id, sha256), not on sha256 alone. The
-- same document uploaded by two customers is two assets - separate retention,
-- separate deletion rights, separate audit trails - but the same customer
-- uploading the same file twice is one asset, which is what makes re-uploading
-- a 200-page PDF cheap instead of duplicating it.
CREATE TABLE assets (
    id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id        bigint      NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    object_name       text        NOT NULL UNIQUE,
    sha256            char(64)    NOT NULL,
    byte_size         bigint      NOT NULL CHECK (byte_size >= 0),
    content_type      text        NOT NULL DEFAULT '',
    original_filename text        NOT NULL DEFAULT '',
    created_at        timestamptz NOT NULL DEFAULT now(),
    deleted_at        timestamptz,
    UNIQUE (account_id, sha256)
);

CREATE INDEX assets_account_recent ON assets (account_id, created_at DESC)
    WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------- versions --
-- Every derived file: the compressed PDF, the redacted one, the vector trace.
--
-- parent_id refers to another version rather than only to the asset, because
-- real work chains - recognise, then redact, then number - and a customer
-- asking "where did this file come from" deserves the actual chain rather than
-- "from the original, somehow". A NULL parent means it derives from the asset
-- itself.
--
-- settings is jsonb rather than a column per operation. The operations differ
-- too much to share columns, and a schema change per new operation would make
-- adding one a migration rather than a feature. What is not left to jsonb is
-- the operation name, because that is what anybody queries by.
CREATE TABLE versions (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    asset_id     bigint      NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
    parent_id    bigint      REFERENCES versions (id) ON DELETE SET NULL,
    operation    text        NOT NULL,
    settings     jsonb       NOT NULL DEFAULT '{}'::jsonb,
    object_name  text        NOT NULL UNIQUE,
    sha256       char(64)    NOT NULL,
    byte_size    bigint      NOT NULL CHECK (byte_size >= 0),
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX versions_by_asset ON versions (asset_id, created_at DESC);
CREATE INDEX versions_by_parent ON versions (parent_id) WHERE parent_id IS NOT NULL;

-- -------------------------------------------------------------------- jobs --
-- Queued work. The worker in the next step claims rows with
-- SELECT ... FOR UPDATE SKIP LOCKED, which is why the shape matters here.
--
-- run_after exists so a retry can back off without a sleeping worker holding a
-- slot, and so scheduled work uses the same mechanism rather than a second one.
-- attempts is on the row, not in the worker, because a worker that dies mid-job
-- must not reset the count - that is the difference between a poison message
-- being retried forever and being parked.
--
-- locked_by is recorded rather than inferred. When a job is stuck the first
-- question is which instance holds it, and "some worker" is not an answer.
CREATE TABLE jobs (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id   bigint      REFERENCES accounts (id) ON DELETE CASCADE,
    kind         text        NOT NULL,
    state        text        NOT NULL DEFAULT 'queued'
                 CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
    payload      jsonb       NOT NULL DEFAULT '{}'::jsonb,
    result       jsonb,
    error        text,
    attempts     integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    max_attempts integer     NOT NULL DEFAULT 3 CHECK (max_attempts >= 1),
    priority     integer     NOT NULL DEFAULT 100,
    run_after    timestamptz NOT NULL DEFAULT now(),
    locked_at    timestamptz,
    locked_by    text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

-- The claim query's index: only over rows still waiting, so it stays small no
-- matter how many finished jobs accumulate behind it.
CREATE INDEX jobs_claimable ON jobs (priority, run_after, id)
    WHERE state = 'queued';

CREATE INDEX jobs_by_account ON jobs (account_id, created_at DESC);

-- ------------------------------------------------------------ entitlements --
-- What a plan allows. One row per account per feature.
--
-- A limit of NULL means unlimited, which is why the column is nullable rather
-- than carrying a sentinel like -1: a sentinel eventually gets compared with a
-- less-than by someone who did not know, and unlimited silently becomes zero.
CREATE TABLE entitlements (
    account_id  bigint      NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    feature     text        NOT NULL,
    limit_value bigint      CHECK (limit_value IS NULL OR limit_value >= 0),
    used        bigint      NOT NULL DEFAULT 0 CHECK (used >= 0),
    period      text        NOT NULL DEFAULT 'month'
                CHECK (period IN ('day', 'month', 'year', 'total')),
    resets_at   timestamptz,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, feature)
);
