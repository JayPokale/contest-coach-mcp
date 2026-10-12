// Contest Coach: an MCP server (spec 2025-11-25, Streamable HTTP) that lets a voice assistant
// like Alexa+ coach competitive programmers using live Codeforces and LeetCode data.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { z } from 'zod';
import { profile, recommendProblems, speakTime, upcomingContests, weakTopics } from './coach.js';

const TZ = process.env.COACH_TIMEZONE ?? 'Asia/Kolkata';
const readOnly = { readOnlyHint: true, openWorldHint: true } as const;

// Every tool answers twice: a short sentence an assistant can read aloud, and structured data.
const reply = <T extends Record<string, unknown>>(speech: string, data: T) => ({
  content: [{ type: 'text' as const, text: speech }],
  structuredContent: { speech, ...data },
});

const fail = (err: unknown) => ({
  isError: true,
  content: [{ type: 'text' as const, text: `Sorry, I couldn't get that: ${err instanceof Error ? err.message : String(err)}` }],
});

const contestShape = z.object({ platform: z.string(), name: z.string(), start: z.string(), durationMinutes: z.number(), url: z.string() });
const problemShape = z.object({ name: z.string(), rating: z.number(), tags: z.array(z.string()), url: z.string() });

export function buildServer(): McpServer {
  const server = new McpServer({ name: 'contest-coach', version: '1.0.0' });

  server.registerTool(
    'upcoming_contests',
    {
      title: 'Upcoming contests',
      description: 'Upcoming Codeforces and LeetCode contests, soonest first. Use for "when is the next contest".',
      inputSchema: { within_days: z.number().int().min(1).max(30).default(7).describe('How many days ahead to look') },
      outputSchema: { speech: z.string(), contests: z.array(contestShape) },
      annotations: readOnly,
    },
    async ({ within_days }) => {
      try {
        const contests = await upcomingContests(within_days);
        if (!contests.length) return reply(`No contests in the next ${within_days} days.`, { contests });
        const next = contests[0];
        const speech = `${contests.length} contest${contests.length > 1 ? 's' : ''} in the next ${within_days} days. ` +
          `The next one is ${next.name} on ${next.platform}, ${speakTime(next.start, TZ)}, for ${next.durationMinutes / 60} hours.`;
        return reply(speech, { contests });
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    'my_ratings',
    {
      title: 'Ratings and recent rating changes',
      description: 'Current Codeforces and/or LeetCode contest rating, rank, and the last few Codeforces rating changes.',
      inputSchema: {
        codeforces_handle: z.string().optional(),
        leetcode_username: z.string().optional(),
      },
      outputSchema: { speech: z.string(), codeforces: z.any().optional(), leetcode: z.any().optional() },
      annotations: readOnly,
    },
    async ({ codeforces_handle, leetcode_username }) => {
      if (!codeforces_handle && !leetcode_username) return fail('give a Codeforces handle or a LeetCode username');
      try {
        const p = await profile(codeforces_handle, leetcode_username);
        const parts: string[] = [];
        if (p.codeforces) {
          const last = p.codeforces.recentChanges[0];
          parts.push(`On Codeforces you're ${p.codeforces.rank} at ${p.codeforces.rating}` +
            (last ? `, ${last.delta >= 0 ? 'up' : 'down'} ${Math.abs(last.delta)} in ${last.contest}.` : '.'));
        }
        if (p.leetcode) parts.push(`On LeetCode your contest rating is ${p.leetcode.rating}, top ${p.leetcode.topPercentage} percent, after ${p.leetcode.contests} contests.`);
        return reply(parts.join(' '), p);
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    'weak_topics',
    {
      title: 'Weak topics',
      description: 'Codeforces topics that appear often near the user\'s rating but that they have rarely solved or often fail.',
      inputSchema: { codeforces_handle: z.string(), limit: z.number().int().min(1).max(10).default(3) },
      outputSchema: {
        speech: z.string(), rating: z.number(), band: z.array(z.number()),
        topics: z.array(z.object({ tag: z.string(), solved: z.number(), attempted: z.number(), failedAttempts: z.number(), inBand: z.number(), score: z.number() })),
      },
      annotations: readOnly,
    },
    async ({ codeforces_handle, limit }) => {
      try {
        const w = await weakTopics(codeforces_handle, limit);
        const speech = `Around your rating of ${w.rating}, the topics to work on are ${w.topics.map((t) => t.tag).join(', ')}.`;
        return reply(speech, { rating: w.rating, band: w.band, topics: w.topics });
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    'practice_problems',
    {
      title: 'Practice problems',
      description: 'Unsolved Codeforces problems slightly above the user\'s rating, focused on weak topics (or a given tag).',
      inputSchema: {
        codeforces_handle: z.string(),
        count: z.number().int().min(1).max(10).default(3),
        tag: z.string().optional().describe('Codeforces tag such as "dp" or "graphs"; defaults to the weakest topics'),
      },
      outputSchema: { speech: z.string(), rating: z.number(), focus: z.array(z.string()), problems: z.array(problemShape) },
      annotations: readOnly,
    },
    async ({ codeforces_handle, count, tag }) => {
      try {
        const r = await recommendProblems(codeforces_handle, count, tag);
        const speech = r.problems.length
          ? `Here are ${r.problems.length} problems for today: ` + r.problems.map((p) => `${p.name}, rated ${p.rating}`).join('; ') + `. I've sent the links.`
          : `I couldn't find unsolved problems for that topic near your rating.`;
        return reply(speech, r);
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    'daily_plan',
    {
      title: 'Daily practice plan',
      description: 'One-shot plan for today: the next contest, the weakest topic, and practice problems. Good for "what should I practice today".',
      inputSchema: { codeforces_handle: z.string(), leetcode_username: z.string().optional(), problems: z.number().int().min(1).max(5).default(2) },
      outputSchema: { speech: z.string(), nextContest: contestShape.optional(), focus: z.array(z.string()), problems: z.array(problemShape) },
      annotations: readOnly,
    },
    async ({ codeforces_handle, problems }) => {
      try {
        const [contests, rec] = await Promise.all([upcomingContests(7), recommendProblems(codeforces_handle, problems)]);
        const next = contests[0];
        const speech = `Today, focus on ${rec.focus[0]}. Try ${rec.problems.map((p) => p.name).join(' and ')}.` +
          (next ? ` Then rest up: ${next.name} starts ${speakTime(next.start, TZ)}.` : '');
        return reply(speech, { nextContest: next, focus: rec.focus, problems: rec.problems });
      } catch (e) { return fail(e); }
    },
  );

  server.registerPrompt(
    'coach_me',
    {
      title: 'Coach me',
      description: 'Ask the assistant for a short daily coaching session.',
      argsSchema: { codeforces_handle: z.string() },
    },
    ({ codeforces_handle }) => ({
      messages: [{
        role: 'user',
        content: { type: 'text', text: `I'm ${codeforces_handle} on Codeforces. Use daily_plan, then explain in two spoken sentences what to practice today and why.` },
      }],
    }),
  );

  return server;
}

// Stateless Streamable HTTP: a fresh server and transport per request.
const app = createMcpExpressApp({ host: process.env.HOST ?? '127.0.0.1' });
app.post('/mcp', async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
const notAllowed = (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) =>
  res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
app.get('/mcp', notAllowed);
app.delete('/mcp', notAllowed);
app.get('/health', (_req, res) => { res.json({ ok: true }); });

const port = Number(process.env.PORT ?? 3333);
app.listen(port, () => console.log(`Contest Coach MCP server on http://${process.env.HOST ?? '127.0.0.1'}:${port}/mcp`));
