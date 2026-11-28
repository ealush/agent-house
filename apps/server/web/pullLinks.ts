import { useEffect, useState } from 'react';
import { reviewApi } from './reviewApi.ts';

// A link to a pull request on GitHub, in a message or a box, is a chip that opens its review
// here (POST /api/review/pulls/open), the stack it's in or a new one from its chain. Only for
// a repository this host works in (GET /api/review/repos): any other stays a link to GitHub,
// which the review's own "Open on GitHub" is for the rest.

export type PullRef = { repo: string; number: number };
export type PullLink = PullRef & { start: number; end: number; url: string };

const PULL = /https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d{1,7})(?:[/?#][^\s<>()[\]]*)?/gi;
const PULL_URL = new RegExp(`^${PULL.source}$`, 'i');

/** The pull request a URL names: github.com/<owner>/<name>/pull/<n>, any page of it. */
export function pullOf(url: string): PullRef | null {
  const m = url.match(PULL_URL);
  return m ? { repo: `${m[1]}/${m[2]}`, number: Number(m[3]) } : null;
}

/** Every link to a pull request in a text, without the punctuation that ends a sentence. */
export function findPulls(text: string): PullLink[] {
  const out: PullLink[] = [];
  for (const m of text.matchAll(PULL)) {
    const url = m[0].replace(/[.,;:!?'"]+$/, '');
    out.push({ start: m.index, end: m.index + url.length, url, repo: `${m[1]}/${m[2]}`, number: Number(m[3]) });
  }
  return out;
}

/** What a chip says for a pull request: its repository's name and number, as GitHub writes one. */
export function pullLabel(p: PullRef): string {
  return `${p.repo.slice(p.repo.indexOf('/') + 1)}#${p.number}`;
}

let repos: { at: number; names: Promise<Set<string>> } | null = null;
const REPOS_KEEP_MS = 5 * 60_000;

function reviewRepos(): Promise<Set<string>> {
  if (!repos || Date.now() - repos.at > REPOS_KEEP_MS) {
    const names = reviewApi()
      .repos()
      .then((list) => new Set(list.map((r) => r.repo.toLowerCase())))
      .catch(() => new Set<string>());
    repos = { at: Date.now(), names };
  }
  return repos.names;
}

/** Whether a pull request's repository is one this host reviews: null until it's known. */
export function useReviewRepos(on = true): Set<string> | null {
  const [names, setNames] = useState<Set<string> | null>(null);
  useEffect(() => {
    if (!on) return;
    let live = true;
    void reviewRepos().then((n) => live && setNames(n));
    return () => {
      live = false;
    };
  }, [on]);
  return names;
}

export function reviewable(names: Set<string> | null, p: PullRef | null): p is PullRef {
  return !!p && !!names?.has(p.repo.toLowerCase());
}

/**
 * Opens a pull request's review: `open` goes there (App's openReview). `from` is the session the
 * link was in. GitHub saying it isn't there (or ah failing) leaves the link to say so.
 */
export async function openPullReview(p: PullRef, open: (stack: string, pr?: number | null) => void, from?: string): Promise<void> {
  const out = await reviewApi().openPull(p.repo, p.number, from);
  if (out.created) window.dispatchEvent(new CustomEvent('ah:toast', { detail: `Started review of #${p.number}` }));
  open(out.stack.id, out.pr);
}
