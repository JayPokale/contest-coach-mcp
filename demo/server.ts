// Simulated Alexa+ experience: a voice request goes to an AI agent (GitHub Copilot CLI) that has the
// Contest Coach MCP server configured; the spoken answer comes back with the tool calls it made, and the
// screen shows the tool's structured result, like an Echo Show.
import { spawn } from 'node:child_process';
import express from 'express';

const MCP_URL = process.env.MCP_URL ?? 'http://127.0.0.1:3333/mcp';
const HANDLE = process.env.CF_HANDLE ?? 'rdx_panther';
const LEETCODE = process.env.LC_USER ?? 'JayPokale';

const PERSONA = `You are Alexa+, a voice assistant. The user's Codeforces handle is ${HANDLE} and LeetCode username is ${LEETCODE}.
Use only the contest-coach tools. Reply with exactly what you would say aloud: at most two short sentences, no markdown, no links.
The user says: `;

function askAgent(utterance: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('copilot', ['-p', PERSONA + JSON.stringify(utterance), '--allow-tool', 'contest-coach', '--no-color', '-s'], {
      env: process.env,
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out.replace(/\*\*/g, '').trim()) : reject(new Error(`agent exited with ${code}`))));
  });
}

/// The MCP server (started with COACH_RECORD_CALLS=1) reports exactly which tools the agent called and what they returned.
async function callsSince(since: number) {
  const base = new URL(MCP_URL);
  const res = await fetch(new URL(`/recent-calls?since=${since}`, base));
  return (await res.json()) as { tool: string; args: Record<string, unknown>; result: unknown }[];
}

const app = express();
app.use(express.json());
app.use(express.static(new URL('./public', import.meta.url).pathname));
app.post('/ask', async (req, res) => {
  const utterance = String(req.body?.text ?? '').slice(0, 300);
  const started = Date.now();
  try {
    const speech = await askAgent(utterance);
    const calls = await callsSince(started);
    res.json({ speech, calls, cards: calls.map((c) => ({ tool: c.tool, data: c.result })), ms: Date.now() - started });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

const port = Number(process.env.PORT ?? 3334);
app.listen(port, () => console.log(`Alexa+ simulator on http://127.0.0.1:${port}`));
