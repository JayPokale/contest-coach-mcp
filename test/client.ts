import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const client = new Client({ name: 'demo', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(process.env.MCP_URL ?? 'http://127.0.0.1:3333/mcp')));
console.log('protocol', (client as any)._transport?.protocolVersion ?? '', 'server', client.getServerVersion());
console.log('tools:', (await client.listTools()).tools.map((t) => t.name).join(', '));
for (const [name, args] of [
  ['upcoming_contests', { within_days: 7 }],
  ['my_ratings', { codeforces_handle: 'rdx_panther', leetcode_username: 'JayPokale' }],
  ['weak_topics', { codeforces_handle: 'rdx_panther' }],
  ['practice_problems', { codeforces_handle: 'rdx_panther', count: 3 }],
  ['daily_plan', { codeforces_handle: 'rdx_panther' }],
] as const) {
  const t0 = Date.now();
  const r: any = await client.callTool({ name, arguments: args });
  console.log(`\n▶ ${name} (${Date.now() - t0} ms)${r.isError ? ' ERROR' : ''}\n  🔊 ${r.content[0].text}`);
  if (name === 'practice_problems') console.log('  ', JSON.stringify(r.structuredContent.problems.map((p: any) => p.url)));
  if (name === 'weak_topics') console.log('  ', JSON.stringify(r.structuredContent.topics.map((t: any) => [t.tag, t.solved, t.failedAttempts, t.score])));
}
await client.close();
