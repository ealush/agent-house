// The whole HTTP API, as one ordered table per bounded context. The composition root
// (main.ts) hands in the services; each context's table takes only its own deps (the
// intersection below is just their union). Order matters only where patterns overlap,
// and within a context: the first match answers.
import { authRoutes, type AuthRouteDeps } from './auth.ts';
import { chatRoutes, type ChatRouteDeps } from './chat.ts';
import { continuityRoutes, type ContinuityRouteDeps } from './continuity.ts';
import { envRoutes, type EnvRouteDeps } from './env.ts';
import { feedRoutes, type FeedRouteDeps } from './feed.ts';
import { filesRoutes, type FilesRouteDeps } from './files.ts';
import { gitRoutes, type GitRouteDeps } from './git.ts';
import { inputRoutes, type InputRouteDeps } from './input.ts';
import { lifecycleRoutes, type LifecycleRouteDeps } from './lifecycle.ts';
import { previewsRoutes, type PreviewsRouteDeps } from './previews.ts';
import { pushRoutes, type PushRouteDeps } from './push.ts';
import { queueRoutes, type QueueRouteDeps } from './queue.ts';
import { searchRoutes, type SearchRouteDeps } from './search.ts';
import { snapshotsRoutes, type SnapshotsRouteDeps } from './snapshots.ts';
import { stateRoutes, type StateRouteDeps } from './state.ts';
import { systemRoutes, type SystemRouteDeps } from './system.ts';
import { terminalsRoutes, type TerminalsRouteDeps } from './terminals.ts';
import { usageRoutes, type UsageRouteDeps } from './usage.ts';
import { voiceRoutes, type VoiceRouteDeps } from './voice.ts';
import { windowsRoutes, type WindowsRouteDeps } from './windows.ts';
import type { Route } from './router.ts';

export type ApiDeps = AuthRouteDeps &
  ChatRouteDeps &
  ContinuityRouteDeps &
  EnvRouteDeps &
  FeedRouteDeps &
  FilesRouteDeps &
  GitRouteDeps &
  InputRouteDeps &
  LifecycleRouteDeps &
  PreviewsRouteDeps &
  PushRouteDeps &
  QueueRouteDeps &
  SearchRouteDeps &
  SnapshotsRouteDeps &
  StateRouteDeps &
  SystemRouteDeps &
  TerminalsRouteDeps &
  UsageRouteDeps &
  VoiceRouteDeps &
  WindowsRouteDeps;

export function apiRoutes(d: ApiDeps): { auth: Route[]; routes: Route[] } {
  return {
    /** /api/auth/*: the only table with public routes (sign-in itself). */
    auth: authRoutes(d),
    routes: [
    ...stateRoutes(d),
    ...lifecycleRoutes(d),
    ...inputRoutes(d),
    ...queueRoutes(d),
    ...feedRoutes(d),
    ...snapshotsRoutes(d),
    ...terminalsRoutes(d),
    ...previewsRoutes(d),
    ...continuityRoutes(d),
    ...usageRoutes(d),
    ...gitRoutes(d),
    ...windowsRoutes(d),
    ...chatRoutes(d),
    ...voiceRoutes(d),
    ...searchRoutes(d),
    ...filesRoutes(d),
    ...pushRoutes(d),
    ...envRoutes(d),
    ...systemRoutes(d),
    ],
  };
}
