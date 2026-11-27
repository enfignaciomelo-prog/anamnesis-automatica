/**
 * Almacenamiento en PostgreSQL. Cada consulta filtra por owner_id, que siempre
 * proviene de la sesión del servidor.
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { Template } from "../../shared/types";
import type {
  FileRecord,
  InterviewFilter,
  InterviewRecord,
  OfflineLink,
  PendingImport,
  Professional,
  Store,
  TemplateRecord,
} from "../store";

const ms = (d: Date | string | null) => (d === null ? null : new Date(d).getTime());

interface InterviewRow {
  id: string;
  owner_id: string;
  title: string;
  status: InterviewRecord["status"];
  template: Template;
  consent: InterviewRecord["consent"];
  segments: InterviewRecord["segments"];
  speaker_roles: InterviewRecord["speakerRoles"];
  prof: InterviewRecord["prof"];
  pause_reason: string | null;
  created_at: Date;
  last_activity: Date;
  finalized_at: Date | null;
}

function toInterview(r: InterviewRow): InterviewRecord {
  return {
    id: r.id,
    ownerId: r.owner_id,
    title: r.title,
    status: r.status,
    template: r.template,
    consent: r.consent,
    segments: r.segments,
    speakerRoles: r.speaker_roles,
    prof: r.prof,
    pauseReason: r.pause_reason,
    createdAt: ms(r.created_at)!,
    lastActivity: ms(r.last_activity)!,
    finalizedAt: ms(r.finalized_at),
  };
}

interface TemplateRow {
  id: string;
  owner_id: string;
  name: string;
  source: TemplateRecord["source"] | null;
  versions: TemplateRecord["versions"];
  created_at: Date;
  updated_at: Date;
}

function toTemplate(r: TemplateRow): TemplateRecord {
  return {
    id: r.id,
    ownerId: r.owner_id,
    name: r.name,
    source: r.source ?? undefined,
    versions: r.versions,
    createdAt: ms(r.created_at)!,
    updatedAt: ms(r.updated_at)!,
  };
}

const j = (v: unknown) => JSON.stringify(v ?? null);

export class PgStore implements Store {
  readonly kind = "postgres" as const;
  constructor(
    private pool: pg.Pool,
    private defaults: { idleMinutes: number },
  ) {}

  async getProfessional(id: string): Promise<Professional | undefined> {
    const { rows } = await this.pool.query(
      `SELECT u.id, u.name, s.history_retention_days, s.idle_minutes
         FROM "user" u LEFT JOIN professional_settings s ON s.user_id = u.id WHERE u.id = $1`,
      [id],
    );
    const r = rows[0];
    if (!r) return undefined;
    return {
      id: r.id,
      name: r.name,
      historyRetentionDays: r.history_retention_days ?? null,
      idleMinutes: r.idle_minutes ?? this.defaults.idleMinutes,
    };
  }

  async upsertProfessional(p: Professional) {
    await this.pool.query(
      `INSERT INTO professional_settings (user_id, history_retention_days, idle_minutes, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (user_id) DO UPDATE SET history_retention_days = $2, idle_minutes = $3, updated_at = now()`,
      [p.id, p.historyRetentionDays, p.idleMinutes],
    );
  }

  async createInterview(ownerId: string, template: Template, title: string) {
    const now = Date.now();
    const rec: InterviewRecord = {
      id: randomUUID(),
      ownerId,
      title,
      createdAt: now,
      lastActivity: now,
      status: "preparada",
      template: structuredClone(template),
      consent: null,
      segments: [],
      speakerRoles: {},
      prof: {},
      pauseReason: null,
      finalizedAt: null,
    };
    await this.pool.query(
      `INSERT INTO interviews (id, owner_id, title, status, template, created_at, last_activity)
       VALUES ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0), to_timestamp($6 / 1000.0))`,
      [rec.id, ownerId, title, rec.status, j(rec.template), now],
    );
    return rec;
  }

  async getInterview(ownerId: string, id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
    const { rows } = await this.pool.query("SELECT * FROM interviews WHERE id = $1 AND owner_id = $2", [id, ownerId]);
    return rows[0] ? toInterview(rows[0]) : undefined;
  }

  async listInterviews(ownerId: string, f: InterviewFilter = {}) {
    const where = ["owner_id = $1"];
    const args: unknown[] = [ownerId];
    if (f.from !== undefined) {
      args.push(f.from);
      where.push(`created_at >= to_timestamp($${args.length} / 1000.0)`);
    }
    if (f.to !== undefined) {
      args.push(f.to);
      where.push(`created_at <= to_timestamp($${args.length} / 1000.0)`);
    }
    if (f.state === "revisada") where.push("status = 'finalizada'");
    if (f.state === "borrador") where.push("status <> 'finalizada'");
    const { rows } = await this.pool.query(
      `SELECT * FROM interviews WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT 500`,
      args,
    );
    return rows.map(toInterview);
  }

  async saveInterview(r: InterviewRecord) {
    const res = await this.pool.query(
      `UPDATE interviews SET title = $3, status = $4, template = $5, consent = $6, segments = $7,
              speaker_roles = $8, prof = $9, pause_reason = $10,
              last_activity = to_timestamp($11 / 1000.0),
              finalized_at = CASE WHEN $12::bigint IS NULL THEN NULL ELSE to_timestamp($12::bigint / 1000.0) END
        WHERE id = $1 AND owner_id = $2`,
      [
        r.id,
        r.ownerId,
        r.title,
        r.status,
        j(r.template),
        j(r.consent),
        j(r.segments),
        j(r.speakerRoles),
        j(r.prof),
        r.pauseReason,
        r.lastActivity,
        r.finalizedAt,
      ],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async deleteInterview(ownerId: string, id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
    const res = await this.pool.query("DELETE FROM interviews WHERE id = $1 AND owner_id = $2", [id, ownerId]);
    return (res.rowCount ?? 0) > 0;
  }

  async countInterviews(ownerId: string) {
    const { rows } = await this.pool.query("SELECT count(*)::int AS n FROM interviews WHERE owner_id = $1", [ownerId]);
    return rows[0].n as number;
  }

  async saveTemplate(t: TemplateRecord) {
    await this.pool.query(
      `INSERT INTO templates (id, owner_id, name, source, versions, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0), to_timestamp($7 / 1000.0))
       ON CONFLICT (id) DO UPDATE SET name = $3, source = $4, versions = $5, updated_at = to_timestamp($7 / 1000.0)
       WHERE templates.owner_id = $2`,
      [t.id, t.ownerId, t.name, j(t.source ?? null), j(t.versions), t.createdAt, t.updatedAt],
    );
  }

  async getTemplate(ownerId: string, id: string) {
    const { rows } = await this.pool.query("SELECT * FROM templates WHERE id = $1 AND owner_id = $2", [id, ownerId]);
    return rows[0] ? toTemplate(rows[0]) : undefined;
  }

  async listTemplates(ownerId: string) {
    const { rows } = await this.pool.query("SELECT * FROM templates WHERE owner_id = $1 ORDER BY updated_at DESC", [ownerId]);
    return rows.map(toTemplate);
  }

  async deleteTemplate(ownerId: string, id: string) {
    const res = await this.pool.query("DELETE FROM templates WHERE id = $1 AND owner_id = $2", [id, ownerId]);
    return (res.rowCount ?? 0) > 0;
  }

  async putFile(f: Omit<FileRecord, "id">) {
    const id = `file_${randomUUID()}`;
    await this.pool.query("INSERT INTO files (id, owner_id, kind, file_name, bytes) VALUES ($1, $2, $3, $4, $5)", [
      id,
      f.ownerId,
      f.kind,
      f.fileName,
      f.bytes,
    ]);
    return { ...f, id };
  }

  async getFile(ownerId: string, id: string) {
    const { rows } = await this.pool.query(
      "SELECT id, owner_id, kind, file_name, bytes FROM files WHERE id = $1 AND owner_id = $2",
      [id, ownerId],
    );
    const r = rows[0];
    return r ? { id: r.id, ownerId: r.owner_id, kind: r.kind, fileName: r.file_name, bytes: r.bytes as Buffer } : undefined;
  }

  async deleteFile(ownerId: string, id: string) {
    await this.pool.query("DELETE FROM files WHERE id = $1 AND owner_id = $2", [id, ownerId]);
  }

  async fileInUse(ownerId: string, fileId: string) {
    const { rows } = await this.pool.query(
      `SELECT (EXISTS (SELECT 1 FROM templates WHERE owner_id = $1 AND source->>'fileId' = $2)
            OR EXISTS (SELECT 1 FROM interviews WHERE owner_id = $1 AND template->'source'->>'fileId' = $2)) AS used`,
      [ownerId, fileId],
    );
    return Boolean(rows[0]?.used);
  }

  async putImport(p: Omit<PendingImport, "id" | "expiresAt">, ttlMs: number) {
    const rec: PendingImport = { ...p, id: p.analysis.importId, expiresAt: Date.now() + ttlMs };
    await this.pool.query(
      `INSERT INTO pending_imports (id, owner_id, file_id, analysis, valid_targets, expires_at)
       VALUES ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0))`,
      [rec.id, rec.ownerId, rec.fileId, j(rec.analysis), j([...rec.validTargets]), rec.expiresAt],
    );
    return rec;
  }

  async getImport(ownerId: string, id: string) {
    const { rows } = await this.pool.query(
      "SELECT * FROM pending_imports WHERE id = $1 AND owner_id = $2 AND expires_at > now()",
      [id, ownerId],
    );
    const r = rows[0];
    return r
      ? {
          id: r.id,
          ownerId: r.owner_id,
          fileId: r.file_id,
          analysis: r.analysis,
          validTargets: new Set<string>(r.valid_targets),
          expiresAt: ms(r.expires_at)!,
        }
      : undefined;
  }

  async deleteImport(ownerId: string, id: string) {
    await this.pool.query("DELETE FROM pending_imports WHERE id = $1 AND owner_id = $2", [id, ownerId]);
  }

  async getOfflineLink(ownerId: string, clientId: string): Promise<OfflineLink | undefined> {
    const { rows } = await this.pool.query(
      "SELECT interview_id, revision, content_hash FROM offline_sync WHERE owner_id = $1 AND client_id = $2",
      [ownerId, clientId],
    );
    const r = rows[0];
    return r ? { ownerId, clientId, interviewId: r.interview_id, revision: r.revision, contentHash: r.content_hash } : undefined;
  }

  async saveOfflineLink(l: OfflineLink) {
    await this.pool.query(
      `INSERT INTO offline_sync (owner_id, client_id, interview_id, revision, content_hash, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (owner_id, client_id) DO UPDATE SET interview_id = $3, revision = $4, content_hash = $5, updated_at = now()
       WHERE offline_sync.owner_id = $1`,
      [l.ownerId, l.clientId, l.interviewId, l.revision, l.contentHash],
    );
  }

  async getActivity(sessionId: string) {
    const { rows } = await this.pool.query("SELECT last_seen FROM session_activity WHERE session_id = $1", [sessionId]);
    return rows[0] ? ms(rows[0].last_seen)! : undefined;
  }

  async touchActivity(sessionId: string, at: number) {
    await this.pool.query(
      `INSERT INTO session_activity (session_id, last_seen) VALUES ($1, to_timestamp($2 / 1000.0))
       ON CONFLICT (session_id) DO UPDATE SET last_seen = to_timestamp($2 / 1000.0)`,
      [sessionId, at],
    );
  }

  async deleteActivity(sessionId: string) {
    await this.pool.query("DELETE FROM session_activity WHERE session_id = $1", [sessionId]);
  }

  async sweep(now: number) {
    // Solo con política explícita del profesional (history_retention_days no nulo).
    const { rows } = await this.pool.query(
      `DELETE FROM interviews i USING (
         SELECT i2.id FROM interviews i2
           JOIN professional_settings s ON s.user_id = i2.owner_id
          WHERE s.history_retention_days IS NOT NULL
            AND i2.status <> 'escuchando'
            AND i2.last_activity + make_interval(days => s.history_retention_days) < to_timestamp($1 / 1000.0)
       ) old WHERE i.id = old.id RETURNING i.id`,
      [now],
    );
    // Importaciones vencidas y archivos que ya nadie usa.
    await this.pool.query("DELETE FROM pending_imports WHERE expires_at < to_timestamp($1 / 1000.0)", [now]);
    await this.pool.query(
      `DELETE FROM files f
        WHERE NOT EXISTS (SELECT 1 FROM pending_imports p WHERE p.file_id = f.id)
          AND NOT EXISTS (SELECT 1 FROM templates t WHERE t.source->>'fileId' = f.id)
          AND NOT EXISTS (SELECT 1 FROM interviews i WHERE i.template->'source'->>'fileId' = f.id)
          AND f.created_at < to_timestamp($1 / 1000.0) - interval '2 hours'`,
      [now],
    );
    await this.pool.query("DELETE FROM session_activity WHERE last_seen < to_timestamp($1 / 1000.0) - interval '2 days'", [now]);
    return rows.map((r) => r.id as string);
  }

  async close() {
    await this.pool.end();
  }
}
