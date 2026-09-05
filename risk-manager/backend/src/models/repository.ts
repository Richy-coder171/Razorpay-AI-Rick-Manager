/**
 * Repository pattern (§4): storage behind IRepository<T>, with JsonFile and
 * Mongo implementations switched by DB_DRIVER=mongo|file.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Collection, Db, MongoClient } from 'mongodb';
import { config } from '../config';
import logger from '../utils/logger';

export interface IRepository<T> {
  insert(doc: T): Promise<T>;
  insertMany(docs: T[]): Promise<T[]>;
  findById(id: string): Promise<T | null>;
  findAll(filter?: Partial<Record<string, unknown>>): Promise<T[]>;
  findOne(filter: Partial<Record<string, unknown>>): Promise<T | null>;
  count(filter?: Partial<Record<string, unknown>>): Promise<number>;
  /** NOTE: intentionally NO update/delete. Audit is append-only (§16). */
}

export class JsonFileRepository<T extends { id: string }> implements IRepository<T> {
  private file: string;
  private cache: T[] | null = null;

  constructor(fileName: string, private dataDir?: string) {
    const dir = dataDir || config.data_dir;
    fs.mkdirSync(path.resolve(dir), { recursive: true });
    this.file = path.resolve(dir, fileName);
  }

  private read(): T[] {
    if (this.cache) return this.cache;
    if (!fs.existsSync(this.file)) {
      this.cache = [];
      return this.cache;
    }
    try {
      this.cache = JSON.parse(fs.readFileSync(this.file, 'utf8')) as T[];
    } catch {
      logger.warn({ file: this.file }, 'corrupt repository file — starting empty');
      this.cache = [];
    }
    return this.cache;
  }

  private write(docs: T[]): void {
    this.cache = docs;
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(docs, null, 2));
    fs.renameSync(tmp, this.file); // atomic on same volume
  }

  async insert(doc: T): Promise<T> {
    const docs = this.read();
    if (docs.some((d) => (d as { id: string }).id === doc.id)) {
      throw new Error(`duplicate id: ${doc.id}`);
    }
    docs.push(doc);
    this.write(docs);
    return doc;
  }

  async insertMany(docs: T[]): Promise<T[]> {
    for (const d of docs) await this.insert(d);
    return docs;
  }

  async findById(id: string): Promise<T | null> {
    return this.read().find((d) => d.id === id) || null;
  }

  async findAll(filter?: Partial<Record<string, unknown>>): Promise<T[]> {
    const docs = this.read();
    if (!filter) return [...docs].reverse();
    return docs.filter((d) => matches(d, filter)).reverse();
  }

  async findOne(filter: Partial<Record<string, unknown>>): Promise<T | null> {
    const docs = this.read();
    for (let i = docs.length - 1; i >= 0; i--) {
      if (matches(docs[i], filter)) return docs[i];
    }
    return null;
  }

  async count(filter?: Partial<Record<string, unknown>>): Promise<number> {
    return (await this.findAll(filter)).length;
  }
}

/**
 * Deep-strip undefined-valued keys. The MongoDB driver serializes undefined
 * as null, which would change the document shape between the in-memory
 * record (hashed by AuditService, where stableStringify SKIPS undefined) and
 * the stored/read-back record — breaking hash-chain verification. Stripping
 * before insert makes the stored document byte-identical to the hashed form.
 */
function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => (v === undefined ? null : stripUndefined(v))) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) out[k] = stripUndefined(v);
    }
    return out as T;
  }
  return value;
}

export class MongoRepository<T extends { id: string }> implements IRepository<T> {
  private static client: MongoClient | null = null;
  private static db: Db | null = null;
  private collection: Promise<Collection<T>> | null = null;
  private readonly collName: string;

  constructor(collName: string) {
    this.collName = collName;
  }

  private async coll(): Promise<Collection<T>> {
    if (!this.collection) {
      this.collection = (async () => {
        if (!MongoRepository.db) {
          MongoRepository.client = new MongoClient(config.mongo_uri, { serverSelectionTimeoutMS: 5000 });
          await MongoRepository.client.connect();
          MongoRepository.db = MongoRepository.client.db();
          logger.info({ uri: redactUri(config.mongo_uri) }, 'connected to MongoDB');
        }
        return MongoRepository.db!.collection<T>(this.collName);
      })();
    }
    return this.collection;
  }

  async insert(doc: T): Promise<T> {
    const coll = await this.coll();
    try {
      await coll.insertOne(stripUndefined(doc) as unknown as OptionalUnlessRequiredId<T>);
      return doc;
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        throw new Error(`duplicate id: ${doc.id}`);
      }
      throw err;
    }
  }

  async insertMany(docs: T[]): Promise<T[]> {
    const coll = await this.coll();
    if (docs.length === 0) return docs;
    await coll.insertMany(docs.map(stripUndefined) as unknown as readonly OptionalUnlessRequiredId<T>[]);
    return docs;
  }

  async findById(id: string): Promise<T | null> {
    const coll = await this.coll();
    const found = await coll.findOne({ id } as unknown as Filter<T>);
    return (found as T | null) ?? null;
  }

  async findAll(filter?: Partial<Record<string, unknown>>): Promise<T[]> {
    const coll = await this.coll();
    const cursor = coll.find((filter || {}) as unknown as Filter<T>);
    const docs = await cursor.sort({ timestamp: -1, _id: -1 } as unknown as Sort).toArray();
    return docs as unknown as T[];
  }

  async findOne(filter: Partial<Record<string, unknown>>): Promise<T | null> {
    const coll = await this.coll();
    const found = await coll.findOne(filter as unknown as Filter<T>);
    return (found as T | null) ?? null;
  }

  async count(filter?: Partial<Record<string, unknown>>): Promise<number> {
    const coll = await this.coll();
    return coll.countDocuments((filter || {}) as unknown as Filter<T>);
  }
}

import type { Filter, OptionalUnlessRequiredId, Sort } from 'mongodb';

function matches(doc: unknown, filter: Partial<Record<string, unknown>>): boolean {
  for (const [k, v] of Object.entries(filter)) {
    if ((doc as Record<string, unknown>)[k] !== v) return false;
  }
  return true;
}

function redactUri(uri: string): string {
  return uri.replace(/\/\/[^@]+@/, '//***@');
}

/** Test-only export: the document normalization used before Mongo inserts. */
export const __testStripUndefined = stripUndefined;

/** Factory: DB_DRIVER=mono|file (typo-safe: anything not 'mongo' means file). */
export function createRepository<T extends { id: string }>(collectionName: string, fileName: string): IRepository<T> {
  if (config.db_driver === 'mongo') {
    return new MongoRepository<T>(collectionName);
  }
  return new JsonFileRepository<T>(fileName);
}
