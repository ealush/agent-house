// A stand-in agent that writes a Claude Code-shaped transcript, so the GUI feed can be
// tested end to end without an installed AI CLI. Each line typed into it becomes a
// user turn and a reply with a tool call, its result, and a generative-UI widget.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const id = randomUUID();
const dir = join(process.env.CLAUDE_CONFIG_DIR, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
mkdirSync(dir, { recursive: true });
const file = join(dir, `${id}.jsonl`);
let n = 0;
const write = (type, content, extra = {}) =>
  appendFileSync(file, JSON.stringify({ type, uuid: `${type}-${++n}`, sessionId: id, cwd: process.cwd(), timestamp: new Date().toISOString(), message: { role: type, content }, ...extra }) + '\n');

write('user', 'Start the fixture');
write('assistant', [{ type: 'text', text: 'Ready.' }]);

process.stdin.setRawMode(true);
console.log('READY');
let text = '';
process.stdin.on('data', (chunk) => {
  for (const char of chunk.toString()) {
    if (char !== '\r' && char !== '\n') {
      text += char;
      continue;
    }
    const prompt = text;
    text = '';
    console.log(`RECEIVED:${prompt}`);
    const call = `toolu_${n}`;
    write('user', prompt);
    write('assistant', [{ type: 'tool_use', id: call, name: 'Bash', input: { command: `echo ${prompt}`, description: 'Echo it' } }]);
    write('user', [{ type: 'tool_result', tool_use_id: call, content: prompt, is_error: false }], { toolUseResult: { stdout: prompt, stderr: '', interrupted: false } });
    write('assistant', [
      {
        type: 'text',
        text: `Echoed **${prompt}**.\n\n| key | value |\n|---|---|\n| prompt | ${prompt} |\n\n\`\`\`ah-widget\n${JSON.stringify({ type: 'choices', prompt: 'Next?', options: [{ label: 'Again', reply: 'again' }, 'Stop'] })}\n\`\`\``,
      },
    ]);
  }
});
