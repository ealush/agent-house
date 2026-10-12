import type { HostApi, SendResult, Win } from './api.ts';
import { askConfirm, showError } from './ask.tsx';
import { effectiveModel, effortsFor, usePreset } from './ModelPicker.tsx';
import { runningModel, shortModel } from './agents.ts';
import type { PaletteNode } from './palette.ts';
import { usePaletteProvider } from './shortcuts.tsx';

// A session's model, effort and mode, and how to change them: live where the
// agent has a command for it, else a relaunch of the same conversation, else
// the agent's own picker in its terminal. Shared by the GUI composer's chips
// and, in either view, the palette's Model and effort branch.

type Opts = {
  client: HostApi;
  w: Win | undefined;
  agent: string | null;
  onNotice: (msg: string) => void;
  onSent?: (r: SendResult) => void;
  /** The agent's own picker was typed in: show its terminal. */
  onSettingsOpen?: () => void;
  /** A relaunch finished: open the replacement window id on this host. */
  onRelaunched?: (uid: string) => void;
};

export function useLaunch({ client, w, agent, onNotice, onSent, onSettingsOpen, onRelaunched }: Opts) {
  const preset = usePreset(w?.host ?? '', agent);
  const models = preset?.models ?? [];
  // What the agent reports it runs beats what it was launched with: a /model in its
  // terminal, or a session ah didn't start, would otherwise show the default.
  const live = runningModel(models, w?.model);
  const model = preset ? (live ?? (w?.model ? undefined : effectiveModel(preset, w?.launchModel))) : undefined;
  const modelLabel = model?.name ?? shortModel(w?.model) ?? null;
  const effort = w?.launchEffort ?? (w?.launchModel ? undefined : preset?.defaultEffort);
  const mode = preset?.modes?.find((m) => m.id === (w?.launchMode ?? 'default'));
  const levels = preset ? effortsFor(preset, model) : [];
  const working = !!w && w.status === 'busy';

  async function openSettings(setting: 'model' | 'effort' | 'mode', close: () => void = () => {}) {
    close();
    if (!w) return;
    try {
      const r = await client.openSettings(w.uid, setting);
      if (r.outcome === 'delivered') {
        onSent?.(r);
        onSettingsOpen?.();
      }
      onNotice(r.outcome === 'queued' ? 'Settings will open in the terminal when the agent is free' : 'Choose the setting in the terminal');
    } catch (e) {
      showError(e, "Couldn't open settings");
    }
  }

  async function pickLive(change: { model?: string; effort?: string }, close: () => void = () => {}) {
    if (!w) return;
    const switching = change.model && change.model !== model?.id ? { model: change.model } : change.effort && change.effort !== effort ? { effort: change.effort } : null;
    close();
    if (!switching) return;
    try {
      const r = await client.switchLaunch(w.uid, switching);
      const what = switching.model ? (models.find((m) => m.id === switching.model)?.name ?? switching.model) : `${switching.effort} effort`;
      onNotice(r.outcome === 'queued' ? `Switching to ${what} when the agent is free` : `Requested ${what}; check the terminal for confirmation`);
    } catch (e) {
      showError(e, "Couldn't switch");
    }
  }

  /** Hot swap for agents with no live-switch command: restart this idle
   *  session with the new setting, keeping the same conversation. */
  async function relaunchWith(change: { model?: string; effort?: string }, close: () => void = () => {}) {
    if (!w) return;
    const same = change.model ? change.model === model?.id : change.effort === effort;
    close();
    if (same) return;
    // Mirror the server's idle check (busy, waiting, queued) so the confirm
    // dialog doesn't open for a relaunch the server would reject.
    if (working || w.status === 'waiting' || w.queued > 0) {
      onNotice('Wait until the session is idle to relaunch');
      return;
    }
    const what = change.model ? (models.find((m) => m.id === change.model)?.name ?? change.model) : `${change.effort} effort`;
    const ok = await askConfirm({
      title: `Relaunch with ${what}?`,
      body: 'The session restarts with the new setting; the conversation, queue and snapshots carry over.',
      confirm: 'Relaunch',
    });
    if (!ok) return;
    try {
      const r = await client.relaunch(w.uid, change);
      onNotice(`Relaunched with ${what}`);
      onRelaunched?.(r.uid);
    } catch (e) {
      showError(e, "Couldn't relaunch");
    }
  }

  /** Apply a choice the best way this agent allows. */
  const choose = (change: { model?: string; effort?: string }) =>
    change.model !== undefined ? (preset?.switchModel ? pickLive(change) : relaunchWith(change)) : preset?.switchEffort ? pickLive(change) : relaunchWith(change);

  return { preset, models, model, modelLabel, effort, mode, levels, working, openSettings, pickLive, relaunchWith, choose };
}

export type Launch = ReturnType<typeof useLaunch>;

/** Palette → Session → Model and effort: every choice as a row, while `enabled`. */
export function useLaunchPalette(l: Launch, enabled: boolean) {
  const { preset, models, model, modelLabel, effort, levels } = l;
  usePaletteProvider(
    'models',
    (): PaletteNode[] =>
      preset && models.length && (preset.switchModel || preset.modelArgs)
        ? [
            {
              key: 'models',
              label: 'Model',
              icon: 'model',
              detail: `Now ${modelLabel ?? 'default'}`,
              children: models.map((m) => ({
                key: m.id,
                label: m.name,
                icon: 'model',
                detail: [m.id === model?.id ? 'current' : '', m.description ?? ''].filter(Boolean).join(' · '),
                run: () => void l.choose({ model: m.id }),
              })),
            },
          ]
        : [],
    enabled,
  );
  usePaletteProvider(
    'efforts',
    (): PaletteNode[] =>
      preset && levels.length && (preset.switchEffort || preset.effort)
        ? [
            {
              key: 'efforts',
              label: 'Reasoning effort',
              icon: 'effort',
              detail: `Now ${effort ?? 'default'}`,
              children: levels.map((level) => ({
                key: level,
                label: level,
                icon: 'effort',
                detail: level === effort ? 'current' : '',
                run: () => void l.choose({ effort: level }),
              })),
            },
          ]
        : [],
    enabled,
  );
}
