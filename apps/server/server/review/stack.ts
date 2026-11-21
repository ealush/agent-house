// Stack topology, pure. A stack is a tree of PRs rooted on the trunk: each PR
// whose base branch is another PR's head sits on that PR. Real stacks branch
// (independent fixes off the base layer), so nothing here assumes a line.

export type Node = { number: number; headRefName: string; baseRefName: string };
export type Tree<T extends Node = Node> = { pr: T; children: Tree<T>[] };

/** The PR this one sits on: the one whose head branch is its base. */
export function parentOf<T extends Node>(prs: T[], pr: T): T | null {
  return prs.find((p) => p !== pr && p.headRefName === pr.baseRefName) ?? null;
}

/** Every tree in a set of open PRs; roots are PRs no other PR in the set carries. */
export function forest<T extends Node>(prs: T[]): Tree<T>[] {
  const nodes = new Map<number, Tree<T>>(prs.map((p) => [p.number, { pr: p, children: [] }]));
  const roots: Tree<T>[] = [];
  for (const p of prs) {
    const parent = parentOf(prs, p);
    // A branch named after itself, or a cycle through renamed branches, stays a root.
    if (parent && !reaches(prs, parent, p)) nodes.get(parent.number)!.children.push(nodes.get(p.number)!);
    else roots.push(nodes.get(p.number)!);
  }
  const sort = (t: Tree<T>) => {
    t.children.sort((a, b) => a.pr.number - b.pr.number);
    t.children.forEach(sort);
  };
  roots.forEach(sort);
  return roots.sort((a, b) => b.pr.number - a.pr.number);
}

/** Whether walking up from `from` reaches `to` (cycle guard). */
function reaches<T extends Node>(prs: T[], from: T, to: T): boolean {
  const seen = new Set<number>();
  for (let cur: T | null = from; cur && !seen.has(cur.number); cur = parentOf(prs, cur)) {
    if (cur === to) return true;
    seen.add(cur.number);
  }
  return false;
}

export function size(t: Tree): number {
  return 1 + t.children.reduce((n, c) => n + size(c), 0);
}

/** A PR and everything stacked on it, as a tree; null when it isn't in the set. */
export function subtree<T extends Node>(prs: T[], root: number): Tree<T> | null {
  const find = (ts: Tree<T>[]): Tree<T> | null => {
    for (const t of ts) {
      if (t.pr.number === root) return t;
      const hit = find(t.children);
      if (hit) return hit;
    }
    return null;
  };
  return find(forest(prs));
}

/**
 * A first merge order: parents before children, and at each fork the smaller
 * branches first — independent fixes off the base layer land before the long
 * feature chain that would otherwise block them. Ties go by PR number.
 */
export function defaultOrder(t: Tree): number[] {
  const out: number[] = [];
  const walk = (n: Tree) => {
    out.push(n.pr.number);
    [...n.children].sort((a, b) => size(a) - size(b) || a.pr.number - b.pr.number).forEach(walk);
  };
  walk(t);
  return out;
}

/** Layers above `pr` (children, their children…), in `order`. */
export function descendants<T extends Node>(layers: T[], pr: number, order: number[]): number[] {
  const self = layers.find((l) => l.number === pr);
  if (!self) return [];
  const out = new Set<number>();
  const visit = (l: T) => {
    for (const c of layers) {
      if (c !== l && c.baseRefName === l.headRefName && !out.has(c.number)) {
        out.add(c.number);
        visit(c);
      }
    }
  };
  visit(self);
  return order.filter((n) => out.has(n));
}

/** An order is valid when it names each layer once and every layer comes after the one it sits on. */
export function validOrder<T extends Node>(layers: T[], order: number[]): boolean {
  if (order.length !== layers.length || new Set(order).size !== order.length) return false;
  const at = new Map(order.map((n, i) => [n, i]));
  for (const l of layers) {
    if (!at.has(l.number)) return false;
    const parent = parentOf(layers, l);
    if (parent && at.get(parent.number)! > at.get(l.number)!) return false;
  }
  return true;
}

/**
 * Role labels from a plan's owner table: any markdown table row with a
 * `#123` cell gives that PR the row's first other short cell ("H0", "F2").
 * Only labels — what the plan's prose says about merging stays for you to read.
 */
export function planRoles(markdown: string): Map<number, string> {
  const roles = new Map<number, string>();
  for (const line of markdown.split('\n')) {
    if (!/^\s*\|/.test(line)) continue;
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    const prCell = cells.findIndex((c) => /(^|[\s[(])#\d+\b/.test(c));
    if (prCell < 0) continue;
    const n = Number(cells[prCell].match(/#(\d+)/)![1]);
    const label = cells.find((c, i) => i !== prCell && c && c.length <= 16 && !/#\d+|^-+$/.test(c));
    if (label && !roles.has(n)) roles.set(n, label.replace(/[*_`]/g, ''));
  }
  return roles;
}
