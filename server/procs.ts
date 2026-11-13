// Process-tree snapshot (Linux /proc; elsewhere `ps`), used to figure out what is actually
// running inside a pane (node-based CLIs all show up as "node" in tmux).
import { execFile } from 'node:child_process';
import { readdir, readFile, readlink } from 'node:fs/promises';
import { promisify } from 'node:util';

/** `fg`: the process's group holds its terminal's foreground (a shell at its prompt, or the command it runs). */
export type Proc = { pid: number; ppid: number; argv: string[]; fg?: boolean };

/**
 * The process tree (parent → children) from each process's stat, without argv: a
 * host runs hundreds of processes and ah only ever reads the argv of those inside
 * its panes, so `withArgv` fills those in. ps fills argv for all of them at once.
 */
export async function procTree(): Promise<Map<number, Proc[]>> {
  const children = new Map<number, Proc[]>();
  let entries: string[];
  try {
    entries = await readdir('/proc');
  } catch {
    return psSnapshot();
  }
  await Promise.all(
    entries.map(async (e) => {
      const pid = Number(e);
      if (!Number.isInteger(pid)) return;
      try {
        const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
        // comm may contain spaces/parens, so parse from the last ')'.
        // After comm: state ppid pgrp session tty_nr tpgid.
        const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        const ppid = Number(f[1]);
        const list = children.get(ppid) ?? [];
        list.push({ pid, ppid, argv: [], fg: Number(f[5]) > 0 && f[2] === f[5] });
        children.set(ppid, list);
      } catch {
        // process exited mid-scan
      }
    }),
  );
  return children;
}

/** Reads the argv of every process under `roots` (and of the roots), in place. */
export async function withArgv(children: Map<number, Proc[]>, roots: Iterable<number>): Promise<Map<number, Proc[]>> {
  const want: Proc[] = [];
  const rootSet = new Set(roots);
  for (const list of children.values()) for (const p of list) if (rootSet.has(p.pid)) want.push(p);
  for (const root of rootSet) want.push(...descendants(children, root));
  await Promise.all(
    want.map(async (p) => {
      if (p.argv.length) return;
      try {
        p.argv = (await readFile(`/proc/${p.pid}/cmdline`, 'utf8')).split('\0').filter(Boolean);
      } catch {
        // exited since the tree was read
      }
    }),
  );
  return children;
}

/** The whole tree with every argv (callers that don't know their roots up front). */
export async function snapshot(): Promise<Map<number, Proc[]>> {
  const tree = await procTree();
  return withArgv(tree, [0]); // pid 0 is the parent of init and kthreadd: everything
}

/**
 * Without /proc (macOS): `ps`, whose command column is the argv joined by spaces, so an
 * argument with a space in it splits in two. Matching looks at the first two words only.
 */
async function psSnapshot(): Promise<Map<number, Proc[]>> {
  const children = new Map<number, Proc[]>();
  let out: string;
  try {
    ({ stdout: out } = await promisify(execFile)('ps', ['-axww', '-o', 'pid=,ppid=,pgid=,tpgid=,command='], { maxBuffer: 16 * 1024 * 1024 }));
  } catch {
    return children;
  }
  for (const row of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(.*)$/.exec(row);
    if (!m) continue;
    const [pid, ppid, pgid, tpgid] = [m[1], m[2], m[3], m[4]].map(Number);
    const list = children.get(ppid) ?? [];
    list.push({ pid, ppid, argv: m[5].split(' ').filter(Boolean), fg: tpgid > 0 && pgid === tpgid });
    children.set(ppid, list);
  }
  return children;
}

export function descendants(children: Map<number, Proc[]>, root: number, includeRoot = false): Proc[] {
  const proc = includeRoot ? [...children.values()].flat().find((p) => p.pid === root) : undefined;
  const out: Proc[] = proc ? [proc] : [];
  const stack = [root];
  const seen = new Set([root]);
  while (stack.length) {
    const pid = stack.pop()!;
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      out.push(child);
      stack.push(child.pid);
    }
  }
  return out;
}

/** Hex address from /proc/net/tcp{,6} that a browser on this machine can reach (any, or loopback). */
function reachable(hex: string): boolean {
  return (
    /^0+$/.test(hex) || // 0.0.0.0 or ::
    hex === '0100007F' || // 127.0.0.1
    hex === '00000000000000000000000001000000' || // ::1
    hex === '0000000000000000FFFF00000100007F' // ::ffff:127.0.0.1
  );
}

/** Parses /proc/net/tcp{,6}: listening sockets by inode → port. */
export function listeningSockets(table: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of table.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10 || f[3] !== '0A') continue; // 0A = LISTEN
    const [addr, port] = f[1].split(':');
    if (!reachable(addr)) continue;
    out.set(f[9], parseInt(port, 16));
  }
  return out;
}

/**
 * TCP ports these processes listen on (Linux /proc): what a dev server started in
 * a session serves on. Sockets are matched by inode through each process's fds.
 */
export async function listeningPorts(pids: number[]): Promise<number[]> {
  const sockets = new Map<string, number>();
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    const text = await readFile(table, 'utf8').catch(() => '');
    for (const [inode, port] of listeningSockets(text)) sockets.set(inode, port);
  }
  if (!sockets.size) return [];
  const ports = new Set<number>();
  await Promise.all(
    pids.map(async (pid) => {
      const fds = await readdir(`/proc/${pid}/fd`).catch(() => [] as string[]);
      await Promise.all(
        fds.map(async (fd) => {
          const link = await readlink(`/proc/${pid}/fd/${fd}`).catch(() => '');
          const inode = /^socket:\[(\d+)\]$/.exec(link)?.[1];
          const port = inode && sockets.get(inode);
          if (port) ports.add(port);
        }),
      );
    }),
  );
  return [...ports].sort((a, b) => a - b);
}
