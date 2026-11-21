// Recently sent prompts, newest first, shared by every device (resend from
// history). The table is the source of truth; memory mirrors it for sync reads.
import type { PrismaClient } from '@prisma/client';
import { defaultDbPath, getDb } from './db.ts';

export type Prompt = { text: string; at: number };

export class PromptStore {
  private db: PrismaClient | null = null;
  private dbPath: string;

  /** Side-effect free: the database is touched on first use, not here. */
  constructor(dbPath = defaultDbPath()) {
    this.dbPath = dbPath;
  }

  private client(): PrismaClient {
    return (this.db ??= getDb(this.dbPath));
  }

  async load(): Promise<Prompt[]> {
    try {
      return (await this.client().prompt.findMany({ orderBy: { id: 'desc' } })).map((p) => ({ text: p.text, at: p.at }));
    } catch (err) {
      console.error('prompts load failed:', err);
      return [];
    }
  }

  async save(prompts: Prompt[]): Promise<void> {
    try {
      await this.client().$transaction([this.client().prompt.deleteMany(), this.client().prompt.createMany({ data: prompts.map((p) => ({ text: p.text, at: p.at })) })]);
    } catch (err) {
      console.error('prompts save failed:', err);
    }
  }

  async clear(): Promise<void> {
    try {
      await this.client().prompt.deleteMany();
    } catch (err) {
      console.error('prompts clear failed:', err);
    }
  }
}
