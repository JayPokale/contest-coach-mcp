"""Demo video for the Amazon Developer Hackathon (Alexa+ track).

Real recordings of the simulated Alexa+ page talking to the Contest Coach MCP server through an AI agent,
with Piper voices for the user and for Alexa. Waiting time while the agent works is sped up and labelled.

Needs: the MCP server on :3333, the simulator on :3334, Playwright and Piper (e.g. the Podium venv).
    python demo/make_video.py   ->  demo/build/contest_coach_demo.mp4
"""
import json
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "build"
VOICES = Path.home() / "Desktop/hacktoberfest/work/podium/data/voices"
NARRATOR = VOICES / "en_US-lessac-medium.onnx"
USER = VOICES / "en_GB-alan-medium.onnx"
BROWSER = "/opt/brave-bin/brave"
URL = "http://127.0.0.1:3334/"
W, H = 1280, 720
CSS = """<style>html,body{margin:0;width:1280px;height:720px;background:#0b1220;color:#e8eefc;font-family:system-ui,'Segoe UI',sans-serif}
.s{box-sizing:border-box;width:1280px;height:720px;padding:70px 90px;display:flex;flex-direction:column;justify-content:center}
h1{font-size:60px;margin:0 0 16px;line-height:1.1} h2{font-size:42px;margin:0 0 24px} p,li{font-size:27px;line-height:1.45;margin:6px 0}
.m{color:#93a1bf} .tag{display:inline-block;background:#0b2a3a;color:#8fe3ff;border:1px solid #18c7ff55;border-radius:99px;padding:6px 16px;font-size:20px;font-weight:700;margin-bottom:20px}
.flow{display:flex;align-items:center;gap:14px;font-size:24px;margin:26px 0} .box{background:#121b2e;border:1px solid #2a3a5e;border-radius:14px;padding:16px 18px;text-align:center}
.arrow{color:#18c7ff;font-size:30px} code,pre{font-family:ui-monospace,monospace} pre{font-size:19px;background:#121b2e;border:1px solid #2a3a5e;border-radius:12px;padding:18px 22px;margin:0;line-height:1.4;white-space:pre-wrap}
</style>"""


def run(cmd, **kw):
    subprocess.run(cmd, check=True, **kw)


def dur(p):
    return float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(p)],
                                capture_output=True, text=True, check=True).stdout)


def shot(name, body):
    html = OUT / f"{name}.html"
    html.write_text(f"<!doctype html><meta charset=utf-8>{CSS}<div class='s'>{body}</div>")
    png = OUT / f"{name}.png"
    run([BROWSER, "--headless=new", "--disable-gpu", "--hide-scrollbars", f"--window-size={W},{H}", f"--screenshot={png}", f"file://{html}"],
        capture_output=True)
    return png


def tts(name, text, voice=NARRATOR, speed=1.0):
    wav = OUT / f"{name}.wav"
    run([sys.executable, "-m", "piper", "-m", str(voice), "--length-scale", str(speed), "-f", str(wav)], input=text.encode(), capture_output=True)
    return wav


def still(name, png, wav):
    mp4 = OUT / f"seg_{name}.mp4"
    run(["ffmpeg", "-y", "-loglevel", "error", "-loop", "1", "-i", str(png), "-i", str(wav), "-t", f"{dur(wav) + 0.8:.2f}",
         "-vf", "format=yuv420p", "-r", "30", "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", "-ar", "44100", "-ac", "2", "-af", "apad", str(mp4)])
    return mp4


def record_request(name, utterance):
    """Record one real request; return the video and the timeline of when it was sent and answered."""
    from playwright.sync_api import sync_playwright
    vdir = OUT / f"rec_{name}"
    vdir.mkdir(exist_ok=True)
    for f in vdir.glob("*.webm"):
        f.unlink()
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=BROWSER)
        ctx = b.new_context(viewport={"width": W, "height": H}, record_video_dir=str(vdir), record_video_size={"width": W, "height": H})
        pg = ctx.new_page()
        t0 = time.monotonic()
        pg.goto(URL)
        pg.wait_for_timeout(900)
        pg.locator("#q").press_sequentially(utterance, delay=35)
        t_sent = time.monotonic() - t0
        pg.locator("#q").press("Enter")
        pg.wait_for_function("!document.getElementById('screen').className.includes('thinking') && document.getElementById('say').textContent !== 'Thinking…'", timeout=180_000)
        t_answer = time.monotonic() - t0
        speech = pg.locator("#say").inner_text()
        calls = pg.locator("#trace").inner_text()
        pg.wait_for_timeout(9000)
        ctx.close()
        b.close()
    return next(vdir.glob("*.webm")), t_sent, t_answer, speech, calls


def request_segment(name, utterance):
    video, t_sent, t_answer, speech, calls = record_request(name, utterance)
    (OUT / f"{name}.json").write_text(json.dumps({"utterance": utterance, "speech": speech, "calls": calls,
                                                  "agent_seconds": round(t_answer - t_sent, 1)}, indent=1))
    ask = tts(f"{name}_user", utterance.replace("Alexa, ", "Alexa... "), USER)
    answer = tts(f"{name}_alexa", speech)
    keep = t_sent + 1.5                      # typing, then the first moments of thinking at normal speed
    fast = (t_answer - 0.3) - keep           # agent time, sped up
    rate = 8.0
    tail = dur(answer) + 1.5                 # answer on screen while Alexa speaks
    label = f"agent + MCP tools working ({t_answer - t_sent:.0f} s, shown 8x faster)"
    mp4 = OUT / f"seg_{name}.mp4"
    t_ans_out = keep + fast / rate
    run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(video), "-i", str(ask), "-i", str(answer), "-filter_complex",
         f"[0:v]trim=0:{keep:.2f},setpts=PTS-STARTPTS[a];"
         f"[0:v]trim={keep:.2f}:{keep + fast:.2f},setpts=(PTS-STARTPTS)/{rate},"
         f"drawtext=text='{label}':x=(w-tw)/2:y=h-46:fontsize=22:fontcolor=white:box=1:boxcolor=0x000000AA:boxborderw=10[b];"
         f"[0:v]trim={keep + fast:.2f}:{keep + fast + tail:.2f},setpts=PTS-STARTPTS[c];"
         f"[a][b][c]concat=n=3:v=1:a=0,fps=30,format=yuv420p[v];"
         f"[1:a]adelay=0|0[u];[2:a]adelay={int(t_ans_out * 1000)}|{int(t_ans_out * 1000)}[x];[u][x]amix=inputs=2:normalize=0,apad[au]",
         "-map", "[v]", "-map", "[au]", "-t", f"{t_ans_out + tail:.2f}", "-c:v", "libx264", "-preset", "veryfast",
         "-c:a", "aac", "-ar", "44100", "-ac", "2", str(mp4)])
    return mp4


def main():
    OUT.mkdir(exist_ok=True)
    segs = [
        still("intro", shot("s_intro", "<span class='tag'>Amazon Developer Hackathon · Alexa+ track</span><h1>Contest Coach</h1>"
                            "<p>An MCP server that turns Alexa+ into a coach for competitive programmers.</p>"
                            "<p class='m'>Live Codeforces and LeetCode data · MCP spec 2025-11-25 · Streamable HTTP · open source</p>"),
              tts("intro", "Contest Coach is a self-hosted M C P server that turns Alexa plus into a coach for competitive programmers. "
                           "It uses live Codeforces and LeetCode data, and speaks the latest M C P spec over streamable H T T P.")),
        still("how", shot("s_how", "<h2>How it works</h2><div class='flow'><div class='box'>Your voice</div><span class='arrow'>→</span>"
                          "<div class='box'>Alexa+ agent<br><span class='m' style='font-size:18px'>(simulated: GitHub Copilot CLI)</span></div><span class='arrow'>→</span>"
                          "<div class='box'>Contest Coach<br><span class='m' style='font-size:18px'>MCP · Streamable HTTP</span></div><span class='arrow'>→</span>"
                          "<div class='box'>Codeforces + LeetCode APIs</div></div>"
                          "<p>Five read-only tools: upcoming_contests, my_ratings, weak_topics, practice_problems, daily_plan.</p>"
                          "<p class='m'>Each tool returns one sentence to say aloud and structured data for the screen.</p>"),
              tts("how", "Here's the flow. You speak. The agent decides which tools to call. Contest Coach answers with one sentence to say aloud, "
                         "plus structured data for the screen. Everything you'll see next is a real, unedited request, with only the waiting time sped up.")),
        request_segment("r1", "Alexa, when's the next contest, and how did my last one go?"),
        request_segment("r2", "Alexa, what am I weak at?"),
        request_segment("r3", "Alexa, give me two binary search problems to practice."),
        still("proof", shot("s_proof", "<h2>It's a real MCP server</h2><pre>"
                            "$ npx tsx test/client.ts\nprotocol 2025-11-25   server contest-coach 1.0.0\n"
                            "tools: upcoming_contests, my_ratings, weak_topics, practice_problems, daily_plan\n\n"
                            "▶ weak_topics → structuredContent\n  { rating: 1799, band: [1500, 2100],\n    topics: [binary search, data structures, implementation] }</pre>"
                            "<p class='m'>Stateless Streamable HTTP · outputSchema on every tool · readOnlyHint · a coach_me prompt</p>"),
              tts("proof", "Under the hood it's a standard M C P server: protocol version twenty twenty-five, eleven, twenty-five, stateless streamable H T T P, "
                           "an output schema on every tool, and read-only hints, so any M C P client, including Alexa plus, can use it.")),
        still("outro", shot("s_outro", "<h1>Contest Coach</h1><p>Practice what you're actually weak at, not what you already know.</p>"
                            "<p class='m'>github.com/JayPokale/contest-coach-mcp · MIT</p>"),
              tts("outro", "Contest Coach. Practice what you're actually weak at, not what you already know. The code is open source on GitHub.")),
    ]
    lst = OUT / "list.txt"
    lst.write_text("".join(f"file '{s}'\n" for s in segs))
    final = OUT / "contest_coach_demo.mp4"
    run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", str(final)])
    print(final, f"{dur(final):.1f}s")


if __name__ == "__main__":
    main()
