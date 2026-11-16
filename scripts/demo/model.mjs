// Not a language model: the demo host's scripted stand-in behind an OpenAI-style endpoint, so
// stack review's briefings, the reviewer thread and side chat have something to answer them.
// It reads only the patch it's sent and says so in every answer; nothing leaves this machine.
import { createServer } from 'node:http';

/** The files a unified diff touches, with lines added and removed and the first added line. */
export function readPatch(text) {
  const files = [];
  let file = null;
  let line = 0;
  for (const raw of text.split('\n')) {
    const head = raw.match(/^diff --git a\/(\S+) b\/(\S+)/);
    if (head) {
      file = { path: head[2], added: 0, removed: 0, first: null, sample: null };
      files.push(file);
      continue;
    }
    if (!file) continue;
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith('+++') || raw.startsWith('---')) continue;
    if (raw.startsWith('+')) {
      file.added++;
      if (file.first === null) file.first = line;
      if (!file.sample && raw.slice(1).trim().length > 8) file.sample = { line, text: raw.slice(1).trim() };
      line++;
    } else if (raw.startsWith('-')) file.removed++;
    else line++;
  }
  return files;
}

const NOTE = '_Scripted demo model: it reads the patch it is given and nothing else._';

function layerOf(text) {
  const m = text.match(/You are reviewing #(\d+) "([^"]*)" \((\S+) on (\S+)\)/);
  return m ? { pr: Number(m[1]), title: m[2], head: m[3], base: m[4] } : null;
}

function briefing(context) {
  const layer = layerOf(context);
  const files = readPatch(context.split("This layer's patch:\n")[1] ?? '');
  const tests = files.filter((f) => /test|spec/i.test(f.path));
  const code = files.filter((f) => !tests.includes(f));
  const lines = ['### What it does'];
  if (layer) lines.push(`- ${layer.title}.`);
  for (const f of code.slice(0, 3)) lines.push(`- Changes \`${f.path}\` (+${f.added} −${f.removed}).`);
  lines.push('', '### How it fits');
  if (layer) lines.push(`- Builds on \`${layer.base}\`; the layers above start from \`${layer.head}\`.`);
  lines.push('', '### Look closely at');
  for (const f of code.filter((x) => x.sample).slice(0, 2)) lines.push(`- \`${f.path}:${f.sample.line}\`: \`${f.sample.text.slice(0, 70)}\``);
  lines.push('', '### Tests');
  lines.push(tests.length ? `- ${tests.map((t) => `\`${t.path}\``).join(', ')} cover${tests.length === 1 ? 's' : ''} it.` : '- No test changes in this layer.');
  lines.push('', NOTE);
  return lines.join('\n');
}

function reviewerReply(system, question) {
  const layer = layerOf(system);
  const files = readPatch(system.split("This layer's patch:\n")[1] ?? '');
  const content = [
    `### ${layer ? `#${layer.pr}` : 'The stack'}`,
    files.length ? `This layer touches ${files.map((f) => `\`${f.path}\``).join(', ')}.` : 'There is no patch to read for this question.',
    '',
    `You asked: “${question.slice(0, 200)}”. A real model would answer that from the code; this one can only point at what changed.`,
    '',
    NOTE,
  ].join('\n');
  const target = files.find((f) => f.sample && !/test|spec/i.test(f.path));
  const findings = target && layer ? [{ title: 'Name the magic number', body: `\`${target.sample.text.slice(0, 80)}\` reads better with a named constant.`, severity: 'nit', path: target.path, line_start: target.sample.line, line_end: target.sample.line, owner_pr: layer.pr }] : [];
  return JSON.stringify({ content, followups: [], findings });
}

// Voice (ah docs/spec/14-voice.md): it can't hear, so every recording "says" the same, and the
// cleanup tidies that sentence the way a real one would. Both say they're the demo's.
const HEARD = "um so the demo host can't really hear you but this is where your words would go";
const NEXT = 'and this is where the next part would go';

/** The scripted cleanup: fillers out, a capital and a full stop per batch heard. */
function tidied(text) {
  return text
    .replace(/<phone>[\s\S]*<\/phone>/, '')
    .replace(/<\/?transcript>/g, '')
    .replace(/\b(um|uh) (so )?/g, '')
    .trim()
    .replace(/ (and this is where the next part)/g, '. And this is where the next part')
    .replace(/you but/g, 'you, but')
    .replace(/^./, (c) => c.toUpperCase())
    .replace(/([^.])$/, '$1.');
}

function chatReply(question) {
  return `You asked: “${question.slice(0, 200)}”.\n\nThis is the demo host's scripted model, so there's no real answer here: pick a real subscription in Settings → Subscriptions for that.\n\n${NOTE}`;
}

const text = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.map((p) => p?.text ?? '').join('\n') : '');

/** Starts the endpoint on a free loopback port. `delay`: how long a briefing takes, in ms. */
export function startModel({ delay = 4000 } = {}) {
  const server = createServer(async (req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && req.url === '/v1/models') return send(200, { data: [{ id: 'demo-briefer', created: 0, object: 'model' }, { id: 'demo-whisper', created: 0, object: 'model' }] });
    if (req.method === 'POST' && req.url === '/v1/audio/transcriptions') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const form = Buffer.concat(chunks).toString('latin1');
      await new Promise((r) => setTimeout(r, 900));
      // A batch that comes after another (its prompt holds what came before) "says" what's next.
      const later = /name="prompt"[\s\S]*demo host can't really hear/.test(form);
      return send(200, { text: form.length > 0 ? (later ? NEXT : HEARD) : '', language: 'english', duration: 3.1 });
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return send(404, { error: { message: 'not found' } });
    let body = '';
    for await (const chunk of req) body += chunk;
    let messages = [];
    try {
      messages = JSON.parse(body).messages ?? [];
    } catch {
      return send(400, { error: { message: 'bad JSON' } });
    }
    const system = text(messages.find((m) => m.role === 'system')?.content);
    const last = text([...messages].reverse().find((m) => m.role === 'user')?.content);
    let content;
    if (system.includes('Write a briefing')) {
      await new Promise((r) => setTimeout(r, delay));
      content = briefing(last);
    } else if (system.includes('You edit dictated speech')) {
      await new Promise((r) => setTimeout(r, 700));
      content = tidied(last);
    } else if (system.includes('Reply with ONLY a JSON object')) {
      await new Promise((r) => setTimeout(r, 1200));
      content = reviewerReply(system, last);
    } else {
      await new Promise((r) => setTimeout(r, 800));
      content = chatReply(last);
    }
    send(200, { id: 'demo', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, close: () => server.close() })));
}
