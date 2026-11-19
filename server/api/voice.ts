// Voice dictation (docs/spec/14-voice.md): speech and cleanup through your
// subscriptions; the text only fills a composer. Neither audio nor text is logged.
import { HttpError, readBody, readJson, send, str } from '../http.ts';
import { AUDIO_UPLOAD_MS, MAX_AUDIO_BYTES, MAX_DICTATING } from '../voice.ts';
import type { VoiceService } from '../voice.ts';
import { route, type Audit, type Route } from './router.ts';

export type VoiceRouteDeps = {
  audit: Audit;
  voice: VoiceService;
};

export function voiceRoutes({ audit, voice }: VoiceRouteDeps): Route[] {
  /** Dictations being read or heard now (each holds its recording in memory). */
  let dictating = 0;
  return [
    route('GET', /^\/api\/voice$/, async ({ res }) => send(res, 200, await voice.settings())),
    route('PUT', /^\/api\/voice$/, async ({ req, res }) => {
      const out = await voice.update(await readJson(req));
      audit(req, 'voice.settings', { speech: out.speech?.name ?? null, cleanup: out.cleanup?.name ?? null, style: out.style });
      return send(res, 200, out);
    }),
    route('POST', /^\/api\/voice\/models$/, async ({ req, res }) => {
      const models = await voice.models(str((await readJson(req)).subscriptionId, 'subscriptionId', 40));
      return send(res, 200, { models });
    }),
    route('POST', /^\/api\/voice\/dictate$/, async ({ req, res, url }) => {
      const declared = Number(req.headers['content-length']);
      if (declared > MAX_AUDIO_BYTES) throw new HttpError(413, 'recording too large', 'voice_too_large');
      const q = url.searchParams;
      const context = q.get('context');
      if (context !== null && context.length > 2000) throw new HttpError(400, 'invalid context');
      if (dictating >= MAX_DICTATING) throw new HttpError(429, 'too many dictations at once', 'voice_busy');
      dictating++;
      try {
        let audio: Buffer;
        try {
          audio = await readBody(req, MAX_AUDIO_BYTES, AUDIO_UPLOAD_MS);
        } catch (err) {
          if (err instanceof HttpError && err.status === 413) throw new HttpError(413, 'recording too large', 'voice_too_large');
          throw err;
        }
        const out = await voice.dictate(audio, { name: q.get('name'), style: q.get('style'), language: q.get('language'), context });
        audit(req, 'voice.dictate', { bytes: audio.length, speech: out.speech, cleanedBy: out.cleanedBy, ...(out.cleanupError ? { cleanupFailed: true } : {}) });
        return send(res, 200, out);
      } finally {
        dictating--;
      }
    }),
    route('POST', /^\/api\/voice\/refine$/, async ({ req, res }) => {
      const body = await readJson(req);
      const text = str(body.text ?? '', 'text', 24_000).trim();
      if (!text) throw new HttpError(400, 'text required');
      const out = await voice.refine(text, body.style, body.phone === undefined ? '' : str(body.phone, 'phone', 24_000));
      audit(req, 'voice.refine', { chars: text.length, cleanedBy: out.cleanedBy });
      return send(res, 200, out);
    }),
  ];
}
