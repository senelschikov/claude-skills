// Pure, no IO.

export const MODES = ['edit', 'heredoc', 'commit', 'post'] as const
export type Mode = (typeof MODES)[number]
export const BUCKETS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000]
export const INJ = ['short', 'deny', 'post', 'soft', 'retry', 'stats'] as const
export type Inj = (typeof INJ)[number]
export const FIELDS = ['calls', 'checks', 'deny', 'first', 'cap', 'resub', 'soft', 'fixed', 'prevLines', 'prevChars'] as const
export type Field = (typeof FIELDS)[number]
export type Counter = Record<Field, number> & { lat: number[] }
export type Session = { t: number; m: Record<Mode, Counter>; inj: Record<Inj, number> }

const zeros = <K extends string>(keys: readonly K[]): Record<K, number> => Object.fromEntries(keys.map(k => [k, 0])) as Record<K, number>
const counter = (): Counter => ({ ...zeros(FIELDS), lat: new Array<number>(BUCKETS.length + 1).fill(0) })

export function fresh(t: number): Session {
  return { t, m: Object.fromEntries(MODES.map(m => [m, counter()])) as Record<Mode, Counter>, inj: zeros(INJ) }
}

export const total = (s: Session, f: Field): number => MODES.reduce((n, m) => n + s.m[m][f], 0)
export const injected = (s: Session): number => INJ.reduce((n, k) => n + s.inj[k], 0)
export const projectOf = (key: string): string => key.split('\t')[0]

/** A stored value of any age, filled up to the current shape. */
export function coerce(raw: unknown): Session {
  const s = fresh(0)
  if (!raw || typeof raw !== 'object') return s
  const r = raw as Partial<Session>
  s.t = typeof r.t === 'number' ? r.t : 0
  for (const mode of MODES) {
    const c = r.m?.[mode]
    if (!c) continue
    for (const f of FIELDS) s.m[mode][f] = Number(c[f] ?? 0)
    if (Array.isArray(c.lat)) c.lat.slice(0, BUCKETS.length + 1).forEach((n, i) => (s.m[mode].lat[i] = Number(n ?? 0)))
  }
  for (const k of INJ) s.inj[k] = Number(r.inj?.[k] ?? 0)
  return s
}

export function bump(s: Session, mode: Mode, field: Field, n = 1): void {
  s.m[mode][field] += n
}

export function inject(s: Session, kind: Inj, chars: number): void {
  s.inj[kind] += chars
}

export function latency(s: Session, mode: Mode, ms: number): void {
  const i = BUCKETS.findIndex(edge => ms <= edge)
  s.m[mode].lat[i === -1 ? BUCKETS.length : i]++
}

/** Upper edge of the bucket holding the p-th percentile, Infinity past the last edge, NaN when empty. */
export function percentile(lat: readonly number[], p: number): number {
  const total = lat.reduce((a, b) => a + b, 0)
  if (!total) return NaN
  const target = Math.ceil((p / 100) * total)
  let seen = 0
  for (let i = 0; i < lat.length; i++) {
    seen += lat[i]
    if (seen >= target) return i < BUCKETS.length ? BUCKETS[i] : Infinity
  }
  return Infinity
}

export function merge(list: readonly Session[]): Session {
  const out = fresh(0)
  for (const s of list) {
    out.t = Math.max(out.t, s.t)
    for (const mode of MODES) {
      for (const f of FIELDS) out.m[mode][f] += s.m[mode][f]
      s.m[mode].lat.forEach((n, i) => (out.m[mode].lat[i] += n))
    }
    for (const k of INJ) out.inj[k] += s.inj[k]
  }
  return out
}

export const tokens = (chars: number): number => Math.ceil(chars / 4)

const pct = (a: number, b: number): string => (b ? `${Math.round((100 * a) / b)}%` : '-')
const ms = (v: number): string => (Number.isNaN(v) ? '-' : v === Infinity ? `>${BUCKETS[BUCKETS.length - 1]}` : `${v}`)

/** One compact line: checks, deny, fixed and the net token estimate of a slice. */
function brief(name: string, s: Session): string {
  const net = tokens(total(s, 'prevChars')) - tokens(injected(s))
  return `${name}: checks ${total(s, 'checks')}, deny ${total(s, 'deny')}, fixed ${total(s, 'fixed')}, net ~${net} tokens`
}

export type View = { total: Session; main: Session; sub: Session; projects: [string, Session][]; current: Session; sessions: number; project?: string }

export function renderStats(v: View): string {
  const s = v.total
  const head = ['mode', 'calls', 'checks', 'deny', 'first', 'cap', 'resub', 'resub%', 'soft', 'fixed', 'open', 'p50', 'p90']
  const rows = MODES.map(mode => {
    const c = s.m[mode]
    const ratio = c.first ? c.resub / c.first : 0
    return [mode, c.calls, c.checks, c.deny, c.first, c.cap, c.resub, pct(c.resub, c.first) + (ratio > 0.2 ? '!' : ''),
      c.soft, c.fixed, Math.max(0, c.deny - c.fixed - c.resub), ms(percentile(c.lat, 50)), ms(percentile(c.lat, 90))].map(String)
  })
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)))
  const line = (r: string[]) => r.map((v, i) => (i ? v.padStart(widths[i]) : v.padEnd(widths[i]))).join('  ')
  const prevLines = total(s, 'prevLines')
  const saved = tokens(total(s, 'prevChars'))
  const spent = tokens(injected(s))
  const breakEven = saved ? Math.ceil(spent / saved) : NaN
  return [
    `comment-guard stats${v.project ? ` for project ${v.project}` : ''}, ${v.sessions} session(s) plus archive; p50/p90 in ms of the guard's own time`,
    line(head),
    ...rows.map(line),
    `resub% = resub/first, "!" past 20% means the resubmission route is abused; open = deny - fixed - resub`,
    `cost: ~${spent} tokens injected (${INJ.map(k => `${k} ${tokens(s.inj[k])}`).join(', ')})`,
    `savings, ESTIMATE: ~${saved} tokens from ${prevLines} comment lines not written (counted once)`,
    `net: ~${saved - spent} tokens, rewrite estimated as retry; ` +
      (Number.isNaN(breakEven) ? 'nothing prevented yet' : `break-even after ${breakEven} future read(s) of those files`),
    brief('main agent', v.main),
    brief('subagents', v.sub),
    ...(v.project ? [] : v.projects.slice(0, 5).map(([name, p]) => brief(`project ${name}`, p))),
    brief('current session', v.current),
  ].join('\n')
}

export const SESSION_PREFIX = 's:'
export const ARCHIVE_KEY = 'archive'
export const ARCHIVE_AFTER_MS = 30 * 86_400_000

export type Origin = 'main' | 'sub'
export type Stored = { t: number; by: Record<string, Session> }
export const dim = (project: string, origin: Origin): string => `${project}\t${origin}`

/** A stored value of any shape; a pre-dimension value counts as project "?" of the main agent. */
export function coerceStored(raw: unknown): Stored {
  const r = (raw && typeof raw === 'object' ? raw : {}) as { t?: number; by?: Record<string, unknown>; m?: unknown }
  const t = typeof r.t === 'number' ? r.t : 0
  if (r.by && typeof r.by === 'object') return { t, by: Object.fromEntries(Object.entries(r.by).map(([k, v]) => [k, coerce(v)])) }
  return { t, by: r.m ? { [dim('?', 'main')]: coerce(raw) } : {} }
}

export function cell(st: Stored, key: string): Session {
  return (st.by[key] ??= fresh(st.t))
}

export function mergeStored(list: readonly Stored[]): Stored {
  const out: Stored = { t: 0, by: {} }
  for (const st of list) {
    out.t = Math.max(out.t, st.t)
    for (const [k, s] of Object.entries(st.by)) out.by[k] = merge([out.by[k] ?? fresh(0), s])
  }
  return out
}

/** Totals, origin split and projects by checks, optionally filtered to one project. */
export function view(all: Stored, current: Stored, sessions: number, project?: string): View {
  const pick = (st: Stored) => Object.entries(st.by).filter(([k]) => !project || projectOf(k) === project)
  const rows = pick(all)
  const byProject = new Map<string, Session[]>()
  for (const [k, s] of rows) {
    const list = byProject.get(projectOf(k))
    if (list) list.push(s)
    else byProject.set(projectOf(k), [s])
  }
  const checks = (s: Session) => total(s, 'checks')
  return {
    total: merge(rows.map(([, s]) => s)),
    main: merge(rows.filter(([k]) => k.endsWith('\tmain')).map(([, s]) => s)),
    sub: merge(rows.filter(([k]) => k.endsWith('\tsub')).map(([, s]) => s)),
    projects: [...byProject].map(([name, list]) => [name, merge(list)] as [string, Session]).sort((a, b) => checks(b[1]) - checks(a[1])),
    current: merge(pick(current).map(([, s]) => s)),
    sessions,
    project,
  }
}
