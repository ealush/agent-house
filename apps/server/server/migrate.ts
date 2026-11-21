import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { migrate as migrateRecord } from './registry.ts';

/** Legacy JSON state paths (pre-Prisma), under the XDG state dir. */
export function legacyDir(stateDir?: string): string {
  if (stateDir) return stateDir;
  const base = process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state');
  return join(base, 'ah');
}

function readJson(file: string): unknown | null {
  try {
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * One-pass import of pre-Prisma JSON state into SQLite. Idempotent:
 * skips rows/settings already present (by id/key/uid+at).
 */
export async function importLegacyJson(db: PrismaClient, dir = legacyDir()): Promise<{ sessions: number; prompts: number; subscriptions: number; chatMessages: number; settings: number }> {
  const counts = { sessions: 0, prompts: 0, subscriptions: 0, chatMessages: 0, settings: 0 };

  // Legacy file held SessionRecord[] (v2, or v1 normalized by migrate()).
  const sessions = readJson(join(dir, 'sessions.json'));
  if (Array.isArray(sessions)) {
    for (const s of sessions) {
      if (!s || typeof s !== 'object') continue;
      let rec: ReturnType<typeof migrateRecord>;
      try {
        rec = migrateRecord(s as Record<string, any>);
      } catch {
        continue;
      }
      if (!rec.id) continue;
      const exists = await db.session.findUnique({ where: { uid: rec.id }, select: { uid: true } });
      if (exists) continue;
      await db.session.create({
        data: {
          uid: rec.id,
          host: rec.host ?? '',
          title: rec.title ?? '',
          harness: rec.harness ?? '',
          harnessId: rec.harnessId ?? null,
          cwd: rec.cwd ?? '',
          model: rec.model ?? null,
          status: rec.status ?? 'idle',
          lifecycle: rec.lifecycle ?? 'live',
          pendingResume: rec.pendingResume === true,
          createdAt: rec.createdAt ?? 0,
          lastActivityAt: rec.lastActivityAt ?? 0,
          endedAt: rec.endedAt ?? null,
          exitCode: rec.exitCode ?? null,
          tmuxJson: rec.tmux ? JSON.stringify(rec.tmux) : null,
          metaJson: rec.meta ? JSON.stringify(rec.meta) : '{}',
        },
      });
      counts.sessions++;
    }
  }

  // Legacy file held a flat global array [{text, at}], newest first. Insert
  // oldest-first so higher ids stay newer, matching `ORDER BY id DESC` reads.
  const prompts = readJson(join(dir, 'prompts.json'));
  if (Array.isArray(prompts)) {
    const existing = await db.prompt.count();
    for (const p of [...prompts].reverse().slice(existing)) {
      if (!p || typeof (p as { text?: unknown }).text !== 'string') continue;
      const pp = p as { text: string; at?: unknown };
      await db.prompt.create({
        data: { text: pp.text, at: typeof pp.at === 'number' ? pp.at : Math.floor(Date.now() / 1000) },
      });
      counts.prompts++;
    }
  }

  const sidechat = readJson(join(dir, 'sidechat.json'));
  if (sidechat && typeof sidechat === 'object') {
    const sc = sidechat as { subscriptions?: unknown; defaultId?: unknown; chats?: unknown };
    if (Array.isArray(sc.subscriptions)) {
      for (const s of sc.subscriptions) {
        if (!s || typeof (s as { id?: unknown }).id !== 'string') continue;
        const sub = s as { id: string; name?: unknown; baseUrl?: unknown; model?: unknown; apiKey?: unknown };
        const exists = await db.subscription.findUnique({ where: { id: sub.id }, select: { id: true } });
        if (exists) continue;
        await db.subscription.create({
          data: {
            id: sub.id,
            name: typeof sub.name === 'string' ? sub.name : 'imported',
            baseUrl: typeof sub.baseUrl === 'string' ? sub.baseUrl : '',
            model: typeof sub.model === 'string' ? sub.model : '',
            apiKey: typeof sub.apiKey === 'string' ? sub.apiKey : '',
          },
        });
        counts.subscriptions++;
      }
    }
    if (typeof sc.defaultId === 'string') {
      const has = await db.subscription.findUnique({ where: { id: sc.defaultId }, select: { id: true } });
      const cur = await db.setting.findUnique({ where: { key: 'sidechat.defaultId' } });
      if (has && cur?.value !== sc.defaultId) {
        await db.setting.upsert({
          where: { key: 'sidechat.defaultId' },
          create: { key: 'sidechat.defaultId', value: sc.defaultId },
          update: { value: sc.defaultId },
        });
        counts.settings++;
      }
    }
    if (sc.chats && typeof sc.chats === 'object') {
      for (const [uid, msgs] of Object.entries(sc.chats as Record<string, unknown>)) {
        if (!Array.isArray(msgs)) continue;
        for (const m of msgs) {
          if (!m || typeof (m as { role?: unknown }).role !== 'string' || typeof (m as { text?: unknown }).text !== 'string') continue;
          const mm = m as { role: string; text: string; at?: unknown };
          const dup = await db.chatMessage.findFirst({ where: { uid, role: mm.role, text: mm.text, at: typeof mm.at === 'number' ? mm.at : -1 }, select: { id: true } });
          if (dup) continue;
          await db.chatMessage.create({
            data: { uid, role: mm.role, text: mm.text, at: typeof mm.at === 'number' ? mm.at : Math.floor(Date.now() / 1000) },
          });
          counts.chatMessages++;
        }
      }
    }
  }

  return counts;
}
