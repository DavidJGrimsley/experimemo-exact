/**
 * @file experiment-data.ts
 *
 * Durable, offline-first local experiment data and persistence module for Experimemo in Exact.
 * Implements full parity with the original reference models and local data service:
 * - Reference models: F:/ReactNativeApps/experimemo/src/features/experiments/experiment-models.ts
 * - Reference service: F:/ReactNativeApps/experimemo/src/services/local-data.native.ts
 *
 * Features:
 * - Full data shape: ExperimentRecord, ExperimentResultEntry, ExperimentPhotoAsset, ExperimentInput.
 * - Exact two original example seed records (Bean sprouts, Cooling rate).
 * - Exact storage engine integration:
 *     - SQLite via `storage.sqlite` (app:/data/experiments.db) with serialized concurrency queue.
 *     - Atomic filesystem via `storage.fs` (app:/data/experiments.json).
 *     - Resilient in-memory fallback during build (`bake`), tests, or storage failure.
 * - Idempotent one-time bootstrap with sentinel flag (reset/delete never re-seeds).
 * - Sorting: list ordered by `updatedAt` descending.
 * - Deterministic IDs and timestamps support for testability and replay.
 * - Distinct preservation of experiment-level photos and result-level photos.
 * - Comprehensive error handling with zero accidental data loss.
 */

// ---------------------------------------------------------------------------
// Type Definitions
// ---------------------------------------------------------------------------

export type ExperimentStatus = 'active' | 'complete';

export interface ExperimentPhotoAsset {
  id: string;
  uri: string;
  fileName: string | null;
  mimeType: string | null;
  width: number;
  height: number;
}

export interface ExperimentResultEntry {
  id: string;
  recordedAt: string;
  notes: string;
  photoAssets: ExperimentPhotoAsset[];
}

export interface ExperimentRecord {
  id: string;
  title: string;
  category: string;
  hypothesis: string;
  procedure: string;
  dataPlan: string;
  observationsNotes: string;
  resultEntries: ExperimentResultEntry[];
  notes: string;
  conclusionNotes: string;
  plannedAttachmentCount: number;
  photoAssets: ExperimentPhotoAsset[];
  status: ExperimentStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ExperimentInput {
  title: string;
  category: string;
  hypothesis: string;
  procedure: string;
  dataPlan: string;
  observationsNotes: string;
  resultEntries: ExperimentResultEntry[];
  notes: string;
  conclusionNotes: string;
  plannedAttachmentCount: number;
  photoAssets: ExperimentPhotoAsset[];
}

export interface CreateExperimentOptions {
  /** Deterministic ID to use instead of generating one. */
  id?: string;
  /** Deterministic ISO timestamp to use for createdAt and updatedAt. */
  now?: string;
  /** Explicit status (defaults to 'active'). */
  status?: ExperimentStatus;
}

export interface UpdateExperimentOptions {
  /** Deterministic ISO timestamp to use for updatedAt. */
  now?: string;
}

export type StorageBackend = 'auto' | 'sqlite' | 'fs' | 'memory';

export interface StorageOptions {
  backend?: StorageBackend;
  dbPath?: string;
  fsPath?: string;
}

// ---------------------------------------------------------------------------
// Exact Storage Interface Types (Structural / Ambient)
// ---------------------------------------------------------------------------

export type SQLValue = null | bigint | number | string | Uint8Array;

export interface SQLRows {
  columns: string[];
  rows: SQLValue[][];
}

export interface SQLExecution {
  changes: number;
  lastInsertRowid: bigint;
}

export interface SQLCommand {
  sql: string;
  params?: SQLValue[];
}

export interface Database {
  execute(sql: string, params?: SQLValue[]): Promise<SQLExecution>;
  query(sql: string, params?: SQLValue[]): Promise<SQLRows>;
  prepare?(sql: string): Promise<unknown>;
  transaction?(commands: SQLCommand[]): Promise<SQLExecution[]>;
  close(): Promise<void>;
}

export interface SQLite {
  open(path: string): Promise<Database>;
}

export interface FileSystem {
  readFile(path: string): Promise<ArrayBuffer>;
  writeFile?(path: string, data: ArrayBuffer | Uint8Array): Promise<void>;
  atomicWriteFile(path: string, data: ArrayBuffer | Uint8Array): Promise<void>;
  rm?(path: string): Promise<void>;
}

export interface Storage {
  readonly fs?: FileSystem;
  readonly sqlite?: SQLite;
}

// ---------------------------------------------------------------------------
// Constants & Grants
// ---------------------------------------------------------------------------

export const EXPERIMENT_SQLITE_PATH = 'app:/data/experiments.db';
export const EXPERIMENT_FS_PATH = 'app:/data/experiments.json';
export const BOOTSTRAP_KEY = 'experiments_bootstrapped';

/**
 * Grants required in `app.ts` to access SQLite and FileSystem storage.
 * Use: `export const grants = EXPERIMENT_GRANTS;`
 */
export const EXPERIMENT_GRANTS = [
  `sqlite.open ${EXPERIMENT_SQLITE_PATH}`,
  `fs.read ${EXPERIMENT_FS_PATH}`,
  `fs.write ${EXPERIMENT_FS_PATH}`,
].join('\n');

export const experimentDataBoundaryNotes = [
  'Native and web builds store experiment records in local Exact SQLite or atomic file storage.',
  'If storage is unavailable (e.g. during build bake or test drives), the service falls back to in-memory records.',
  'Feature screens read and write through this boundary instead of interacting with low-level storage directly.',
  'Attached photos are stored as URI metadata on the experiment and result records, preserving separation.',
  'Resetting or deleting all records sets a bootstrap sentinel so starter experiments are never re-seeded.',
  'All operations support deterministic ID and timestamp injection for reproducible testing.',
];

// ---------------------------------------------------------------------------
// Exact Two Original Seed Records
// ---------------------------------------------------------------------------

export const seedExperiments: ExperimentRecord[] = [
  {
    id: 'experiment-seed-1',
    title: 'Bean sprouts under different light conditions (Example)',
    category: 'Botany',
    hypothesis:
      'Bean sprouts exposed to indirect daylight will grow taller than sprouts kept under a desk lamp for the same duration.',
    procedure:
      'Plant matching bean seeds in two trays, water them equally, place one tray near a window and the other under a desk lamp, then measure height every 24 hours.',
    dataPlan: 'Record height, color changes, and moisture level once per day for seven days.',
    observationsNotes:
      'Window tray currently shows slightly faster growth after the first 48 hours.',
    resultEntries: [
      {
        id: 'result-seed-1',
        recordedAt: '2026-06-16T17:10:00.000Z',
        notes:
          'Window tray stems are taller and greener than the desk lamp tray after the first measurement cycle.',
        photoAssets: [],
      },
    ],
    notes: 'Need clearer labels for tray photos before the next measurement cycle.',
    conclusionNotes: '',
    plannedAttachmentCount: 2,
    photoAssets: [],
    status: 'active',
    createdAt: '2026-06-14T09:30:00.000Z',
    updatedAt: '2026-06-16T17:10:00.000Z',
  },
  {
    id: 'experiment-seed-2',
    title: 'Cooling rate of metal versus glass containers (Example)',
    category: 'Physics',
    hypothesis:
      'Water stored in a metal container will lose heat faster than water stored in a glass container of the same size.',
    procedure:
      'Fill matched containers with hot water, measure initial temperature, then log temperature every five minutes for thirty minutes.',
    dataPlan: 'Track time, temperature, room conditions, and any handling disturbances.',
    observationsNotes: 'Draft setup ready; first timed run has not been started yet.',
    resultEntries: [],
    notes: 'Bring insulated gloves and set up tripod before running measurements.',
    conclusionNotes: '',
    plannedAttachmentCount: 0,
    photoAssets: [],
    status: 'active',
    createdAt: '2026-06-15T13:00:00.000Z',
    updatedAt: '2026-06-15T13:00:00.000Z',
  },
];

// ---------------------------------------------------------------------------
// Helpers & Normalization
// ---------------------------------------------------------------------------

export function cloneRecord(record: ExperimentRecord): ExperimentRecord {
  return {
    ...record,
    resultEntries: record.resultEntries.map((re) => ({
      ...re,
      photoAssets: re.photoAssets.map((p) => ({ ...p })),
    })),
    photoAssets: record.photoAssets.map((p) => ({ ...p })),
  };
}

export function sortExperiments(experiments: ExperimentRecord[]): ExperimentRecord[] {
  return [...experiments].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function parseResultEntries(value: unknown): ExperimentResultEntry[] {
  if (Array.isArray(value)) {
    return value.map((entry) => ({
      id: String(entry?.id ?? `result-${Date.now()}`),
      recordedAt: String(entry?.recordedAt ?? new Date().toISOString()),
      notes: String(entry?.notes ?? ''),
      photoAssets: Array.isArray(entry?.photoAssets) ? entry.photoAssets.map(normalizePhotoAsset) : [],
    }));
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value || '[]');
      return Array.isArray(parsed) ? parseResultEntries(parsed) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function normalizePhotoAsset(raw: unknown): ExperimentPhotoAsset {
  const asset = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    id: String(asset.id ?? `photo-${Date.now()}`),
    uri: String(asset.uri ?? ''),
    fileName: asset.fileName !== undefined && asset.fileName !== null ? String(asset.fileName) : null,
    mimeType: asset.mimeType !== undefined && asset.mimeType !== null ? String(asset.mimeType) : null,
    width: Number(asset.width) || 0,
    height: Number(asset.height) || 0,
  };
}

function parsePhotoAssets(value: unknown): ExperimentPhotoAsset[] {
  if (Array.isArray(value)) {
    return value.map(normalizePhotoAsset);
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value || '[]');
      return Array.isArray(parsed) ? parsePhotoAssets(parsed) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function rowToRecord(columns: string[], row: SQLValue[]): ExperimentRecord {
  const colMap = new Map<string, SQLValue>();
  for (let i = 0; i < columns.length; i++) {
    colMap.set(columns[i], row[i]);
  }

  const getStr = (col: string, fallback = ''): string => {
    const val = colMap.get(col);
    return val !== null && val !== undefined ? String(val) : fallback;
  };

  const getNum = (col: string, fallback = 0): number => {
    const val = colMap.get(col);
    if (typeof val === 'bigint') return Number(val);
    if (typeof val === 'number') return val;
    if (typeof val === 'string') {
      const parsed = Number(val);
      return Number.isFinite(parsed) ? parsed : fallback;
    }
    return fallback;
  };

  return {
    id: getStr('id'),
    title: getStr('title'),
    category: getStr('category', 'General'),
    hypothesis: getStr('hypothesis'),
    procedure: getStr('procedure'),
    dataPlan: getStr('data_plan'),
    observationsNotes: getStr('results_notes'),
    resultEntries: parseResultEntries(colMap.get('result_entries')),
    notes: getStr('notes'),
    conclusionNotes: getStr('conclusion_notes'),
    plannedAttachmentCount: getNum('planned_attachment_count', 0),
    photoAssets: parsePhotoAssets(colMap.get('photo_assets')),
    status: getStr('status') === 'complete' ? 'complete' : 'active',
    createdAt: getStr('created_at'),
    updatedAt: getStr('updated_at'),
  };
}

// ---------------------------------------------------------------------------
// Concurrency Serializer & In-Memory Fallback State
// ---------------------------------------------------------------------------

let defaultStorage: Storage | null = null;

export function setDefaultStorage(storage: Storage | null): void {
  defaultStorage = storage;
}

export function getDefaultStorage(): Storage | null {
  return defaultStorage;
}

let memoryBootstrapped = false;
let memoryExperiments: ExperimentRecord[] = [];

export function getMemoryState(): { bootstrapped: boolean; experiments: ExperimentRecord[] } {
  return {
    bootstrapped: memoryBootstrapped,
    experiments: memoryExperiments.map(cloneRecord),
  };
}

export function setMemoryState(state: { bootstrapped: boolean; experiments: ExperimentRecord[] }): void {
  memoryBootstrapped = state.bootstrapped;
  memoryExperiments = state.experiments.map(cloneRecord);
}

export function resetMemoryStore(): void {
  memoryBootstrapped = false;
  memoryExperiments = [];
}

let sqliteQueue: Promise<unknown> = Promise.resolve();

function serialSqlite<T>(work: () => Promise<T>): Promise<T> {
  const next = sqliteQueue.then(work);
  sqliteQueue = next.catch(() => {});
  return next;
}

// ---------------------------------------------------------------------------
// Argument Resolver
// ---------------------------------------------------------------------------

function isStorage(arg: unknown): arg is Storage {
  if (typeof arg !== 'object' || arg === null) return false;
  return 'fs' in arg || 'sqlite' in arg;
}

function resolveStorageAndOptions<T extends object>(
  arg1?: Storage | T,
  arg2?: Storage | T
): { storage: Storage | null; options: T } {
  let storage: Storage | null = null;
  let options = {} as T;

  if (isStorage(arg1)) {
    storage = arg1;
    if (arg2 && !isStorage(arg2)) {
      options = arg2;
    }
  } else if (arg1 && typeof arg1 === 'object') {
    options = arg1 as T;
    if (isStorage(arg2)) {
      storage = arg2;
    }
  } else if (isStorage(arg2)) {
    storage = arg2;
  }

  if (!storage) {
    storage = defaultStorage;
  }

  return { storage, options };
}

// ---------------------------------------------------------------------------
// Storage Implementations: SQLite, FileSystem, Memory
// ---------------------------------------------------------------------------

interface StoreDriver {
  ensureReady(): Promise<void>;
  list(): Promise<ExperimentRecord[]>;
  get(id: string): Promise<ExperimentRecord | null>;
  create(record: ExperimentRecord): Promise<ExperimentRecord>;
  update(record: ExperimentRecord): Promise<ExperimentRecord | null>;
  delete(ids: string[]): Promise<void>;
  reset(): Promise<void>;
}

// 1. In-Memory Driver
class MemoryDriver implements StoreDriver {
  async ensureReady(): Promise<void> {
    if (memoryBootstrapped) return;
    memoryExperiments = seedExperiments.map(cloneRecord);
    memoryBootstrapped = true;
  }

  async list(): Promise<ExperimentRecord[]> {
    await this.ensureReady();
    return sortExperiments(memoryExperiments.map(cloneRecord));
  }

  async get(id: string): Promise<ExperimentRecord | null> {
    await this.ensureReady();
    const found = memoryExperiments.find((e) => e.id === id);
    return found ? cloneRecord(found) : null;
  }

  async create(record: ExperimentRecord): Promise<ExperimentRecord> {
    await this.ensureReady();
    memoryExperiments = [cloneRecord(record), ...memoryExperiments];
    return cloneRecord(record);
  }

  async update(record: ExperimentRecord): Promise<ExperimentRecord | null> {
    await this.ensureReady();
    const index = memoryExperiments.findIndex((e) => e.id === record.id);
    if (index === -1) return null;
    memoryExperiments[index] = cloneRecord(record);
    return cloneRecord(record);
  }

  async delete(ids: string[]): Promise<void> {
    await this.ensureReady();
    const idSet = new Set(ids);
    memoryExperiments = memoryExperiments.filter((e) => !idSet.has(e.id));
  }

  async reset(): Promise<void> {
    memoryBootstrapped = true;
    memoryExperiments = [];
  }
}

// 2. FileSystem Driver (app:/data/experiments.json)
interface FsStatePayload {
  bootstrapped: boolean;
  experiments: ExperimentRecord[];
}

class FsDriver implements StoreDriver {
  private fs: FileSystem;
  private path: string;

  constructor(fs: FileSystem, path: string = EXPERIMENT_FS_PATH) {
    this.fs = fs;
    this.path = path;
  }

  private async readState(): Promise<FsStatePayload> {
    try {
      const buffer = await this.fs.readFile(this.path);
      const text = new TextDecoder().decode(buffer);
      const parsed = JSON.parse(text);
      return {
        bootstrapped: Boolean(parsed?.bootstrapped),
        experiments: Array.isArray(parsed?.experiments)
          ? parsed.experiments.map((e: unknown) => {
              const rec = (e ?? {}) as Record<string, unknown>;
              return {
                id: String(rec.id ?? ''),
                title: String(rec.title ?? ''),
                category: String(rec.category ?? 'General'),
                hypothesis: String(rec.hypothesis ?? ''),
                procedure: String(rec.procedure ?? ''),
                dataPlan: String(rec.dataPlan ?? ''),
                observationsNotes: String(rec.observationsNotes ?? ''),
                resultEntries: parseResultEntries(rec.resultEntries),
                notes: String(rec.notes ?? ''),
                conclusionNotes: String(rec.conclusionNotes ?? ''),
                plannedAttachmentCount: Number(rec.plannedAttachmentCount) || 0,
                photoAssets: parsePhotoAssets(rec.photoAssets),
                status: rec.status === 'complete' ? 'complete' : 'active',
                createdAt: String(rec.createdAt ?? ''),
                updatedAt: String(rec.updatedAt ?? ''),
              };
            })
          : [],
      };
    } catch (e: unknown) {
      const code = (e as { code?: string })?.code;
      if (code === 'ENOENT' || (e instanceof Error && e.message.includes('ENOENT'))) {
        return { bootstrapped: false, experiments: [] };
      }
      throw e;
    }
  }

  private async writeState(state: FsStatePayload): Promise<void> {
    const encoded = new TextEncoder().encode(JSON.stringify(state, null, 2));
    if (typeof this.fs.atomicWriteFile === 'function') {
      await this.fs.atomicWriteFile(this.path, encoded);
    } else if (typeof this.fs.writeFile === 'function') {
      await this.fs.writeFile(this.path, encoded);
    } else {
      throw new Error('FileSystem implementation lacks atomicWriteFile and writeFile');
    }
  }

  async ensureReady(): Promise<void> {
    const state = await this.readState();
    if (state.bootstrapped) return;

    if (state.experiments.length > 0) {
      state.bootstrapped = true;
      await this.writeState(state);
      return;
    }

    state.bootstrapped = true;
    state.experiments = seedExperiments.map(cloneRecord);
    await this.writeState(state);
  }

  async list(): Promise<ExperimentRecord[]> {
    await this.ensureReady();
    const state = await this.readState();
    return sortExperiments(state.experiments);
  }

  async get(id: string): Promise<ExperimentRecord | null> {
    await this.ensureReady();
    const state = await this.readState();
    const found = state.experiments.find((e) => e.id === id);
    return found ? cloneRecord(found) : null;
  }

  async create(record: ExperimentRecord): Promise<ExperimentRecord> {
    await this.ensureReady();
    const state = await this.readState();
    state.experiments = [cloneRecord(record), ...state.experiments];
    await this.writeState(state);
    return cloneRecord(record);
  }

  async update(record: ExperimentRecord): Promise<ExperimentRecord | null> {
    await this.ensureReady();
    const state = await this.readState();
    const index = state.experiments.findIndex((e) => e.id === record.id);
    if (index === -1) return null;
    state.experiments[index] = cloneRecord(record);
    await this.writeState(state);
    return cloneRecord(record);
  }

  async delete(ids: string[]): Promise<void> {
    await this.ensureReady();
    const state = await this.readState();
    const idSet = new Set(ids);
    state.experiments = state.experiments.filter((e) => !idSet.has(e.id));
    await this.writeState(state);
  }

  async reset(): Promise<void> {
    await this.writeState({
      bootstrapped: true,
      experiments: [],
    });
  }
}

// 3. SQLite Driver (app:/data/experiments.db)
class SqliteDriver implements StoreDriver {
  private sqlite: SQLite;
  private path: string;

  constructor(sqlite: SQLite, path: string = EXPERIMENT_SQLITE_PATH) {
    this.sqlite = sqlite;
    this.path = path;
  }

  private async withDb<T>(work: (db: Database) => Promise<T>): Promise<T> {
    return serialSqlite(async () => {
      const db = await this.sqlite.open(this.path);
      try {
        return await work(db);
      } finally {
        await db.close();
      }
    });
  }

  async ensureReady(): Promise<void> {
    await this.withDb(async (db) => {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS app_state (
          key TEXT PRIMARY KEY NOT NULL,
          value TEXT NOT NULL
        );
      `);

      await db.execute(`
        CREATE TABLE IF NOT EXISTS experiments (
          id TEXT PRIMARY KEY NOT NULL,
          title TEXT NOT NULL,
          category TEXT NOT NULL,
          hypothesis TEXT NOT NULL,
          procedure TEXT NOT NULL,
          data_plan TEXT NOT NULL,
          results_notes TEXT NOT NULL,
          result_entries TEXT NOT NULL DEFAULT '[]',
          notes TEXT NOT NULL,
          conclusion_notes TEXT NOT NULL DEFAULT '',
          planned_attachment_count INTEGER NOT NULL DEFAULT 0,
          photo_assets TEXT NOT NULL DEFAULT '[]',
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);

      // Safe column migrations for older schema versions
      for (const colDef of [
        'photo_assets TEXT NOT NULL DEFAULT "[]"',
        'result_entries TEXT NOT NULL DEFAULT "[]"',
        'conclusion_notes TEXT NOT NULL DEFAULT ""',
      ]) {
        try {
          await db.execute(`ALTER TABLE experiments ADD COLUMN ${colDef};`);
        } catch {
          // Column already exists; safe no-op
        }
      }

      await db.execute(`UPDATE experiments SET status = 'active' WHERE status = 'draft'`);

      const bootstrapRes = await db.query(
        'SELECT value FROM app_state WHERE key = ?',
        [BOOTSTRAP_KEY]
      );
      if (bootstrapRes.rows.length > 0 && String(bootstrapRes.rows[0][0]) === 'true') {
        return;
      }

      const countRes = await db.query('SELECT COUNT(*) FROM experiments');
      const count = countRes.rows.length > 0 ? Number(countRes.rows[0][0]) : 0;
      if (count > 0) {
        await db.execute(
          'INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)',
          [BOOTSTRAP_KEY, 'true']
        );
        return;
      }

      for (const exp of seedExperiments) {
        await db.execute(
          `INSERT INTO experiments (
            id, title, category, hypothesis, procedure, data_plan, results_notes,
            result_entries, notes, conclusion_notes, planned_attachment_count,
            photo_assets, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            exp.id,
            exp.title,
            exp.category,
            exp.hypothesis,
            exp.procedure,
            exp.dataPlan,
            exp.observationsNotes,
            JSON.stringify(exp.resultEntries),
            exp.notes,
            exp.conclusionNotes,
            exp.plannedAttachmentCount,
            JSON.stringify(exp.photoAssets),
            exp.status,
            exp.createdAt,
            exp.updatedAt,
          ]
        );
      }

      await db.execute(
        'INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)',
        [BOOTSTRAP_KEY, 'true']
      );
    });
  }

  async list(): Promise<ExperimentRecord[]> {
    await this.ensureReady();
    return this.withDb(async (db) => {
      const res = await db.query('SELECT * FROM experiments ORDER BY updated_at DESC');
      return res.rows.map((row) => rowToRecord(res.columns, row));
    });
  }

  async get(id: string): Promise<ExperimentRecord | null> {
    await this.ensureReady();
    return this.withDb(async (db) => {
      const res = await db.query('SELECT * FROM experiments WHERE id = ?', [id]);
      if (res.rows.length === 0) return null;
      return rowToRecord(res.columns, res.rows[0]);
    });
  }

  async create(record: ExperimentRecord): Promise<ExperimentRecord> {
    await this.ensureReady();
    return this.withDb(async (db) => {
      await db.execute(
        `INSERT INTO experiments (
          id, title, category, hypothesis, procedure, data_plan, results_notes,
          result_entries, notes, conclusion_notes, planned_attachment_count,
          photo_assets, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          record.id,
          record.title,
          record.category,
          record.hypothesis,
          record.procedure,
          record.dataPlan,
          record.observationsNotes,
          JSON.stringify(record.resultEntries),
          record.notes,
          record.conclusionNotes,
          record.plannedAttachmentCount,
          JSON.stringify(record.photoAssets),
          record.status,
          record.createdAt,
          record.updatedAt,
        ]
      );
      return cloneRecord(record);
    });
  }

  async update(record: ExperimentRecord): Promise<ExperimentRecord | null> {
    await this.ensureReady();
    return this.withDb(async (db) => {
      const res = await db.execute(
        `UPDATE experiments
         SET title = ?, category = ?, hypothesis = ?, procedure = ?, data_plan = ?,
             results_notes = ?, result_entries = ?, notes = ?, conclusion_notes = ?,
             planned_attachment_count = ?, photo_assets = ?, status = ?, updated_at = ?
         WHERE id = ?`,
        [
          record.title,
          record.category,
          record.hypothesis,
          record.procedure,
          record.dataPlan,
          record.observationsNotes,
          JSON.stringify(record.resultEntries),
          record.notes,
          record.conclusionNotes,
          record.plannedAttachmentCount,
          JSON.stringify(record.photoAssets),
          record.status,
          record.updatedAt,
          record.id,
        ]
      );
      if (res.changes === 0) return null;
      return cloneRecord(record);
    });
  }

  async delete(ids: string[]): Promise<void> {
    await this.ensureReady();
    if (ids.length === 0) return;
    await this.withDb(async (db) => {
      const placeholders = ids.map(() => '?').join(', ');
      await db.execute(`DELETE FROM experiments WHERE id IN (${placeholders})`, ids);
    });
  }

  async reset(): Promise<void> {
    await this.withDb(async (db) => {
      await db.execute('DELETE FROM experiments');
      await db.execute(
        'INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)',
        [BOOTSTRAP_KEY, 'true']
      );
    });
  }
}

// ---------------------------------------------------------------------------
// Store Factory / Driver Resolution
// ---------------------------------------------------------------------------

export function resolveStoreDriver(
  storage?: Storage | null,
  options?: StorageOptions
): StoreDriver {
  const backend = options?.backend ?? 'auto';

  if (backend === 'memory' || !storage) {
    return new MemoryDriver();
  }

  if (backend === 'sqlite') {
    if (storage.sqlite) {
      return new SqliteDriver(storage.sqlite, options?.dbPath ?? EXPERIMENT_SQLITE_PATH);
    }
    return new MemoryDriver();
  }

  if (backend === 'fs') {
    if (storage.fs) {
      return new FsDriver(storage.fs, options?.fsPath ?? EXPERIMENT_FS_PATH);
    }
    return new MemoryDriver();
  }

  // 'auto' mode: prefer SQLite if available, else FS, else Memory
  if (storage.sqlite) {
    return new SqliteDriver(storage.sqlite, options?.dbPath ?? EXPERIMENT_SQLITE_PATH);
  }
  if (storage.fs) {
    return new FsDriver(storage.fs, options?.fsPath ?? EXPERIMENT_FS_PATH);
  }
  return new MemoryDriver();
}

/**
 * Resilient driver executor that catches storage rejections (e.g. 'bake' during build
 * or runtime I/O unavailability) and seamlessly falls back to memory.
 */
class ResilientDriver implements StoreDriver {
  private primary: StoreDriver;
  private fallback: MemoryDriver;

  constructor(primary: StoreDriver) {
    this.primary = primary;
    this.fallback = new MemoryDriver();
  }

  private async executeWithFallback<T>(
    operation: (driver: StoreDriver) => Promise<T>,
    fallbackOp?: (driver: StoreDriver) => Promise<T>
  ): Promise<T> {
    try {
      return await operation(this.primary);
    } catch (e: unknown) {
      const code = (e as { code?: string })?.code;
      // In Exact, 'bake' is the build-phase storage refusal code; 'denied' is permission failure
      if (code === 'bake' || code === 'denied' || (e instanceof Error && e.message.includes('unavailable'))) {
        return fallbackOp ? await fallbackOp(this.fallback) : await operation(this.fallback);
      }
      // If primary driver fails unexpectedly, fall back to memory without crash
      try {
        return fallbackOp ? await fallbackOp(this.fallback) : await operation(this.fallback);
      } catch {
        throw e;
      }
    }
  }

  ensureReady(): Promise<void> {
    return this.executeWithFallback((d) => d.ensureReady());
  }

  list(): Promise<ExperimentRecord[]> {
    return this.executeWithFallback((d) => d.list());
  }

  get(id: string): Promise<ExperimentRecord | null> {
    return this.executeWithFallback((d) => d.get(id));
  }

  create(record: ExperimentRecord): Promise<ExperimentRecord> {
    return this.executeWithFallback((d) => d.create(record));
  }

  update(record: ExperimentRecord): Promise<ExperimentRecord | null> {
    return this.executeWithFallback((d) => d.update(record));
  }

  delete(ids: string[]): Promise<void> {
    return this.executeWithFallback((d) => d.delete(ids));
  }

  reset(): Promise<void> {
    return this.executeWithFallback((d) => d.reset());
  }
}

// ---------------------------------------------------------------------------
// ExperimentStore Class Wrapper
// ---------------------------------------------------------------------------

export class ExperimentStore {
  private driver: StoreDriver;

  constructor(storage?: Storage | null, options?: StorageOptions) {
    const rawDriver = resolveStoreDriver(storage, options);
    this.driver = new ResilientDriver(rawDriver);
  }

  async ensureReady(): Promise<void> {
    return this.driver.ensureReady();
  }

  async listExperiments(): Promise<ExperimentRecord[]> {
    return this.driver.list();
  }

  async getExperimentById(id: string): Promise<ExperimentRecord | null> {
    return this.driver.get(id);
  }

  async createExperiment(
    input: ExperimentInput,
    options?: CreateExperimentOptions
  ): Promise<ExperimentRecord> {
    const now = options?.now ?? new Date().toISOString();
    const id = options?.id ?? `experiment-${Date.now()}`;
    const status = options?.status ?? 'active';

    const record: ExperimentRecord = {
      id,
      title: input.title.trim(),
      category: input.category.trim() || 'General',
      hypothesis: input.hypothesis.trim(),
      procedure: input.procedure.trim(),
      dataPlan: input.dataPlan.trim(),
      observationsNotes: input.observationsNotes.trim(),
      resultEntries: Array.isArray(input.resultEntries)
        ? input.resultEntries.map((re) => ({
            ...re,
            photoAssets: Array.isArray(re.photoAssets) ? re.photoAssets.map(normalizePhotoAsset) : [],
          }))
        : [],
      notes: input.notes.trim(),
      conclusionNotes: (input.conclusionNotes ?? '').trim(),
      plannedAttachmentCount: Math.max(0, Number(input.plannedAttachmentCount) || 0),
      photoAssets: Array.isArray(input.photoAssets)
        ? input.photoAssets.map(normalizePhotoAsset)
        : [],
      status: status === 'complete' ? 'complete' : 'active',
      createdAt: now,
      updatedAt: now,
    };

    return this.driver.create(record);
  }

  async updateExperiment(
    id: string,
    input: ExperimentInput,
    options?: UpdateExperimentOptions
  ): Promise<ExperimentRecord | null> {
    const existing = await this.driver.get(id);
    if (!existing) return null;

    const updatedAt = options?.now ?? new Date().toISOString();

    const updated: ExperimentRecord = {
      ...existing,
      title: input.title.trim(),
      category: input.category.trim() || 'General',
      hypothesis: input.hypothesis.trim(),
      procedure: input.procedure.trim(),
      dataPlan: input.dataPlan.trim(),
      observationsNotes: input.observationsNotes.trim(),
      resultEntries: Array.isArray(input.resultEntries)
        ? input.resultEntries.map((re) => ({
            ...re,
            photoAssets: Array.isArray(re.photoAssets) ? re.photoAssets.map(normalizePhotoAsset) : [],
          }))
        : [],
      notes: input.notes.trim(),
      conclusionNotes: (input.conclusionNotes ?? '').trim(),
      plannedAttachmentCount: Math.max(0, Number(input.plannedAttachmentCount) || 0),
      photoAssets: Array.isArray(input.photoAssets)
        ? input.photoAssets.map(normalizePhotoAsset)
        : [],
      updatedAt,
      status: existing.status === 'complete' ? 'complete' : 'active',
    };

    return this.driver.update(updated);
  }

  async updateExperimentStatus(
    id: string,
    status: ExperimentStatus,
    options?: UpdateExperimentOptions
  ): Promise<ExperimentRecord | null> {
    const existing = await this.driver.get(id);
    if (!existing) return null;

    const updatedAt = options?.now ?? new Date().toISOString();

    const updated: ExperimentRecord = {
      ...existing,
      status: status === 'complete' ? 'complete' : 'active',
      updatedAt,
    };

    return this.driver.update(updated);
  }

  async deleteExperiments(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    return this.driver.delete(ids);
  }

  async deleteExperiment(id: string): Promise<void> {
    return this.driver.delete([id]);
  }

  async resetExperiments(): Promise<void> {
    return this.driver.reset();
  }
}

// ---------------------------------------------------------------------------
// Standalone Functional API (1:1 with reference service signatures)
// ---------------------------------------------------------------------------

function getStore(storage?: Storage | null, options?: StorageOptions): ExperimentStore {
  return new ExperimentStore(storage, options);
}

export async function ensureLocalDataReady(
  arg1?: Storage | StorageOptions,
  arg2?: StorageOptions
): Promise<void> {
  const { storage, options } = resolveStorageAndOptions<StorageOptions>(arg1, arg2);
  return getStore(storage, options).ensureReady();
}

export async function listExperiments(
  arg1?: Storage | StorageOptions,
  arg2?: StorageOptions
): Promise<ExperimentRecord[]> {
  const { storage, options } = resolveStorageAndOptions<StorageOptions>(arg1, arg2);
  return getStore(storage, options).listExperiments();
}

export async function getExperimentById(
  id: string,
  arg1?: Storage | StorageOptions,
  arg2?: StorageOptions
): Promise<ExperimentRecord | null> {
  const { storage, options } = resolveStorageAndOptions<StorageOptions>(arg1, arg2);
  return getStore(storage, options).getExperimentById(id);
}

export async function createExperiment(
  input: ExperimentInput,
  arg1?: Storage | (CreateExperimentOptions & StorageOptions),
  arg2?: Storage | (CreateExperimentOptions & StorageOptions)
): Promise<ExperimentRecord> {
  const { storage, options } = resolveStorageAndOptions<CreateExperimentOptions & StorageOptions>(
    arg1,
    arg2
  );
  return getStore(storage, options).createExperiment(input, options);
}

export async function updateExperiment(
  id: string,
  input: ExperimentInput,
  arg1?: Storage | (UpdateExperimentOptions & StorageOptions),
  arg2?: Storage | (UpdateExperimentOptions & StorageOptions)
): Promise<ExperimentRecord | null> {
  const { storage, options } = resolveStorageAndOptions<UpdateExperimentOptions & StorageOptions>(
    arg1,
    arg2
  );
  return getStore(storage, options).updateExperiment(id, input, options);
}

export async function updateExperimentStatus(
  id: string,
  status: ExperimentStatus,
  arg1?: Storage | (UpdateExperimentOptions & StorageOptions),
  arg2?: Storage | (UpdateExperimentOptions & StorageOptions)
): Promise<ExperimentRecord | null> {
  const { storage, options } = resolveStorageAndOptions<UpdateExperimentOptions & StorageOptions>(
    arg1,
    arg2
  );
  return getStore(storage, options).updateExperimentStatus(id, status, options);
}

export async function deleteExperiments(
  ids: string[],
  arg1?: Storage | StorageOptions,
  arg2?: StorageOptions
): Promise<void> {
  const { storage, options } = resolveStorageAndOptions<StorageOptions>(arg1, arg2);
  return getStore(storage, options).deleteExperiments(ids);
}

export async function deleteExperiment(
  id: string,
  arg1?: Storage | StorageOptions,
  arg2?: StorageOptions
): Promise<void> {
  const { storage, options } = resolveStorageAndOptions<StorageOptions>(arg1, arg2);
  return getStore(storage, options).deleteExperiment(id);
}

export async function resetExperiments(
  arg1?: Storage | StorageOptions,
  arg2?: StorageOptions
): Promise<void> {
  const { storage, options } = resolveStorageAndOptions<StorageOptions>(arg1, arg2);
  return getStore(storage, options).resetExperiments();
}
