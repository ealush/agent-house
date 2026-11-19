// What you say to a running session: messages, answers to its prompts, pickers and
// questions, its launch settings, Stop, plus your draft, focus and recent prompts.
import { projectFiles, slashCommands } from '../complete.ts';
import { HttpError, readJson, send, str } from '../http.ts';
import type { Core } from '../core.ts';
import type { Drafts } from '../drafts.ts';
import { route, type Audit, type Route } from './router.ts';

export type InputRouteDeps = {
  audit: Audit;
  core: Core;
  drafts: Drafts;
};

export function inputRoutes({ audit, core, drafts }: InputRouteDeps): Route[] {
  return [
    route('POST', /^\/api\/sessions\/([\w:.-]{1,80})\/send$/, async ({ req, res, m }) => {
      const body = await readJson(req);
      const out = await core.send(m[1], str(body.text, 'text', 32 * 1024), body.enter !== false);
      audit(req, 'session.send', { ref: m[1], window: out.windowId, outcome: out.outcome, resumed: out.resumed });
      return send(res, 200, out);
    }),
    route('POST', /^\/api\/sessions\/([\w-]{1,40})\/answer$/, async ({ req, res, m, caller }) => {
      const body = await readJson(req);
      const answer = body.answer;
      if (answer !== 'approve' && answer !== 'deny') throw new HttpError(400, 'answer must be approve or deny');
      // The prompt the caller saw (`askId`), optional: older clients send none.
      const prompt = body.prompt === undefined || body.prompt === null ? undefined : str(body.prompt, 'prompt', 64);
      await core.answer(m[1], answer, prompt);
      audit(req, `session.${answer}`, { uid: m[1] });
      return send(res, 200, { ok: true });
    }),
    route('GET', /^\/api\/sessions\/([\w-]{1,40})\/commands$/, async ({ res, m }) => {
      const { preset, cwd } = await core.sessionPlace(m[1]);
      return send(res, 200, preset ? await slashCommands(preset, cwd) : []);
    }),
    route('GET', /^\/api\/sessions\/([\w-]{1,40})\/files$/, async ({ res, url, m }) => {
      const { cwd } = await core.sessionPlace(m[1]);
      const q = (url.searchParams.get('q') ?? '').slice(0, 200);
      return send(res, 200, await projectFiles(cwd, q));
    }),
    route('POST', /^\/api\/sessions\/([\w-]{1,40})\/choose$/, async ({ req, res, m }) => {
      const key = str((await readJson(req)).key, 'key', 8);
      const option = await core.choose(m[1], key);
      audit(req, 'session.choose', { uid: m[1], key, label: option.label.slice(0, 80) });
      return send(res, 200, { ok: true, label: option.label });
    }),
    // The screen in front of an agent's prompt: what it asks to have typed (a code, an
    // API key — never logged), Esc back a step where it says so, or the address a
    // browser elsewhere ended on after a sign-in that hands back to this host.
    route('POST', /^\/api\/sessions\/([\w-]{1,40})\/gate$/, async ({ req, res, m }) => {
      const body = await readJson(req);
      // A sign-in's callback address carries its one-time code: never in the audit log.
      if (body.callback !== undefined) {
        const { status } = await core.answerGate(m[1], { callback: str(body.callback, 'callback', 8192) });
        audit(req, 'session.gate', { uid: m[1], callback: true, status });
        return send(res, 200, { ok: true, status });
      }
      if (body.back === true) await core.answerGate(m[1], { back: true });
      else await core.answerGate(m[1], { text: str(body.text, 'text', 4000) });
      audit(req, 'session.gate', { uid: m[1], ...(body.back === true ? { back: true } : { typed: true }) });
      return send(res, 200, { ok: true });
    }),
    route('POST', /^\/api\/sessions\/([\w-]{1,40})\/questions$/, async ({ req, res, m }) => {
      const body = await readJson(req);
      const answerOf = (a: any) => ({
        picked: Array.isArray(a?.picked) ? a.picked.slice(0, 9) : [],
        ...(a?.text !== undefined ? { text: str(a.text, 'text', 2000) } : {}),
        ...(a?.notes !== undefined ? { notes: str(a.notes, 'notes', 2000) } : {}),
      });
      if (body.chat === true) {
        // "Chat about this": decline the questions and talk it over instead.
        await core.chatAboutQuestions(m[1], body.question === undefined ? undefined : str(body.question, 'question', 2000));
        audit(req, 'session.questions.chat', { uid: m[1] });
        return send(res, 200, { ok: true });
      }
      if (body.current) {
        // One question: the one the dialog shows now.
        const current = body.current as { question?: unknown; answer?: unknown };
        await core.answerDialogQuestion(m[1], str(current.question, 'question', 2000), answerOf(current.answer));
        audit(req, 'session.questions', { uid: m[1], count: 1 });
        return send(res, 200, { ok: true });
      }
      if (!Array.isArray(body.answers) || body.answers.length > 8) throw new HttpError(400, 'answers must be a list');
      const answers = body.answers.map(answerOf);
      await core.answerQuestions(m[1], answers);
      audit(req, 'session.questions', { uid: m[1], count: answers.length });
      return send(res, 200, { ok: true });
    }),
    route('POST', /^\/api\/sessions\/([\w-]{1,40})\/switch$/, async ({ req, res, m }) => {
      const body = await readJson(req);
      const change = {
        ...(body.model !== undefined ? { model: str(body.model, 'model', 80) } : {}),
        ...(body.effort !== undefined ? { effort: str(body.effort, 'effort', 20) } : {}),
      };
      const out = await core.switchLaunch(m[1], change);
      audit(req, 'session.switch', { uid: m[1], ...change, outcome: out.outcome });
      return send(res, 200, out);
    }),
    route('POST', /^\/api\/sessions\/([\w-]{1,40})\/mode$/, async ({ req, res, m }) => {
      const mode = str((await readJson(req)).mode, 'mode', 40);
      const out = await core.switchMode(m[1], mode);
      audit(req, 'session.mode', { uid: m[1], mode, switched: out.switched });
      return send(res, 200, out);
    }),
    route('POST', /^\/api\/sessions\/([\w-]{1,40})\/settings$/, async ({ req, res, m }) => {
      const setting = (await readJson(req)).setting;
      if (setting !== 'model' && setting !== 'effort' && setting !== 'mode') throw new HttpError(400, 'unknown setting');
      const out = await core.openSettings(m[1], setting);
      audit(req, 'session.settings', { uid: m[1], setting, outcome: out.outcome });
      return send(res, 200, out);
    }),
    route('POST', /^\/api\/sessions\/([\w-]{1,40})\/relaunch$/, async ({ req, res, m }) => {
      const body = await readJson(req);
      const change = {
        ...(body.model !== undefined ? { model: str(body.model, 'model', 80) } : {}),
        ...(body.effort !== undefined ? { effort: str(body.effort, 'effort', 20) } : {}),
        ...(body.mode !== undefined ? { mode: str(body.mode, 'mode', 40) } : {}),
      };
      const out = await core.relaunch(m[1], change);
      audit(req, 'session.relaunch', { uid: m[1], ...change, window: out.id });
      return send(res, 200, out);
    }),
    route('POST', /^\/api\/sessions\/([\w-]{1,40})\/interrupt$/, async ({ req, res, m }) => {
      await core.interrupt(m[1]);
      audit(req, 'session.interrupt', { uid: m[1] });
      return send(res, 200, { ok: true });
    }),
    // Handoff: the session this device is on, so another device can offer to continue it.
    route('POST', /^\/api\/focus$/, async ({ req, res }) => {
      const body = await readJson(req);
      const key = str(body.key, 'key', 120);
      if (!/^(?:[\w.-]{1,64}\/)?[\w-]{1,40}$/.test(key)) throw new HttpError(400, 'invalid key');
      core.setFocus({ key, device: str(body.device ?? '', 'device', 40).replace(/[^\w .-]/g, '').slice(0, 24) || 'browser', client: str(body.client ?? '', 'client', 40) });
      return send(res, 200, { ok: true });
    }),
    // Unsent composer text, so a draft follows you between devices (server/drafts.ts).
    route('GET', /^\/api\/sessions\/([\w-]{1,40})\/draft$/, ({ res, m }) => send(res, 200, { draft: drafts.get(m[1]) })),
    route('PUT', /^\/api\/sessions\/([\w-]{1,40})\/draft$/, async ({ req, res, m }) => {
      const body = await readJson(req);
      const text = str(body.text ?? '', 'text', 32 * 1024);
      return send(res, 200, { draft: drafts.set(m[1], text, str(body.device ?? '', 'device', 40), str(body.client ?? '', 'client', 40)) });
    }),
    route('GET', /^\/api\/prompts$/, ({ res }) => send(res, 200, core.recentPrompts())),
    route('DELETE', /^\/api\/prompts$/, ({ req, res }) => {
      core.clearPrompts();
      audit(req, 'prompts.clear');
      return send(res, 200, { ok: true });
    }),
  ];
}
