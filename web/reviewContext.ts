import { createContext, useContext } from 'react';
import type { ReviewState } from './api.ts';

/** Stack review on this host, for sessions: which layer a branch is, and what a session is fixing. */
export const ReviewContext = createContext<{ host: string; state: ReviewState | null; open: (stack: string, pr?: number | null) => void } | null>(null);

export function useReviewFor(host: string, uid: string, branch: string | null, project?: string | null) {
  const ctx = useContext(ReviewContext);
  // Review lives on the host you opened; a peer's sessions aren't its layers.
  if (!ctx?.state || host !== ctx.host) return null;
  const link = ctx.state.sessions?.find((s) => s.uid === uid) ?? null;
  const layer = branch
    ? (ctx.state.branches.find((b) => b.branch === branch && (!project || b.repo.endsWith(`/${project}`) || b.repo === project)) ?? null)
    : null;
  const fixing = ctx.state.fixing.find((f) => f.uid === uid) ?? null;
  return { link, layer, fixing, open: ctx.open };
}
