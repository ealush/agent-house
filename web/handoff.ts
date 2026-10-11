import type { HostApi, Win } from './api.ts';
import { look } from './agents.ts';
import { readHandoff } from './gui/reducer.ts';

/**
 * The first message for another agent picking up this conversation: where it
 * was, what was said (the transcript's prose, newest last, within a budget),
 * and how to carry on. Built from the transcript alone, no model involved.
 */
export async function continuePrompt(client: HostApi, w: Win): Promise<string> {
  const { transcript, latest } = await readHandoff((before, limit) => client.feedPage(w.uid, before, limit));
  const from = look(w.agent).name;
  const body = transcript.trim() || latest.trim();
  return [
    `You are picking up a conversation that was running in ${from}, in this same directory (${w.cwd}${w.branch ? `, branch ${w.branch}` : ''}).`,
    'Below is what was said so far, most recent last. Check the current state of the files before acting, do not redo finished work, and continue from where it left off.',
    '',
    '<previous-conversation>',
    body || '(The earlier conversation had no readable messages.)',
    '</previous-conversation>',
  ].join('\n');
}
