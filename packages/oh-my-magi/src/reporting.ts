import path from "node:path"
import { appendFile, rename } from "node:fs/promises"
import { ensureDirectory } from "./fs"
import { redact } from "./context"
import type { MagiRuntimeState } from "./state"

const writes = new Map<string, Promise<unknown>>()
export async function serializeReport<T>(directory: string, action: () => Promise<T>): Promise<T> {
  const key = path.resolve(directory)
  const pending = (writes.get(key) ?? Promise.resolve()).catch(() => undefined).then(action)
  writes.set(key, pending)
  try {
    return await pending
  } finally {
    if (writes.get(key) === pending) writes.delete(key)
  }
}

export async function appendReport(directory: string, filename: string, content: string) {
  await serializeReport(directory, async () => {
    const file = path.join(directory, ".magi", filename)
    await ensureDirectory(path.dirname(file))
    await appendFile(file, redact(content), "utf8")
  })
}

const escape = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")

export async function publishReport(directory: string, state: MagiRuntimeState, archive = false) {
  const timestamp = new Date().toISOString()
  const summary = redact(
    [
      "# Magi progress report",
      "",
      "Updated: " + timestamp,
      "Goal: " + (state.goal ?? "No goal started"),
      `State: ${state.loopActive ? "active" : "stopped"} / ${state.status} · Cycle ${state.currentCycle} · No iteration limit`,
      "Current work: " + state.topic,
      "Owner session: " + (state.sessionID ?? "none"),
      "Tool operations (cumulative): " + (state.telemetry?.toolCallCount ?? 0),
      "Last tool activity: " +
        (state.telemetry?.toolCallCount ? new Date(state.telemetry.lastActiveAt).toISOString() : "none"),
      state.error ? "Runtime issue (will retry while active): " + state.error : "",
      state.meeting ? "Meeting round: " + state.meeting.round + " (no round limit)" : "",
      state.retryAt ? "Next retry: " + new Date(state.retryAt).toISOString() : "",
      "",
      "## Pending user guidance",
      ...(state.steeringQueue ?? []).map((item) => "- " + item.text),
      "",
      "## Latest council and execution events",
      ...state.events
        .slice(-12)
        .map((event) => `- ${new Date(event.time).toISOString()} ${event.title}: ${event.text}`),
      "",
      "## Workforce telemetry (automatic observations, not LLM judgments)",
      ...(state.observations ?? []).slice(-6).map((item) => "- " + item.observation),
      "",
      "## Intervention",
      "Guide Magi by talking normally in the OpenCode session running this goal. Controls: /magi status · /magi stop · /magi resume",
      "Meeting history: COUNCIL.md · Memory: MEMORY.md · User history: USER-GUIDANCE.md · Roadmap: ROADMAP.md · Periodic history: reports/",
      "Reports refresh while the OpenCode server is alive. Check the timestamp to detect a stopped host.",
    ]
      .filter(Boolean)
      .join("\n\n"),
  )
  const clean = (text: string) => escape(redact(text))
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta http-equiv="refresh" content="15"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Magi — Goal monitor</title>
<style>*{box-sizing:border-box}body{font:16px/1.6 system-ui;background:#0e1721;color:#e3eaf2;max-width:1100px;margin:32px auto;padding:0 24px}h1{font-size:36px;margin:8px 0}h2{font-size:20px}a{color:#a1d3ff}nav{display:flex;flex-wrap:wrap;gap:20px;margin:24px 0}.muted,small{color:#a8bace}.hero,.card,details{background:#182534;border:1px solid #2b3e51;border-radius:12px;padding:20px;margin:12px 0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px}.number{font-size:26px;font-weight:650}.badge{color:#9ee9c4}.error{border-left:4px solid #ffbb79}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:14px/1.6 ui-monospace,monospace}summary{cursor:pointer;font-weight:600}code{color:#c2e1ff}li{margin:8px 0;overflow-wrap:anywhere}footer{margin-top:32px;font-size:13px;color:#a8bace}</style>
<header><small>OH-MY-MAGI / OMO WORKFORCE</small><h1>One goal. Continuous progress.</h1><span class="badge">${state.loopActive ? "● Active" : "○ Stopped"}</span> · Updated ${timestamp}</header>
<nav><a href="COUNCIL.md">Council minutes</a><a href="ROADMAP.md">Roadmap</a><a href="STATUS.md">Full status</a><a href="reports/">Report archive</a></nav>
<section class="hero"><small>PERSISTENT GOAL</small><h2>${clean(state.goal ?? "No goal started")}</h2><p>${clean(state.topic)}</p></section>
<div class="grid"><div class="card"><small>CYCLE</small><div class="number">${state.currentCycle}</div>No iteration limit</div><div class="card"><small>WORKFORCE OPERATIONS</small><div class="number">${state.telemetry?.toolCallCount ?? 0}</div>Cumulative tool activity</div><div class="card"><small>CURRENT PHASE</small><div class="number">${state.awaitingExecution ? "Execution" : clean(state.status)}</div>${state.awaitingExecution ? "Awaiting independent verification" : "Council and goal management"}</div></div>
${state.error ? `<div class="card error"><h2>Needs attention</h2><p>${clean(state.error)}</p><small>${state.loopActive ? "The controller will retry. You can provide guidance below." : "Resume when ready."}</small></div>` : ""}
<h2>Council votes</h2><div class="grid">${["melchior", "balthasar", "casper"].map((member) => `<div class="card"><small>${member.toUpperCase()}</small><div class="number">${clean(state.votes[member as keyof typeof state.votes] ?? "Pending")}</div></div>`).join("")}</div>
<h2>Latest decisions and results</h2>${state.events
    .slice(-8)
    .toReversed()
    .map(
      (event) =>
        `<details><summary>${clean(event.title)}</summary><small>${new Date(event.time).toISOString()}</small><pre>${clean(event.text)}</pre></details>`,
    )
    .join("")}
<section class="card"><h2>Workforce activity</h2><small>Automatic telemetry. Council judgments appear in the meeting minutes.</small><ul>${
    (state.observations ?? [])
      .slice(-4)
      .map((item) => `<li>${clean(item.observation)}</li>`)
      .join("") || "<li>No tool activity recorded yet.</li>"
  }</ul></section>
<section class="card"><h2>Talk to Magi</h2><p>Talk normally in the OpenCode session running this goal. Your guidance goes to the next council meeting. Questions remain questions.</p><pre>Prioritize reproducibility before new experiments.\nWhy did you choose this approach?</pre><p>Controls: /magi status · /magi stop · /magi resume</p><h3>Pending conversation &amp; guidance</h3><ul>${(state.steeringQueue ?? []).map((item) => `<li>${clean(item.text)}</li>`).join("") || "<li>No pending guidance.</li>"}</ul></section>
<footer>Refreshes every 15 seconds while the OpenCode server is alive. A stale timestamp means reporting has stopped. Decisions and reports remain in .magi/. This local page does not send commands or data to external services.</footer></html>`
  await serializeReport(directory, async () => {
    await ensureDirectory(path.join(directory, ".magi"))
    for (const [name, content] of [
      ["STATUS.md", summary],
      ["index.html", html],
    ]) {
      const target = path.join(directory, ".magi", name!)
      const temporary = target + "." + crypto.randomUUID() + ".tmp"
      await Bun.write(temporary, content!)
      await rename(temporary, target)
    }
    if (archive) {
      await ensureDirectory(path.join(directory, ".magi", "reports"))
      await appendFile(
        path.join(directory, ".magi", "reports", timestamp.slice(0, 10) + ".md"),
        summary + "\n\n---\n\n",
        "utf8",
      )
    }
  })
}
