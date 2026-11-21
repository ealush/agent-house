import type { HostApi, SendResult, Win } from './api.ts';
import { askConfirm, showError } from './ask.tsx';
import { effectiveModel, effortsFor, usePreset } from './ModelPicker.tsx';
import { runningModel, shortModel } from './agents.ts';
import type { PaletteNode } from './palette.ts';
import { usePaletteProvider } from './shortcuts.tsx';

// A session's model, effort and mode, and how to change them: live where the
// agent has a command for it, else a relaunch of the same conversation, else
// the agent's own picker in its terminal. Shared by the GUI composer's chips
// and, in either view, the palette's Model, effort and Permissions branches.

type Change = { model?: string; effort?: string; mode?: string };

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

  /** A choice in words, for notices and confirms. */
  function describe(change: Change): string {
    if (change.model === 'default') return 'the default model';
    if (change.model) return models.find((m) => m.id === change.model)?.name ?? change.model;
    if (change.mode) return `${preset?.modes?.find((m) => m.id === change.mode)?.name ?? change.mode} mode`;
    return change.effort === 'default' ? 'default effort' : `${change.effort} effort`;
  }

  async function pickLive(change: { model?: string; effort?: string }, close: () => void = () => {}) {
    if (!w) return;
    const switching = change.model && change.model !== model?.id ? { model: change.model } : change.effort && change.effort !== (effort ?? 'default') ? { effort: change.effort } : null;
    close();
    if (!switching) return;
    try {
      const r = await client.switchLaunch(w.uid, switching);
      const what = describe(switching);
      onNotice(r.outcome === 'queued' ? `Switching to ${what} when the agent is free` : `Switched to ${what}`);
    } catch (e) {
      showError(e, "Couldn't switch");
    }
  }

  /** Hot swap for agents with no live-switch command: restart this idle
   *  session with the new setting, keeping the same conversation. */
  async function relaunchWith(change: Change, close: () => void = () => {}, confirmed = false) {
    if (!w) return;
    const same = change.model ? change.model === model?.id : change.mode ? change.mode === mode?.id : change.effort === (effort ?? 'default');
    close();
    if (same) return;
    // Mirror the server's idle check (busy, waiting, queued) so the confirm
    // dialog doesn't open for a relaunch the server would reject.
    if (working || w.status === 'waiting' || w.queued > 0) {
      onNotice('Wait until the session is idle to relaunch');
      return;
    }
    const what = describe(change);
    const danger = !!change.mode && !!preset?.modes?.find((m) => m.id === change.mode)?.dangerous;
    const ok = confirmed || await askConfirm({
      title: `Relaunch with ${what}?`,
      body: `${danger ? 'It will run any command and edit any file without asking. ' : ''}The session restarts with the new setting; the conversation, queue and snapshots carry over.`,
      confirm: 'Relaunch',
      danger,
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

  /**
   * Apply a model or effort choice the best way this agent allows. "default" is the
   * agent's own default: its reset command live, a relaunch without the flag, or the
   * default it reports by name; its terminal picker only when none of those exist.
   */
  function choose(change: { model?: string; effort?: string }, close: () => void = () => {}) {
    const isModel = change.model !== undefined;
    const live = isModel ? preset?.switchModel : preset?.switchEffort;
    if ((isModel ? change.model : change.effort) === 'default' && live && !(isModel ? preset?.resetModel : preset?.resetEffort)) {
      const named = isModel ? preset?.defaultModel : preset?.defaultEffort;
      if (!named) return openSettings(isModel ? 'model' : 'effort', close);
      change = isModel ? { model: named } : { effort: named };
    }
    return live ? pickLive(change, close) : relaunchWith(change, close);
  }

  /**
   * Permission mode: live where the agent cycles modes (Claude's Shift+Tab), else,
   * or for a mode outside this session's cycle, a relaunch of the conversation in it.
   */
  async function chooseMode(id: string, close: () => void = () => {}) {
    close();
    const target = preset?.modes?.find((m) => m.id === id);
    if (!w || !target || id === mode?.id) return;
    if (!preset?.modeCycle) return relaunchWith({ mode: id });
    // One confirm covers both ways there: the switch, or the restart it may take.
    const confirmed = !!target.dangerous;
    if (confirmed && !(await askConfirm({ title: `Switch to ${target.name}?`, body: `${preset.name} will run any command and edit any file without asking. If this session can't switch to it live, it restarts in it; the conversation carries over.`, confirm: 'Switch', danger: true }))) return;
    try {
      if ((await client.switchMode(w.uid, id)).switched) return onNotice(`Switched to ${describe({ mode: id })}`);
    } catch (e) {
      return showError(e, "Couldn't change permissions");
    }
    return relaunchWith({ mode: id }, undefined, confirmed);
  }

  return { preset, models, model, modelLabel, effort, mode, levels, working, openSettings, pickLive, relaunchWith, choose, chooseMode };
}

export type Launch = ReturnType<typeof useLaunch>;

/** Palette → Session → Model and effort: every choice as a row, while `enabled`. */
export function useLaunchPalette(l: Launch, enabled: boolean) {
  const { preset, models, model, modelLabel, effort, mode, levels } = l;
  usePaletteProvider(
    'modes',
    (): PaletteNode[] =>
      preset && (preset.modes?.length ?? 0) > 1
        ? [
            {
              key: 'modes',
              label: 'Permissions',
              icon: 'shield',
              detail: `Now ${mode?.name ?? 'default'}`,
              children: preset.modes!.map((m) => ({
                key: m.id,
                label: `${m.dangerous ? '⚠ ' : ''}${m.name}`,
                icon: 'shield',
                detail: [m.id === mode?.id ? 'current' : '', m.description ?? ''].filter(Boolean).join(' · '),
                run: () => void l.chooseMode(m.id),
              })),
            },
          ]
        : [],
    enabled,
  );
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
