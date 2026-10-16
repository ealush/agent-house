// Web Push (F25): the daemon notices status changes on its own ticker and pings
// subscribed devices, so a phone hears "needs you" even with ah closed. Each
// device opts in per event. Requires HTTPS (pnpm serve) and, on iOS, the
// home-screen app.
import webpush from 'web-push';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import type { WindowView } from './sessions.ts';

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
  private primed = false;

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
    webpush.setVapidDetails(`mailto:ah@${hostname()}.local`, this.keys.publicKey, this.keys.privateKey);
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
    for (const w of windows) {
      const prev = this.last.get(w.uid);
      this.last.set(w.uid, w.status);
      // The first pass only learns current state; restarting ah must not replay alerts.
      if (!this.primed || prev === w.status) continue;
      const event = w.status === 'waiting' ? 'waiting' : w.status === 'attention' && prev === 'busy' ? 'done' : null;
      if (!event || now - (this.lastSent.get(w.uid) ?? 0) < COOLDOWN_S) continue;
      this.lastSent.set(w.uid, now);
      this.send(event, {
        // A turn that ended on the plan's usage limit didn't finish: say so, and when it resets.
        title: event === 'waiting' ? `${w.name} needs you` : w.limit ? `${w.name} hit its usage limit` : `${w.name} finished`,
        body: `${w.project} · ${w.limit ?? (w.agent ? name(w.agent) : 'Shell')}`,
        tag: w.uid,
        url: `/#${w.uid}`,
        badge: waiting,
      });
    }
    this.primed = true;
  }

  /** A needs-you alert that isn't a session's status (stack review): goes where "needs you" goes. */
  alert(payload: { title: string; body: string; tag: string; url: string }) {
    this.send('waiting', payload);
  }

  private send(event: keyof PushEvents, payload: Record<string, string>) {
    for (const [endpoint, d] of this.devices) {
      if (!d.events[event]) continue;
      webpush.sendNotification(d.subscription, JSON.stringify(payload), { TTL: 600, urgency: event === 'waiting' ? 'high' : 'normal' }).catch((err) => {
        // Gone/expired subscriptions are dropped; anything else is logged and kept.
        if (err?.statusCode === 404 || err?.statusCode === 410) this.unsubscribe(endpoint);
        else console.error(`push to ${d.label || 'device'} failed:`, err?.statusCode ?? err);
      });
    }
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
