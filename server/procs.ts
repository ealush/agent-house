// Linux process-tree snapshot from /proc, used to figure out what is actually
// running inside a pane (node-based CLIs all show up as "node" in tmux).
import { readdir, readFile } from 'node:fs/promises';

export type Proc = { pid: number; ppid: number; argv: string[] };

export async function snapshot(): Promise<Map<number, Proc[]>> {
  const children = new Map<number, Proc[]>();
  let entries: string[];
  try {
    entries = await readdir('/proc');
  } catch {
    return children;
  }
  await Promise.all(
    entries.map(async (e) => {
      const pid = Number(e);
      if (!Number.isInteger(pid)) return;
      try {
        const [stat, cmdline] = await Promise.all([
          readFile(`/proc/${pid}/stat`, 'utf8'),
          readFile(`/proc/${pid}/cmdline`, 'utf8'),
        ]);
        // comm may contain spaces/parens, so parse from the last ')'.
        const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
        const argv = cmdline.split('\0').filter(Boolean);
        const list = children.get(ppid) ?? [];
        list.push({ pid, ppid, argv });
        children.set(ppid, list);
      } catch {
        // process exited mid-scan
      }
    }),
  );
  return children;
}

export function descendants(children: Map<number, Proc[]>, root: number): Proc[] {
  const out: Proc[] = [];
  const stack = [root];
  while (stack.length) {
    const pid = stack.pop()!;
    for (const child of children.get(pid) ?? []) {
      out.push(child);
      stack.push(child.pid);
    }
  }
  return out;
}
