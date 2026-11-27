// A scripted OpenAI Chat Completions server, for driving a real agent CLI (pi) without a
// model or a key. The last user message decides the reply:
//   "RUN <command>"  a bash tool call, then what it printed
//   "SLOW …"         forty words, half a second apart (something to Stop)
//   anything else    "You said: <it>"
import { createServer, type Server } from 'node:http';

export type FakeModel = { url: string; requests: number; close: () => Promise<void> };

function lastTurn(messages: any[]): { tool: boolean; text: string } {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const text = typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map((c: any) => c.text ?? '').join('') : '';
    if (m.role === 'tool') return { tool: true, text };
    if (m.role === 'user') return { tool: false, text };
  }
  return { tool: false, text: '' };
}

export function startFakeModel(): Promise<FakeModel> {
  let requests = 0;
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      if (req.url?.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'fake-1', object: 'model' }] }));
      }
      requests++;
      const last = lastTurn(JSON.parse(body || '{}').messages ?? []);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta: object, finish: string | null = null) =>
        res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'fake-1', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      const run = !last.tool && last.text.match(/RUN (.+)/);
      if (run) {
        chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: 'function', function: { name: 'bash', arguments: '' } }] });
        chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ command: run[1].trim() }) } }] });
        chunk({}, 'tool_calls');
      } else {
        const slow = !last.tool && /SLOW/.test(last.text);
        const reply = last.tool ? `The command printed: ${last.text.trim()}` : `You said: ${last.text.trim()}`;
        chunk({ role: 'assistant', content: '' });
        for (const word of slow ? Array(40).fill('tick') : reply.split(' ')) {
          if (res.destroyed) return;
          chunk({ content: `${word} ` });
          if (slow) await new Promise((r) => setTimeout(r, 500));
        }
        chunk({}, 'stop');
      }
      res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'fake-1', choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        get requests() {
          return requests;
        },
        close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))),
      });
    }),
  );
}

/** pi's models.json naming the fake as provider `fake`, models fake-1 and fake-2. */
export function fakePiModels(url: string) {
  const model = (id: string, reasoning: boolean) => ({ id, name: id, reasoning, input: ['text'], contextWindow: 100000, maxTokens: 4000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
  return { providers: { fake: { baseUrl: url, api: 'openai-completions', apiKey: 'none', models: [model('fake-1', false), model('fake-2', true)] } } };
}
