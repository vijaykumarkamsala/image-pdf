import { randomUUID } from "node:crypto";
import { Pool, type QueryResultRow } from "pg";

import { runMigrations } from "../../kernel/migrations.js";
import type {
  AuthRepository,
  AuthTransaction,
  IdentityAuditInput,
  OidcIdentity,
  StoredApplicationSession,
} from "./auth.types.js";

function instant(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function session(row: QueryResultRow): StoredApplicationSession {
  return {
    sessionIdHash: String(row["session_id_hash"]),
    principal: { actorId: String(row["actor_id"]), displayName: String(row["display_name"]) },
    createdAt: instant(row["created_at"] as Date | string),
    expiresAt: instant(row["expires_at"] as Date | string),
    rotateAfter: instant(row["rotate_after"] as Date | string),
    lastSeenAt: instant(row["last_seen_at"] as Date | string),
  };
}

export class MemoryAuthRepository implements AuthRepository {
  readonly audits: IdentityAuditInput[] = [];
  private readonly transactions = new Map<string, AuthTransaction>();
  private readonly identities = new Map<string, { actorId: string; displayName: string }>();
  private readonly sessions = new Map<string, StoredApplicationSession & { revokedAt?: string }>();

  async createTransaction(transaction: AuthTransaction): Promise<void> {
    this.transactions.set(transaction.stateHash, transaction);
  }

  async consumeTransaction(stateHash: string, now: string): Promise<AuthTransaction | null> {
    const value = this.transactions.get(stateHash);
    if (!value || value.expiresAt <= now) return null;
    this.transactions.delete(stateHash);
    return value;
  }

  async resolveIdentity(identity: OidcIdentity, actorId: string): Promise<{ actorId: string; displayName: string }> {
    const key = `${identity.issuer}\u0000${identity.subject}`;
    const prior = this.identities.get(key);
    if (prior) return { actorId: prior.actorId, displayName: prior.displayName };
    const created = { actorId, displayName: identity.displayName };
    this.identities.set(key, created);
    return created;
  }

  async createSession(value: StoredApplicationSession): Promise<void> {
    this.sessions.set(value.sessionIdHash, value);
  }

  async findSession(sessionIdHash: string, now: string): Promise<StoredApplicationSession | null> {
    const value = this.sessions.get(sessionIdHash);
    return value && !value.revokedAt && value.expiresAt > now ? value : null;
  }

  async rotateSession(previousHash: string, value: StoredApplicationSession, now: string): Promise<boolean> {
    const previous = this.sessions.get(previousHash);
    if (!previous || previous.revokedAt || previous.expiresAt <= now) return false;
    previous.revokedAt = now;
    this.sessions.set(value.sessionIdHash, value);
    return true;
  }

  async revokeSession(sessionIdHash: string, now: string): Promise<StoredApplicationSession | null> {
    const value = this.sessions.get(sessionIdHash);
    if (!value || value.revokedAt) return null;
    value.revokedAt = now;
    return value;
  }

  async recordAudit(input: IdentityAuditInput): Promise<void> { this.audits.push(input); }
  async close(): Promise<void> {}
}

export class PostgresAuthRepository implements AuthRepository {
  constructor(private readonly pool: Pool) {}

  static async connect(connectionString: string, migrate = false): Promise<PostgresAuthRepository> {
    const pool = new Pool({ connectionString, max: 5 });
    if (migrate) await runMigrations(pool);
    return new PostgresAuthRepository(pool);
  }

  async createTransaction(value: AuthTransaction): Promise<void> {
    await this.pool.query(
      `INSERT INTO oidc_auth_transactions(state_hash,nonce_hash,code_verifier,return_to,
       handoff_upload_session_id,guest_token_hash,created_at,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [value.stateHash, value.nonceHash, value.codeVerifier, value.returnTo,
        value.handoffUploadSessionId, value.guestTokenHash, value.createdAt, value.expiresAt],
    );
  }

  async consumeTransaction(stateHash: string, now: string): Promise<AuthTransaction | null> {
    const result = await this.pool.query(
      `UPDATE oidc_auth_transactions SET consumed_at=$2
       WHERE state_hash=$1 AND consumed_at IS NULL AND expires_at>$2
       RETURNING *`,
      [stateHash, now],
    );
    const row = result.rows[0];
    return row ? {
      stateHash: String(row["state_hash"]), nonceHash: String(row["nonce_hash"]),
      codeVerifier: String(row["code_verifier"]), returnTo: String(row["return_to"]),
      handoffUploadSessionId: row["handoff_upload_session_id"] ? String(row["handoff_upload_session_id"]) : null,
      guestTokenHash: row["guest_token_hash"] ? String(row["guest_token_hash"]) : null,
      createdAt: instant(row["created_at"] as Date | string), expiresAt: instant(row["expires_at"] as Date | string),
    } : null;
  }

  async resolveIdentity(identity: OidcIdentity, actorId: string, now: string) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query(
        `SELECT actors.actor_id,actors.display_name FROM oidc_actor_identities identities
         JOIN actors USING(actor_id) WHERE identities.issuer=$1 AND identities.subject=$2 FOR UPDATE`,
        [identity.issuer, identity.subject],
      );
      if (existing.rows[0]) {
        await client.query("COMMIT");
        return { actorId: String(existing.rows[0]["actor_id"]), displayName: String(existing.rows[0]["display_name"]) };
      }
      await client.query(
        "INSERT INTO actors(actor_id,display_name,created_at) VALUES ($1,$2,$3)",
        [actorId, identity.displayName, now],
      );
      await client.query(
        "INSERT INTO oidc_actor_identities(issuer,subject,actor_id,created_at) VALUES ($1,$2,$3,$4)",
        [identity.issuer, identity.subject, actorId, now],
      );
      await client.query("COMMIT");
      return { actorId, displayName: identity.displayName };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async createSession(value: StoredApplicationSession): Promise<void> {
    await this.pool.query(
      `INSERT INTO application_sessions(session_id_hash,actor_id,created_at,expires_at,rotate_after,last_seen_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [value.sessionIdHash, value.principal.actorId, value.createdAt, value.expiresAt, value.rotateAfter, value.lastSeenAt],
    );
  }

  async findSession(sessionIdHash: string, now: string): Promise<StoredApplicationSession | null> {
    const result = await this.pool.query(
      `UPDATE application_sessions sessions SET last_seen_at=$2 FROM actors
       WHERE sessions.session_id_hash=$1 AND sessions.actor_id=actors.actor_id
       AND sessions.revoked_at IS NULL AND sessions.expires_at>$2
       RETURNING sessions.*,actors.display_name`,
      [sessionIdHash, now],
    );
    return result.rows[0] ? session(result.rows[0]) : null;
  }

  async rotateSession(previousHash: string, value: StoredApplicationSession, now: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query(
        `SELECT actor_id FROM application_sessions
         WHERE session_id_hash=$1 AND revoked_at IS NULL AND expires_at>$2 FOR UPDATE`,
        [previousHash, now],
      );
      if (!current.rows[0] || current.rows[0]["actor_id"] !== value.principal.actorId) {
        await client.query("ROLLBACK");
        return false;
      }
      await client.query(
        `INSERT INTO application_sessions(session_id_hash,actor_id,created_at,expires_at,rotate_after,last_seen_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [value.sessionIdHash, value.principal.actorId, value.createdAt, value.expiresAt, value.rotateAfter, value.lastSeenAt],
      );
      await client.query(
        `UPDATE application_sessions SET revoked_at=$2,rotated_to_hash=$3 WHERE session_id_hash=$1`,
        [previousHash, now, value.sessionIdHash],
      );
      await client.query("COMMIT");
      return true;
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }

  async revokeSession(sessionIdHash: string, now: string): Promise<StoredApplicationSession | null> {
    const result = await this.pool.query(
      `UPDATE application_sessions sessions SET revoked_at=$2 FROM actors
       WHERE sessions.session_id_hash=$1 AND sessions.actor_id=actors.actor_id AND sessions.revoked_at IS NULL
       RETURNING sessions.*,actors.display_name`,
      [sessionIdHash, now],
    );
    return result.rows[0] ? session(result.rows[0]) : null;
  }

  async recordAudit(value: IdentityAuditInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO identity_audit_events(identity_audit_event_id,actor_id,action,outcome,subject_reference,occurred_at,trace_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [`identity-audit-${randomUUID()}`, value.actorId, value.action, value.outcome,
        value.subjectReference, value.occurredAt, value.traceId],
    );
  }

  async close(): Promise<void> { await this.pool.end(); }
}
