/**
 * Test helpers: in-memory repository for unit tests.
 */

import { IRepository } from './models/repository';

export class InMemoryRepository<T extends { id: string }> implements IRepository<T> {
  public docs: T[] = [];

  async insert(doc: T): Promise<T> {
    if (this.docs.some((d) => d.id === doc.id)) throw new Error(`duplicate id: ${doc.id}`);
    this.docs.push(doc);
    return doc;
  }

  async insertMany(docs: T[]): Promise<T[]> {
    for (const d of docs) await this.insert(d);
    return docs;
  }

  async findById(id: string): Promise<T | null> {
    return this.docs.find((d) => d.id === id) || null;
  }

  async findAll(filter?: Partial<Record<string, unknown>>): Promise<T[]> {
    let out = [...this.docs];
    if (filter) {
      out = out.filter((d) => Object.entries(filter).every(([k, v]) => (d as Record<string, unknown>)[k] === v));
    }
    return out.reverse();
  }

  async findOne(filter: Partial<Record<string, unknown>>): Promise<T | null> {
    const all = await this.findAll();
    return all[all.length - 1] || null;
  }

  async count(filter?: Partial<Record<string, unknown>>): Promise<number> {
    return (await this.findAll(filter)).length;
  }

  /** Test-only: simulate an attacker rewriting history. */
  async rawWrite(records: T[]): Promise<void> {
    this.docs = records;
  }
}
