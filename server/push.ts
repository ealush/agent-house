// Web Push (F25): the daemon notices status changes on its own ticker and pings
// subscribed devices, so a phone hears "needs you" even with ah closed. Each
// device opts in per event. Requires HTTPS (pnpm serve) and, on iOS, the
// home-screen app.
import type { GateKind } from './agentgate.ts';
import webpush from 'web-push';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { hostName } from './host.ts';
import { dirname, join } from 'node:path';
import type { WindowView } from './sessions.ts';
import { lastSaid, type Apns } from './apns.ts';

export type PushEvents = { waiting: boolean; done: boolean };
type Subscription = { endpoint: string; keys: { p256dh: string; auth: string } };
type Device = { subscription: Subscription; events: PushEvents; label: string; at: number };

const DIR = join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'ah');
const KEYS_FILE = join(DIR, 'vapid.json');
const SUBS_FILE = join(DIR, 'push.json');
/** Don't re-notify the same session more often than this. */
const COOLDOWN_S = 30;

export class Push {
  private keys: { publicKey: string; privateKey: string };
  private devices = new Map<string, Device>();
  private last = new Map<string, string>(); // uid → last status seen
  private lastSent = new Map<string, number>();
  /** Sessions whose "needs you" alert went out and is still standing: resolved when they move on. */
  private alerted = new Set<string>();
  private primed = false;
  /** Native app delivery (server/apns.ts), beside Web Push; main.ts wires it. */
  apns: Apns | null = null;

  constructor() {
    if (existsSync(KEYS_FILE)) {
      this.keys = JSON.parse(readFileSync(KEYS_FILE, 'utf8'));
    } else {
      this.keys = webpush.generateVAPIDKeys();
      this.save(KEYS_FILE, this.keys);
    }
    try {
      if (existsSync(SUBS_FILE)) for (const d of JSON.parse(readFileSync(SUBS_FILE, 'utf8')) as Device[]) this.devices.set(d.subscription.endpoint, d);
    } catch {}
    webpush.setVapidDetails(`mailto:ah@${hostName()}.local`, this.keys.publicKey, this.keys.privateKey);
  }

  get publicKey() {
    return this.keys.publicKey;
  }

  subscribe(subscription: Subscription, events: PushEvents, label: string) {
    if (!subscription?.endpoint?.startsWith('https://') || !subscription.keys?.p256dh || !subscription.keys?.auth) {
      throw new Error('invalid push subscription');
    }
    this.devices.set(subscription.endpoint, { subscription, events, label: label.slice(0, 80), at: Date.now() });
    this.persist();
  }

  unsubscribe(endpoint: string) {
    if (this.devices.delete(endpoint)) this.persist();
  }

  settings(endpoint: string): PushEvents | null {
    return this.devices.get(endpoint)?.events ?? null;
  }

  /** Called every tick: notify on transitions into needs-you / done. */
  /** `name`: an agent's display name ("Claude Code"), from its preset. */
  observe(windows: WindowView[], name: (agent: string) => string = (a) => a) {
    const now = Date.now() / 1000;
    // The app icon's badge (sw.js): how many sessions need you as of this alert.
    const waiting = String(windows.filter((w) => w.status === 'waiting').length);
    const present = new Set<string>();
    for (const w of windows) {
      present.add(w.uid);
      const prev = this.last.get(w.uid);
      this.last.set(w.uid, w.status);
      // The first pass only learns current state; restarting ah must not replay alerts.
      if (!this.primed || prev === w.status) continue;
      // It alerted "needs you" and has moved on: devices take that alert down.
      if (prev === 'waiting' && this.alerted.delete(w.uid)) void this.apns?.resolved({ route: w.uid, host: hostName(), tag: w.uid, waiting: Number(waiting) });
      const event = w.status === 'waiting' ? 'waiting' : w.status === 'attention' && prev === 'busy' ? 'done' : null;
      if (!event || now - (this.lastSent.get(w.uid) ?? 0) < COOLDOWN_S) continue;
      this.lastSent.set(w.uid, now);
      // The session's title, as every screen names it ("Fix Safari login flash"), not its tmux window ("claude").
      const title = w.title || w.name;
      if (event === 'waiting') this.alerted.add(w.uid);
      this.send(event, {
        // A turn that ended on the plan's usage limit didn't finish: say so, and when it resets.
        title: event === 'waiting' ? `${title} needs you` : w.limit ? `${title} hit its usage limit` : `${title} finished`,
        // Needing you: what for ("Wants to run pnpm test"), so the lock screen is enough to decide.
        // Otherwise what it said last (its answer, when it's done), as a chat's notification
        // shows the message; the agent's name only where there's no transcript to read.
        body: `${w.project} · ${(event === 'waiting' && askLine(w.ask)) || w.limit || lastSaid(w.reply, 240) || (w.agent ? name(w.agent) : 'Shell')}`,
        tag: w.uid,
        url: `/#${w.uid}`,
        badge: waiting,
      }, w.answerable, w.askId);
    }
    // A session that alerted and is gone (ended, killed) is resolved too.
    for (const uid of [...this.alerted]) {
      if (present.has(uid)) continue;
      this.alerted.delete(uid);
      this.last.delete(uid);
      void this.apns?.resolved({ route: uid, host: hostName(), tag: uid, waiting: Number(waiting) });
    }
    this.primed = true;
    // Native badges also follow changes that alert nobody (answered on another device).
    this.apns?.badge(Number(waiting));
    // Live Activities follow every tick, not only alerting transitions: what it's doing changes too.
    this.apns?.follow(windows, askLine);
  }

  /** A needs-you alert that isn't a session's status (stack review): goes where "needs you" goes. */
  alert(payload: { title: string; body: string; tag: string; url: string }) {
    this.send('waiting', payload);
  }

  /** `answerable`: one-tap Approve/Deny is safe for this alert (native notification actions). */
  private send(event: keyof PushEvents, payload: Record<string, string>, answerable = false, prompt: string | null = null) {
    if (this.apns) {
      void this.apns.send(event, {
        title: payload.title,
        body: payload.body,
        tag: payload.tag,
        route: payload.url.replace(/^\/#/, ''),
        host: hostName(),
        badge: Number(payload.badge ?? this.lastWaiting()),
        answerable,
        prompt,
      });
    }
    for (const [endpoint, d] of this.devices) {
      if (!d.events[event]) continue;
      webpush.sendNotification(d.subscription, JSON.stringify(payload), { TTL: 600, urgency: event === 'waiting' ? 'high' : 'normal' }).catch((err) => {
        // Gone/expired subscriptions are dropped; anything else is logged and kept.
        if (err?.statusCode === 404 || err?.statusCode === 410) this.unsubscribe(endpoint);
        else console.error(`push to ${d.label || 'device'} failed:`, err?.statusCode ?? err);
      });
    }
  }

  private lastWaiting(): number {
    return [...this.last.values()].filter((s) => s === 'waiting').length;
  }

  private persist() {
    this.save(SUBS_FILE, [...this.devices.values()]);
  }

  private save(file: string, data: unknown) {
    mkdir(dirname(file), { recursive: true, mode: 0o700 })
      .then(() => writeFile(file, JSON.stringify(data, null, 2), { mode: 0o600 }))
      .catch((err) => console.error(`writing ${file} failed:`, err));
  }
}

/** A screen in front of the agent's prompt, in the words the apps use. */
const GATE_LINE: Record<GateKind, string> = { trust: 'Asks to trust this folder', signin: 'Needs you to sign in', setup: 'Needs setting up' };

/** One line for what a waiting session asks: the command, the question, or the tool. */
export function askLine(ask: WindowView['ask']): string {
  if (!ask) return '';
  if (ask.gate) return GATE_LINE[ask.gate.kind];
  const first = (t: string) => t.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const short = (t: string) => (t.length > 120 ? t.slice(0, 119) + '…' : t);
  if (ask.kind === 'command') {
    // Screen-read asks carry the whole prompt; the command is its first line after the "Bash command" header.
    const lines = ask.text.split('\n').map((l) => l.trim()).filter(Boolean);
    const cmd = lines[0] === 'Bash command' ? lines[1] : lines[0];
    return cmd ? short(`Wants to run ${cmd}`) : 'Wants to run a command';
  }
  if (ask.kind === 'choice' || ask.kind === 'question') return short(`Asks: ${first(ask.text)}`);
  if (ask.kind === 'tool') return short(first(ask.text));
  return 'Wants your answer';
}
