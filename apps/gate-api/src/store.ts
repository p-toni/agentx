import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';

export interface BundleRecord {
  readonly id: string;
  readonly path: string;
  readonly createdAt: string;
  readonly metadata?: Record<string, unknown>;
}

export interface ApprovalRecord {
  readonly bundleId: string;
  readonly actor: string;
  readonly policyVersion: string;
  readonly approvedAt: string;
}

export interface ReceiptRecord {
  readonly bundleId: string;
  readonly intentId: string;
  readonly intentType: string;
  readonly receipt: unknown;
  readonly recordedAt: string;
}

export class GateStore {
  private readonly db: Database.Database;
  private readonly bundlesDir: string;

  constructor(private readonly dataDir: string) {
    this.bundlesDir = path.join(this.dataDir, 'bundles');
    this.db = new Database(path.join(this.dataDir, 'gate-api.db'));
    this.initialise();
  }

  private initialise(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS bundles (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        metadata_json TEXT
      );
      CREATE TABLE IF NOT EXISTS approvals (
        bundle_id TEXT PRIMARY KEY,
        actor TEXT NOT NULL,
        policy_version TEXT NOT NULL,
        approved_at TEXT NOT NULL,
        FOREIGN KEY(bundle_id) REFERENCES bundles(id)
      );
      CREATE TABLE IF NOT EXISTS receipts (
        bundle_id TEXT NOT NULL,
        intent_id TEXT NOT NULL,
        intent_type TEXT NOT NULL,
        receipt_json TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        PRIMARY KEY(bundle_id, intent_id),
        FOREIGN KEY(bundle_id) REFERENCES bundles(id)
      );
    `);
  }

  async ensureDataDirs(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    await mkdir(this.bundlesDir, { recursive: true });
  }

  async persistBundle(id: string, contents: Buffer, metadata?: Record<string, unknown>): Promise<BundleRecord> {
    await this.ensureDataDirs();
    const filePath = path.join(this.bundlesDir, `${id}.tgz`);
    await writeFile(filePath, contents);
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        'INSERT INTO bundles (id, path, created_at, metadata_json) VALUES (@id, @path, @created_at, @metadata_json)'
      )
      .run({
        id,
        path: filePath,
        created_at: createdAt,
        metadata_json: metadata ? JSON.stringify(metadata) : null
      });

    return { id, path: filePath, createdAt };
  }

  getBundle(id: string): BundleRecord | undefined {
    const row = this.db
      .prepare('SELECT id, path, created_at as createdAt, metadata_json as metadataJson FROM bundles WHERE id = ?')
      .get(id) as { id: string; path: string; createdAt: string; metadataJson: string | null } | undefined;
    if (!row) {
      return undefined;
    }
    return {
      id: row.id,
      path: row.path,
      createdAt: row.createdAt,
      metadata: row.metadataJson ? (JSON.parse(row.metadataJson) as Record<string, unknown>) : undefined
    };
  }

  recordApproval(record: ApprovalRecord): void {
    this.db
      .prepare(
        `INSERT INTO approvals (bundle_id, actor, policy_version, approved_at)
         VALUES (@bundleId, @actor, @policyVersion, @approvedAt)
         ON CONFLICT(bundle_id) DO UPDATE SET
           actor = excluded.actor,
           policy_version = excluded.policy_version,
           approved_at = excluded.approved_at`
      )
      .run(record);
  }

  getApproval(bundleId: string): ApprovalRecord | undefined {
    const row = this.db
      .prepare(
        'SELECT bundle_id as bundleId, actor, policy_version as policyVersion, approved_at as approvedAt FROM approvals WHERE bundle_id = ?'
      )
      .get(bundleId) as ApprovalRecord | undefined;
    return row;
  }

  saveReceipt(record: ReceiptRecord): void {
    this.db
      .prepare(
        `INSERT INTO receipts (bundle_id, intent_id, intent_type, receipt_json, recorded_at)
         VALUES (@bundleId, @intentId, @intentType, @receiptJson, @recordedAt)
         ON CONFLICT(bundle_id, intent_id) DO UPDATE SET
           intent_type = excluded.intent_type,
           receipt_json = excluded.receipt_json,
           recorded_at = excluded.recorded_at`
      )
      .run({
        bundleId: record.bundleId,
        intentId: record.intentId,
        intentType: record.intentType,
        receiptJson: JSON.stringify(record.receipt ?? null),
        recordedAt: record.recordedAt
      });
  }

  listReceipts(bundleId: string): ReceiptRecord[] {
    const rows = this.db
      .prepare(
        'SELECT bundle_id as bundleId, intent_id as intentId, intent_type as intentType, receipt_json as receiptJson, recorded_at as recordedAt FROM receipts WHERE bundle_id = ? ORDER BY intent_id'
      )
      .all(bundleId) as { bundleId: string; intentId: string; intentType: string; receiptJson: string; recordedAt: string }[];
    return rows.map((row) => ({
      bundleId: row.bundleId,
      intentId: row.intentId,
      intentType: row.intentType,
      receipt: row.receiptJson ? JSON.parse(row.receiptJson) : null,
      recordedAt: row.recordedAt
    }));
  }
}

export function generateIntentId(intentType: string, index: number, rawId?: string): string {
  if (rawId && rawId.trim().length > 0) {
    return rawId;
  }
  return `${intentType}:${index.toString().padStart(4, '0')}`;
}
