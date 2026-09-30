import { Database } from "bun:sqlite"
import { mkdirSync, realpathSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import type { Job, Report, State } from "./types"

export function dataDirectory(
  directory: string,
  home = process.env.OPENMAGI_HOME ||
    path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share"), "oh-my-openmagi"),
) {
  const canonical = realpathSync(directory)
  const key = new Bun.CryptoHasher("sha256")
    .update(process.platform === "win32" ? canonical.toLowerCase() : canonical)
    .digest("hex")
  return path.join(home, key)
}

export class Store {
  readonly db: Database
  readonly directory: string
  readonly home: string
  constructor(directory: string, home?: string) {
    this.directory = realpathSync(directory)
    this.home = dataDirectory(directory, home)
    mkdirSync(this.home, { recursive: true, mode: 0o700 })
    this.db = new Database(path.join(this.home, "runtime.sqlite"), { create: true, strict: true })
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;")
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS job_sessions (session TEXT PRIMARY KEY, json TEXT NOT NULL);
      INSERT OR IGNORE INTO job_sessions SELECT json_extract(json, '$.session'), json FROM jobs WHERE json_extract(json, '$.session') IS NOT NULL;
      CREATE TABLE IF NOT EXISTS meetings (id TEXT PRIMARY KEY, time INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS meeting_time ON meetings(time);
      CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, time INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS controls (id TEXT PRIMARY KEY, time INTEGER NOT NULL, text TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS leases (name TEXT PRIMARY KEY, token TEXT NOT NULL, until_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS jobs_session ON jobs(json_extract(json, '$.session'));
      CREATE INDEX IF NOT EXISTS jobs_status ON jobs(json_extract(json, '$.status'));
      CREATE INDEX IF NOT EXISTS report_pending ON reports(json_extract(json, '$.delivered'));
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, time INTEGER NOT NULL, kind TEXT NOT NULL, json TEXT NOT NULL);
    `)
    this.db.query("INSERT OR IGNORE INTO state VALUES (1, ?)").run(
      JSON.stringify({
        schema: 1,
        revision: 0,
        desiredState: "stopped",
        phase: "stopped",
        generation: crypto.randomUUID(),
        goal: "",
        cycle: 1,
        round: 1,
        topic: "",
        opening: {},
        votes: {},
        guidance: [],
        progress: [],
        failures: 0,
        heartbeatAt: 0,
        updatedAt: Date.now(),
        reporting: { intervalMs: 3600000, manual: false },
      } satisfies State),
    )
  }
  read(): State {
    return JSON.parse(this.db.query<{ json: string }, []>("SELECT json FROM state WHERE id=1").get()!.json)
  }
  update(change: (state: State) => State, generation?: string) {
    return this.db
      .transaction(() => {
        const state = this.read()
        if (generation && state.generation !== generation) return state
        const next = change(state)
        next.revision = state.revision + 1
        next.updatedAt = Date.now()
        this.db.query("UPDATE state SET json=? WHERE id=1").run(JSON.stringify(next))
        return next
      })
      .immediate()
  }
  job(id: string): Job | undefined {
    const row = this.db.query<{ json: string }, [string]>("SELECT json FROM jobs WHERE id=?").get(id)
    return row ? JSON.parse(row.json) : undefined
  }
  jobs(active = false): Job[] {
    return this.db
      .query<{ json: string }, []>(
        active
          ? `SELECT json FROM jobs WHERE json_extract(json, '$.status') IN ('prepared', 'running')`
          : "SELECT json FROM jobs",
      )
      .all()
      .map((row) => JSON.parse(row.json))
  }
  sessionJob(session: string): Job | undefined {
    const row = this.db.query<{ json: string }, [string]>("SELECT json FROM job_sessions WHERE session=?").get(session)
    return row ? JSON.parse(row.json) : undefined
  }
  saveJob(job: Job) {
    this.db
      .transaction(() => {
        this.db.query("INSERT OR REPLACE INTO jobs VALUES (?, ?)").run(job.id, JSON.stringify(job))
        if (job.session)
          this.db.query("INSERT OR REPLACE INTO job_sessions VALUES (?, ?)").run(job.session, JSON.stringify(job))
      })
      .immediate()
  }
  owns(session: string) {
    return this.jobs().some((job) => job.session === session) || this.read().owner === session
  }
  meeting(id: string, time: number, record: unknown) {
    this.db.query("INSERT OR IGNORE INTO meetings VALUES (?, ?, ?)").run(id, time, JSON.stringify(record))
  }
  meetings(from = 0, until = Number.MAX_SAFE_INTEGER): { id: string; time: number; state: State }[] {
    return this.db
      .query<{ id: string; time: number; json: string }, [number, number]>(
        "SELECT * FROM meetings WHERE time>=? AND time<? ORDER BY time, id",
      )
      .all(from, until)
      .map((row) => ({ id: row.id, time: row.time, state: JSON.parse(row.json) }))
  }
  recentMeetings(limit = 200): { id: string; time: number; state: State }[] {
    return this.db
      .query<{ id: string; time: number; json: string }, [number]>(
        "SELECT * FROM meetings ORDER BY time DESC, id DESC LIMIT ?",
      )
      .all(limit)
      .reverse()
      .map((row) => ({ id: row.id, time: row.time, state: JSON.parse(row.json) }))
  }
  meetingDays() {
    return this.db
      .query<{ day: string }, []>(
        "SELECT DISTINCT strftime('%Y-%m-%d', time / 1000, 'unixepoch') AS day FROM meetings ORDER BY day",
      )
      .all()
      .map((row) => row.day)
  }
  report(report: Report) {
    this.db.query("INSERT OR REPLACE INTO reports VALUES (?, ?, ?)").run(report.id, report.time, JSON.stringify(report))
  }
  reports(pending = false): Report[] {
    return this.db
      .query<{ json: string }, []>(
        pending
          ? `SELECT json FROM reports WHERE json_extract(json, '$.delivered')=0 AND coalesce(json_extract(json, '$.superseded'), 0)=0 ORDER BY time, id`
          : "SELECT json FROM reports ORDER BY time, id",
      )
      .all()
      .map((row) => JSON.parse(row.json))
  }
  reportFiles(): Report[] {
    return this.db
      .query<{ json: string }, []>(
        "SELECT json FROM reports WHERE coalesce(json_extract(json, '$.projected'), 0)=0 ORDER BY time, id",
      )
      .all()
      .map((row) => JSON.parse(row.json))
  }
  latestReport(): Report | undefined {
    const row = this.db
      .query<{ json: string }, []>("SELECT json FROM reports ORDER BY time DESC, id DESC LIMIT 1")
      .get()
    return row ? JSON.parse(row.json) : undefined
  }
  updateReport(id: string, change: Partial<Report>) {
    this.db
      .transaction(() => {
        const row = this.db.query<{ json: string }, [string]>("SELECT json FROM reports WHERE id=?").get(id)
        if (row) this.report({ ...JSON.parse(row.json), ...change })
      })
      .immediate()
  }
  control(id: string, text: string) {
    return this.db.query("INSERT OR IGNORE INTO controls VALUES (?, ?, ?)").run(id, Date.now(), text).changes > 0
  }
  audit(kind: string, record: unknown) {
    this.db.query("INSERT INTO audit(time, kind, json) VALUES (?, ?, ?)").run(Date.now(), kind, JSON.stringify(record))
  }
  lease(name: string, token: string, now = Date.now(), duration = 30000) {
    return this.db
      .transaction(() => {
        const row = this.db
          .query<{ token: string; until_at: number }, [string]>("SELECT token, until_at FROM leases WHERE name=?")
          .get(name)
        if (row && row.token !== token && row.until_at > now) return false
        this.db.query("INSERT OR REPLACE INTO leases VALUES (?, ?, ?)").run(name, token, now + duration)
        return true
      })
      .immediate()
  }
  release(name: string, token: string) {
    this.db.query("DELETE FROM leases WHERE name=? AND token=?").run(name, token)
  }
  close() {
    this.db.close()
  }
}
