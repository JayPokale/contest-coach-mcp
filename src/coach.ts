// Contest data and coaching logic on top of the public Codeforces and LeetCode APIs.

const TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; value: unknown }>();

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value as T;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function cf<T>(method: string, params: Record<string, string> = {}): Promise<T> {
  const url = `https://codeforces.com/api/${method}?${new URLSearchParams(params)}`;
  return cached(url, async () => {
    const res = await fetch(url, { headers: { 'User-Agent': 'contest-coach-mcp' } });
    const body = (await res.json()) as { status: string; comment?: string; result: T };
    if (body.status !== 'OK') throw new Error(`Codeforces: ${body.comment ?? res.status}`);
    return body.result;
  });
}

async function leetcode<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  return cached(`lc:${query}:${JSON.stringify(variables)}`, async () => {
    const res = await fetch('https://leetcode.com/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Referer: 'https://leetcode.com', 'User-Agent': 'contest-coach-mcp' },
      body: JSON.stringify({ query, variables }),
    });
    const body = (await res.json()) as { data: T; errors?: { message: string }[] };
    if (body.errors?.length) throw new Error(`LeetCode: ${body.errors[0].message}`);
    return body.data;
  });
}

export type Contest = { platform: 'Codeforces' | 'LeetCode'; name: string; start: string; durationMinutes: number; url: string };

export function speakTime(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleString('en-IN', { timeZone, weekday: 'long', hour: 'numeric', minute: '2-digit', day: 'numeric', month: 'short' });
}

export async function upcomingContests(withinDays: number): Promise<Contest[]> {
  const horizon = Date.now() + withinDays * 86400_000;
  const [cfList, lc] = await Promise.all([
    cf<{ id: number; name: string; phase: string; startTimeSeconds: number; durationSeconds: number }[]>('contest.list', { gym: 'false' }),
    leetcode<{ upcomingContests: { title: string; titleSlug: string; startTime: number; duration: number }[] }>(
      'query { upcomingContests { title titleSlug startTime duration } }',
    ).catch(() => ({ upcomingContests: [] })),
  ]);
  const contests: Contest[] = [
    ...cfList
      .filter((c) => c.phase === 'BEFORE')
      .map((c) => ({ platform: 'Codeforces' as const, name: c.name, start: new Date(c.startTimeSeconds * 1000).toISOString(), durationMinutes: c.durationSeconds / 60, url: `https://codeforces.com/contest/${c.id}` })),
    ...lc.upcomingContests.map((c) => ({ platform: 'LeetCode' as const, name: c.title, start: new Date(c.startTime * 1000).toISOString(), durationMinutes: c.duration / 60, url: `https://leetcode.com/contest/${c.titleSlug}` })),
  ];
  return contests.filter((c) => Date.parse(c.start) <= horizon).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

export type Profile = {
  codeforces?: { handle: string; rating: number; maxRating: number; rank: string; recentChanges: { contest: string; delta: number; newRating: number }[] };
  leetcode?: { username: string; rating: number; topPercentage: number; contests: number; solved: { easy: number; medium: number; hard: number } };
};

export async function profile(cfHandle?: string, lcUser?: string, recent = 5): Promise<Profile> {
  const out: Profile = {};
  if (cfHandle) {
    const [[info], history] = await Promise.all([
      cf<{ handle: string; rating: number; maxRating: number; rank: string }[]>('user.info', { handles: cfHandle }),
      cf<{ contestName: string; oldRating: number; newRating: number }[]>('user.rating', { handle: cfHandle }),
    ]);
    out.codeforces = {
      handle: info.handle, rating: info.rating ?? 0, maxRating: info.maxRating ?? 0, rank: info.rank ?? 'unrated',
      recentChanges: history.slice(-recent).reverse().map((h) => ({ contest: h.contestName, delta: h.newRating - h.oldRating, newRating: h.newRating })),
    };
  }
  if (lcUser) {
    const d = await leetcode<{
      userContestRanking: { rating: number; topPercentage: number; attendedContestsCount: number } | null;
      matchedUser: { submitStatsGlobal: { acSubmissionNum: { difficulty: string; count: number }[] } } | null;
    }>(
      'query($u: String!) { userContestRanking(username: $u) { rating topPercentage attendedContestsCount } matchedUser(username: $u) { submitStatsGlobal { acSubmissionNum { difficulty count } } } }',
      { u: lcUser },
    );
    if (!d.matchedUser) throw new Error(`LeetCode user ${lcUser} not found`);
    const n = (k: string) => d.matchedUser!.submitStatsGlobal.acSubmissionNum.find((x) => x.difficulty === k)?.count ?? 0;
    out.leetcode = {
      username: lcUser, rating: Math.round(d.userContestRanking?.rating ?? 0), topPercentage: d.userContestRanking?.topPercentage ?? 100,
      contests: d.userContestRanking?.attendedContestsCount ?? 0, solved: { easy: n('Easy'), medium: n('Medium'), hard: n('Hard') },
    };
  }
  return out;
}

type Submission = { verdict?: string; problem: { contestId?: number; index: string; name: string; rating?: number; tags: string[] } };
type Problem = { contestId?: number; index: string; name: string; rating?: number; tags: string[] };

const key = (p: { contestId?: number; index: string }) => `${p.contestId}${p.index}`;

export type TopicStat = { tag: string; solved: number; attempted: number; failedAttempts: number; inBand: number; score: number };

/**
 * A topic is "weak" when it shows up a lot in problems near the user's rating
 * but the user has solved few of them, or keeps failing them.
 */
export async function weakTopics(cfHandle: string, limit = 5): Promise<{ rating: number; band: [number, number]; topics: TopicStat[] }> {
  const [[info], subs, set] = await Promise.all([
    cf<{ rating?: number }[]>('user.info', { handles: cfHandle }),
    cf<Submission[]>('user.status', { handle: cfHandle }),
    cf<{ problems: Problem[] }>('problemset.problems'),
  ]);
  const rating = info.rating ?? 1200;
  const band: [number, number] = [Math.max(800, Math.floor((rating - 200) / 100) * 100), Math.ceil((rating + 300) / 100) * 100];
  const solved = new Set(subs.filter((s) => s.verdict === 'OK').map((s) => key(s.problem)));
  const stats = new Map<string, TopicStat>();
  const stat = (tag: string) => stats.get(tag) ?? stats.set(tag, { tag, solved: 0, attempted: 0, failedAttempts: 0, inBand: 0, score: 0 }).get(tag)!;
  const attempted = new Set<string>();
  for (const s of subs) {
    for (const t of s.problem.tags) {
      if (!attempted.has(`${key(s.problem)}|${t}`)) { attempted.add(`${key(s.problem)}|${t}`); stat(t).attempted++; }
      if (s.verdict && s.verdict !== 'OK') stat(t).failedAttempts++;
    }
  }
  for (const k of solved) {
    const p = subs.find((s) => key(s.problem) === k)!.problem;
    for (const t of p.tags) stat(t).solved++;
  }
  for (const p of set.problems) {
    if (p.rating && p.rating >= band[0] && p.rating <= band[1]) for (const t of p.tags) stat(t).inBand++;
  }
  const bandTotal = set.problems.filter((p) => p.rating && p.rating >= band[0] && p.rating <= band[1]).length;
  for (const s of stats.values()) {
    const coverage = s.inBand / Math.max(1, bandTotal); // how often the topic appears near your rating
    const practice = s.solved / (s.solved + 10); // saturates as you solve more of it
    const failRate = s.failedAttempts / (s.failedAttempts + s.solved + 1);
    s.score = Math.round(coverage * (1 - practice) * (1 + failRate) * 1000) / 1000;
  }
  const topics = [...stats.values()].filter((s) => s.inBand >= 20 && s.tag !== '*special').sort((a, b) => b.score - a.score).slice(0, limit);
  return { rating, band, topics };
}

export type Recommendation = { name: string; rating: number; tags: string[]; url: string };

export async function recommendProblems(cfHandle: string, count = 3, tag?: string): Promise<{ rating: number; focus: string[]; problems: Recommendation[] }> {
  const [weak, subs, set] = await Promise.all([
    weakTopics(cfHandle, 3),
    cf<Submission[]>('user.status', { handle: cfHandle }),
    cf<{ problems: Problem[]; problemStatistics: { contestId?: number; index: string; solvedCount: number }[] }>('problemset.problems'),
  ]);
  const solved = new Set(subs.filter((s) => s.verdict === 'OK').map((s) => key(s.problem)));
  const solvedCount = new Map(set.problemStatistics.map((s) => [key(s), s.solvedCount]));
  const focus = tag ? [tag] : weak.topics.map((t) => t.tag);
  const lo = Math.ceil((weak.rating + 50) / 100) * 100;
  const hi = lo + 200;
  const pool = set.problems.filter(
    (p) => p.rating && p.rating >= lo && p.rating <= hi && !solved.has(key(p)) && p.tags.some((t) => focus.includes(t)) && !p.tags.includes('*special'),
  );
  // Prefer recent, well-tested problems: newest contests first, then by how many people solved them.
  pool.sort((a, b) => (b.contestId ?? 0) - (a.contestId ?? 0) || (solvedCount.get(key(b)) ?? 0) - (solvedCount.get(key(a)) ?? 0));
  const picked: Recommendation[] = [];
  for (const t of focus) {
    const p = pool.find((q) => q.tags.includes(t) && !picked.some((x) => x.name === q.name));
    if (p) picked.push({ name: p.name, rating: p.rating!, tags: p.tags, url: `https://codeforces.com/problemset/problem/${p.contestId}/${p.index}` });
    if (picked.length >= count) break;
  }
  for (const p of pool) {
    if (picked.length >= count) break;
    if (!picked.some((x) => x.name === p.name)) picked.push({ name: p.name, rating: p.rating!, tags: p.tags, url: `https://codeforces.com/problemset/problem/${p.contestId}/${p.index}` });
  }
  return { rating: weak.rating, focus, problems: picked };
}
