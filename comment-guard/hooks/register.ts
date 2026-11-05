import { atom, read, update } from 'claude-code'
import type {
  ClassicEventOf, ClassicResultOf, EngineInterface, Register, SessionEndInput, SessionEndResult, ToolCallInput, ToolCallResult,
} from 'claude-code'

import type { CommentGuardDenied } from '../types'
import {
  addedOf, addedVs, basename, bodyVerdict, dirname, fold, heredocTargets, hunks, isAbs, join, judge, judgeEdit, lang, namedTokens, norm, parseCommit, PASSED,
  reason, redirectTargets, resolver, setWindows, slash, WINDOWS,
} from './judge'
import type { AddedRun, Finding, Hunk, Kind, Verdict } from './judge'
import { ARCHIVE_AFTER_MS, ARCHIVE_KEY, bump, cell, coerceStored, dim, inject, latency, mergeStored, renderStats, SESSION_PREFIX, view } from './metrics'
import type { Mode, Origin, Session, Stored } from './metrics'

type $ = EngineInterface
type Stat = { readable: boolean; realPath: string; mtimeMs: number; kind: string }
type Paths = Map<string, Promise<Stat>>
type Located = { finding: Finding; path: string; mode: Mode }
type Pre = { hard: Located[]; soft: (string | Located)[]; added: Map<string, AddedRun[]>; modes: Set<Mode>; paths: Paths; top?: string }
type Next = (e: ToolCallInput) => Promise<ToolCallResult>
type BashCtx = {
  t0: number; top: string | null; cmd: string; pre: Map<string, string>; news: Set<string>; heredocs: Set<string>
  named: Set<string>; before: Map<string, string>
}
type Candidate = { path: string; rel: string; tracked: boolean; before?: string }
type Git = (...a: string[]) => Promise<string>

const APPROVED = atom({ plugin: 'comment-guard', key: 'approved' } as const, [])
const DENIED = atom({ plugin: 'comment-guard', key: 'denied' } as const, {})
const LIVE = atom({ plugin: 'comment-guard', key: 'live' } as const, [])
const LIVE_MS = 60_000
const SAVE_EVERY_MS = 60_000
const MAX_READ = 1 << 20
const MAX_APPROVED = 1000
const MAX_NAMED = 50
const MAX_CANDIDATES = 200
const BULK = 20
const DIFF0 = ['-U0', '--no-color']
const GUIDE = 'skills/comment-style/comment-style.md'
const SKILL = 'skills/comment-style/SKILL.md'
const STATS = 'comment-guard-stats'

let enabled = false
type Env = { HOME: string; PWD?: string; USERPROFILE?: string }
let lazy: { off?: Promise<boolean>; env?: Promise<Env>; guide?: Promise<string>; short?: Promise<string> } = {}

/** Also settles the platform, before any path is read: a session cwd with a drive letter is Windows. */
const off = ($: $): Promise<boolean> => (lazy.off ??= Promise.all([
  $.env.get('CLAUDE_COMMENT_GUARD'),
  $.session.cwd().then(c => setWindows(/^[A-Za-z]:[\\/]/.test(c)), () => undefined),
]).then(([v]) => v === 'off'))
const envVars = ($: $) => (lazy.env ??= Promise.all([$.env.get('HOME'), $.env.get('PWD'), $.env.get('USERPROFILE')])
  .then(([HOME, PWD, USERPROFILE]): Env => ({ HOME: slash(HOME ?? USERPROFILE ?? '/'), PWD, ...(USERPROFILE ? { USERPROFILE: slash(USERPROFILE) } : {}) })))
const lf = (t: string): string => t.replace(/\r\n/g, '\n')
const guide = ($: $): Promise<string> => (lazy.guide ??= readText($, join($.plugin.root, GUIDE)).then(lf))
const shortForm = ($: $): Promise<string> =>
  (lazy.short ??= readText($, join($.plugin.root, SKILL)).then(t => lf(t).split('\n\n').find(p => p.startsWith('Short form')) ?? ''))
let stats: { key: string; st: Stored; project: string } | undefined
let lastSave = 0
const dirTops = new Map<string, string | null>()

async function readText($: $, path: string): Promise<string> {
  const text = await $.fs.read(path).catch(() => '')
  return typeof text === 'string' ? text : ''
}

async function readBytes($: $, path: string): Promise<Uint8Array | null> {
  const r = await $.fs.read(path, { as: 'bytes' }).catch(() => null)
  return r && typeof r !== 'string' ? Uint8Array.fromBase64(r.base64) : null
}

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)
const hex = (buf: ArrayBuffer): string => new Uint8Array(buf).toHex()
const sha256 = async (text: string): Promise<string> => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
/** Content hash blind to CRLF, so a Windows checkout compares equal to `git show`. */
const hashText = (text: string): Promise<string> => sha256(lf(text))

/** git's blob id, computed here: one `git hash-object` process costs more than hashing the bytes. */
async function blobId(bytes: Uint8Array): Promise<string> {
  const head = new TextEncoder().encode(`blob ${bytes.length}\0`)
  const data = new Uint8Array(head.length + bytes.length)
  data.set(head)
  data.set(bytes, head.length)
  return hex(await crypto.subtle.digest('SHA-1', data))
}

/** True when path lies under the repo top; with no repo nothing does. */
const inside = (top: string | null, path: string): boolean => top !== null && fold(norm(path)).startsWith(`${fold(norm(top)).replace(/\/$/, '')}/`)

/** The index holds LF blobs where autocrlf checked out CRLF, so on Windows the LF form is tried too. */
async function isCopy(blobs: Set<string>, bytes: Uint8Array): Promise<boolean> {
  if (blobs.has(await blobId(bytes))) return true
  if (!WINDOWS) return false
  const text = decode(bytes)
  return text.includes('\r\n') && blobs.has(await blobId(new TextEncoder().encode(lf(text))))
}

/** A lazy promise for one call's shared lookup. */
const once = <T>(fn: () => Promise<T>): (() => Promise<T>) => {
  let p: Promise<T> | undefined
  return () => (p ??= fn())
}

/** Blob ids and absolute paths of the index, as `ls-files -s` run in dir prints them. */
function parseIndex(listing: string, dir: string): { blobs: Set<string>; paths: Set<string> } {
  const blobs = new Set<string>(), paths = new Set<string>()
  for (const l of listing.split('\n')) {
    const [meta, path] = l.split('\t')
    if (!path) continue
    blobs.add(meta.split(/\s+/)[1])
    paths.add(norm(join(dir, path)))
  }
  return { blobs, paths }
}

async function stat($: $, path: string): Promise<Stat> {
  try {
    const s = await $.fs.stat(path, { resolve: true })
    return { readable: s.kind === 'file' && s.size <= MAX_READ, realPath: slash(s.realPath ?? path), mtimeMs: s.mtimeMs, kind: s.kind }
  } catch {
    return { readable: false, realPath: path, mtimeMs: 0, kind: 'none' }
  }
}

/** One stat per path and phase: the pre phase and the post phase each hold their own Paths. */
function statIn(paths: Paths, $: $, path: string): Promise<Stat> {
  let s = paths.get(path)
  if (!s) paths.set(path, (s = stat($, path)))
  return s
}

const oldText = async ($: $, path: string, s: Stat): Promise<string> => (s.readable && lang(path) ? readText($, path) : '')

async function run($: $, argv: string[], cwd: string): Promise<string> {
  try {
    return (await $.process.run(argv, { cwd, timeoutMs: 5000 })).stdout
  } catch {
    return ''
  }
}

const gitIn = ($: $, dir: string): Git => (...a) => run($, ['git', '-C', dir, ...a], dir)
const cwd = ($: $): Promise<string> => $.session.cwd().then(slash, () => '/')
const abs = async ($: $, p: string): Promise<string> => (isAbs(p) ? slash(p) : join(await cwd($), p))
const newPre = (): Pre => ({ hard: [], soft: [], added: new Map(), modes: new Set(), paths: new Map() })
const softLine = (soft: string[]): string => (soft.length ? `comment-guard: ${soft.join('; ')}` : '')

/** Commit findings bring no soft notes: the model got them when it wrote the file. */
function collect(pre: Pre, v: Verdict, path: string, mode: Mode): void {
  pre.modes.add(mode)
  for (const finding of v.hard) (finding.pass ? pre.soft : pre.hard).push({ finding, path, mode })
  if (mode !== 'commit') pre.soft.push(...v.soft)
  const added = pre.added.get(path)
  if (added) added.push(...v.added)
  else pre.added.set(path, [...v.added])
}

/** Nearest ancestor of dir holding `.git`, cached per dir for the load. */
async function gitTop($: $, dir: string): Promise<string | null> {
  const cached = dirTops.get(dir)
  if (cached !== undefined) return cached
  let top: string | null = null
  for (let d = norm(dir); ; d = dirname(d)) {
    if (await $.fs.exists(join(d, '.git')).catch(() => false)) {
      top = d
      break
    }
    if (dirname(d) === d) break
  }
  dirTops.set(dir, top)
  return top
}

// deny/first/cap/resub count calls, not findings.

/** The cell of this call: project = the git top of the judged path, else of the session cwd. */
async function counters($: $, origin: Origin, top: string | null | undefined, now: number): Promise<Session> {
  if (stats === undefined) {
    const key = SESSION_PREFIX + (await $.session.id().catch(() => 'unknown'))
    const raw = await $.store.get(key).catch(() => undefined)
    const dir = await cwd($)
    stats = { key, st: raw ? coerceStored(raw) : { t: now, by: {} }, project: basename((await gitTop($, dir)) ?? dir) || '/' }
  }
  return cell(stats.st, dim(top ? basename(top) || '/' : stats.project, origin))
}

async function save($: $, now: number): Promise<void> {
  lastSave = now
  if (stats) await $.store.set(stats.key, stats.st).catch(() => undefined)
}

/** Counters reach $.store at most every SAVE_EVERY_MS; only /comment-guard-stats and session end save at once. */
async function saveSoon($: $, now: number): Promise<void> {
  if (now - lastSave >= SAVE_EVERY_MS) await save($, now)
}

/** Credits a deny of this path as fixed when the next write drops the denied run and adds only shorter ones. */
async function creditFixes($: $, s: Session, pre: Pre, skip: Set<string>): Promise<void> {
  if (!pre.added.size) return
  const denied: Record<string, CommentGuardDenied> = await read($, DENIED)
  if (!Object.keys(denied).length) return
  const done: string[] = []
  for (const [path, added] of pre.added) {
    if (skip.has(path)) continue
    const real = (await statIn(pre.paths, $, path)).realPath
    const ph = await sha256(real)
    const d = denied[ph]
    if (!d) continue
    const keys = await Promise.all(added.map(a => sha256(`${real}\0${a.keyText}`)))
    const longest = added.reduce((m, a) => (a.lines > m.lines ? a : m), { lines: 0, chars: 0 })
    if ((d.key && keys.includes(d.key)) || longest.lines >= d.lines) continue
    bump(s, d.mode, 'fixed')
    bump(s, d.mode, 'prevLines', d.lines - longest.lines)
    bump(s, d.mode, 'prevChars', Math.max(0, d.chars - longest.chars))
    done.push(ph)
  }
  if (done.length) await update($, DENIED, d => Object.fromEntries(Object.entries(d).filter(([k]) => !done.includes(k))))
}

/** The one place findings become deny, resubmission pass or soft; a pre deny approves its retry, a post block never does. */
async function settle($: $, s: Session, pre: Pre, approve: boolean, now: number): Promise<{ deny: Finding[]; soft: string[] }> {
  for (const mode of pre.modes) bump(s, mode, 'checks')
  const keyed = await Promise.all(pre.hard.map(async h => {
    const real = (await statIn(pre.paths, $, h.path)).realPath
    return { ...h, real, ph: await sha256(real), key: h.finding.keyText === null ? null : await sha256(`${real}\0${h.finding.keyText}`) }
  }))
  const approved = new Set<string>(keyed.length ? await read($, APPROVED) : [])
  const deny = keyed.filter(h => h.key === null || !approved.has(h.key))
  const resub = keyed.filter(h => h.key !== null && approved.has(h.key))
  for (const mode of new Set(resub.map(h => h.mode))) bump(s, mode, 'resub')
  for (const mode of new Set(deny.map(h => h.mode))) bump(s, mode, 'deny'), bump(s, mode, deny.some(h => h.mode === mode && h.key === null) ? 'cap' : 'first')
  const fresh = deny.flatMap(h => (h.key ? [h.key] : []))
  if (approve && fresh.length) await update($, APPROVED, list => [...list.filter(k => !fresh.includes(k)), ...fresh].slice(-MAX_APPROVED))
  if (deny.length || resub.length) {
    const passed = new Set(resub.map(h => h.ph))
    const marks: Record<string, CommentGuardDenied> = {}
    for (const h of deny) marks[h.ph] = { mode: h.mode, lines: h.finding.runLines, chars: h.finding.chars, t: now, key: h.key }
    await update($, DENIED, d => ({ ...Object.fromEntries(Object.entries(d).filter(([k]) => !passed.has(k))), ...marks }))
  }
  await creditFixes($, s, pre, new Set(keyed.map(h => h.path)))
  const soft = pre.soft.map(x => (typeof x === 'string' ? x : `${x.finding.msg.split('\n')[0]} ${x.finding.pass}`))
  return { deny: deny.map(h => h.finding), soft: [...new Set([...soft, ...resub.map(h => `${h.finding.at} ${PASSED}`)])] }
}

function withContext(ran: ToolCallResult, lines: string[]): ToolCallResult {
  const add = lines.filter(Boolean)
  return ran.deny !== undefined || !add.length ? ran : { ...ran, context: [...(ran.context ?? []), ...add] }
}

async function preEdit($: $, e: ToolCallInput, path: string): Promise<Pre> {
  const pre = newPre()
  if (e.tool !== 'Write' && e.tool !== 'Edit') return pre
  const kind = lang(path, e.tool === 'Write' ? e.content : '')
  if (!kind) return pre
  const s = await statIn(pre.paths, $, path)
  if (e.tool === 'Write') collect(pre, judge(e.content, await oldText($, path, s), kind, basename(path), { newFile: s.kind !== 'file' }), path, 'edit')
  else collect(pre, judgeEdit(s.readable ? await readText($, path) : null, e, kind, basename(path)), path, 'edit')
  return pre
}

/** Each file section of a diff: the path it writes (relative to the repo top) and its text. */
function sections(diff: string): { dst: string; chunk: string }[] {
  return diff.split(/^diff --git /m).slice(1).flatMap(chunk => {
    const dst = /^\+\+\+ b\/(.*)$/m.exec(chunk) ?? /^(?:copy|rename) to (.*)$/m.exec(chunk)
    return dst && !chunk.includes('deleted file mode') ? [{ dst: dst[1], chunk }] : []
  })
}

/** Judges each file of a staged -U0 diff per hunk; returns the files it covered. */
function scan(pre: Pre, diff: string, top: string): Set<string> {
  const files = new Set<string>()
  for (const { dst, chunk } of sections(diff)) {
    files.add(dst)
    const kind = lang(dst)
    if (kind) collect(pre, judge(hunks(chunk), '', kind, dst, { newFile: /new file mode|copy to/.test(chunk) }), join(top, dst), 'commit')
  }
  return files
}

type Added = { f: string; fp: string; kind: Kind; added: string | Hunk[]; newFile: boolean }

/** Files a same-command `git add` names: not yet staged, so judged from one batched diff against HEAD. */
async function addedFiles($: $, pre: Pre, git: Git, repo: string, top: string, todo: string[]): Promise<Added[]> {
  const [listing, diff] = await Promise.all([git('ls-files', '-s'), git('diff', ...DIFF0, 'HEAD', '--', ...todo)])
  const index = parseIndex(listing, repo)
  const byPath = new Map(sections(diff).map(({ dst, chunk }) => [norm(join(top, dst)), chunk]))
  const files = await Promise.all(todo.map(async (f): Promise<Added | null> => {
    const kind = lang(f)
    const fp = join(repo, f)
    if (!kind || !(await statIn(pre.paths, $, fp)).readable) return null
    const bytes = await readBytes($, fp)
    if (!bytes || (await isCopy(index.blobs, bytes))) return null
    const r = addedOf(byPath.get(norm(fp)), decode(bytes), index.paths.has(norm(fp)))
    return r && r.added.length ? { f, fp, kind, ...r } : null
  }))
  return files.filter((x): x is Added => x !== null)
}

async function preCommit($: $, pre: Pre, cmd: string, expand: (p: string) => string, workdir: string): Promise<void> {
  const c = parseCommit(cmd)
  if (!c) return
  pre.modes.add('commit')
  const repo = c.repo ? expand(c.repo) : workdir
  const git = gitIn($, repo)
  const top = await gitTop($, repo)
  if (!top) return
  pre.top = top
  const [cached, unstaged] = await Promise.all([git('diff', '--cached', ...DIFF0, '-C'), c.all ? git('diff', ...DIFF0) : ''])
  const staged = scan(pre, cached, top)
  if (c.all) scan(pre, unstaged, top)
  const todo = c.adds.filter(f => !staged.has(f))
  if (todo.length) for (const x of await addedFiles($, pre, git, repo, top, todo)) collect(pre, judge(x.added, '', x.kind, x.f, { newFile: x.newFile }), x.fp, 'commit')
  if (c.msg !== null) collect(pre, bodyVerdict(c.msg), top, 'commit')
}

async function preBash($: $, cmd: string, now: number): Promise<{ pre: Pre; ctx: BashCtx }> {
  const { expand, workdir } = resolver(cmd, await cwd($), await envVars($))
  const pre = newPre()
  const ctx: BashCtx = { t0: now, top: await gitTop($, workdir), cmd, pre: new Map(), news: new Set(), heredocs: new Set(), named: new Set(), before: new Map() }
  for (const { target, body } of heredocTargets(cmd)) {
    const path = expand(target, workdir)
    ctx.heredocs.add(path)
    const kind = lang(path, body)
    if (!kind) continue
    const s = await statIn(pre.paths, $, path)
    collect(pre, judge(body, await oldText($, path, s), kind, basename(path), { newFile: s.kind !== 'file' }), path, 'heredoc')
  }
  await preCommit($, pre, cmd, expand, workdir)
  for (const t of redirectTargets(cmd)) ctx.news.add(expand(t, workdir))
  const named = [...new Set(namedTokens(cmd).slice(0, MAX_NAMED).map(t => expand(t, workdir)))].filter(p => lang(p))
  for (const path of named) ctx.named.add(path)
  await Promise.all(named.map(async path => {
    const s = await statIn(pre.paths, $, path)
    if (!s.readable) return
    const text = await readText($, path)
    ctx.pre.set(s.realPath, await hashText(text))
    if (!inside(ctx.top, path)) ctx.before.set(path, text)
  }))
  return { pre, ctx }
}

/** Code files the command may have written: new or modified since t0 in the repo, plus redirect targets. */
async function candidates($: $, ctx: BashCtx, paths: Paths): Promise<Candidate[]> {
  const listed = ctx.top ? await gitIn($, ctx.top)('ls-files', '-t', '-m', '-o', '--exclude-standard', '-z') : ''
  const entries = listed.split('\0').filter(Boolean).slice(0, MAX_CANDIDATES).map(e => ({ rel: e.slice(2), path: join(ctx.top ?? '/', e.slice(2)), tracked: e[0] === 'C' }))
  const seen = new Set<string>()
  const outside = [...ctx.named].filter(p => !inside(ctx.top, p)).map(p => ({ rel: basename(p), path: p, tracked: false, before: ctx.before.get(p) }))
  const list = [...entries, ...[...ctx.news].map(n => ({ rel: basename(n), path: n, tracked: false, before: ctx.before.get(n) })), ...outside].filter(c => {
    if (seen.has(c.path) || ctx.heredocs.has(c.path) || !lang(c.path)) return false
    seen.add(c.path)
    return true
  })
  const fresh = await Promise.all(list.map(async c => {
    const s = await statIn(paths, $, c.path)
    return s.readable && s.mtimeMs >= ctx.t0
  }))
  return list.filter((_, i) => fresh[i])
}

type Lazy<T> = () => Promise<T>

async function postJudge($: $, post: Pre, ctx: BashCtx, c: Candidate, chunk: string | undefined, blobs: Lazy<Set<string>>, otherLive: Lazy<boolean>): Promise<Verdict | null> {
  const kind = lang(c.path)
  const bytes = kind ? await readBytes($, c.path) : null
  if (!kind || !bytes) return null
  const text = decode(bytes)
  const real = (await statIn(post.paths, $, c.path)).realPath
  if (ctx.pre.size && [...ctx.pre.values()].includes(await hashText(text))) return null
  const r = c.before !== undefined ? { added: addedVs(c.before, text), newFile: false } : addedOf(chunk, text, c.tracked)
  if (!r || !r.added.length) return null
  const v = judge(r.added, '', kind, c.rel, { newFile: r.newFile })
  if (!v.hard.length) return v
  if (await isCopy(await blobs(), bytes)) return null
  const named = ctx.pre.has(real) || ctx.news.has(c.path) || ctx.cmd.includes(basename(c.path))
  const git = gitIn($, ctx.top ?? '/')
  let why = ''
  if (c.tracked && ctx.pre.has(real) && (await hashText(await git('show', `HEAD:${c.rel}`))) !== ctx.pre.get(real)) why = 'it had uncommitted changes before the command'
  if (!c.tracked && !named) why = 'untracked file the command did not create by name'
  if (!why && !named && (await otherLive())) why = 'another command may have written it'
  if (why) v.hard = v.hard.map(f => ({ ...f, pass: `(not blocked: ${why})` }))
  return v
}

async function afterBash($: $, ctx: BashCtx, ran: ToolCallResult): Promise<{ post: Pre; entered: boolean }> {
  const post = newPre()
  if (ran.deny !== undefined || ran.isReadOnly === true || (ran.result as { backgroundTaskId?: string } | undefined)?.backgroundTaskId) return { post, entered: false }
  let list = await candidates($, ctx, post.paths)
  if (list.length > BULK) list = list.filter(c => ctx.news.has(c.path) || ctx.cmd.includes(basename(c.path)))
  if (!list.length) return { post, entered: true }
  post.modes.add('post')
  const git = gitIn($, ctx.top ?? '/')
  const blobs = once(async () => parseIndex(await git('ls-files', '-s'), ctx.top ?? '/').blobs)
  const otherLive = once(async () => (await read($, LIVE)).some(t => t !== ctx.t0 && t >= ctx.t0 - 1000))
  const tracked = list.filter(c => c.tracked).map(c => c.rel)
  const chunks = new Map(sections(tracked.length ? await git('diff', ...DIFF0, 'HEAD', '--', ...tracked) : '').map(x => [x.dst, x.chunk]))
  const verdicts = await Promise.all(list.map(c => postJudge($, post, ctx, c, chunks.get(c.rel), blobs, otherLive)))
  list.forEach((c, i) => verdicts[i] && collect(post, verdicts[i], c.path, 'post'))
  return { post, entered: true }
}

const payload = (e: ToolCallInput): number =>
  e.tool === 'Write' ? e.content.length : e.tool === 'Edit' ? e.old_string.length + e.new_string.length : e.tool === 'Bash' || e.tool === 'PowerShell' ? e.command.length : 0

async function denyWith($: $, s: Session, e: ToolCallInput, deny: Finding[], mode: Mode, clock: number, now: number): Promise<ToolCallResult> {
  const text = reason(deny, await guide($))
  inject(s, 'deny', text.length)
  inject(s, 'retry', payload(e))
  latency(s, mode, performance.now() - clock)
  await saveSoon($, now)
  return { deny: text }
}

async function finish($: $, ran: ToolCallResult, lines: string[], now: number): Promise<ToolCallResult> {
  await saveSoon($, now)
  return withContext(ran, lines)
}

async function editGuard($: $, e: ToolCallInput, next: Next): Promise<ToolCallResult> {
  if (!enabled || (await off($))) return next(e)
  const now = await $.clock.now()
  const clock = performance.now()
  const path = await abs($, 'file_path' in e ? String(e.file_path) : '')
  const s = await counters($, e.agentId ? 'sub' : 'main', await gitTop($, dirname(path)), now)
  bump(s, 'edit', 'calls')
  const { deny, soft } = await settle($, s, await preEdit($, e, path), true, now)
  if (deny.length) return denyWith($, s, e, deny, 'edit', clock, now)
  const line = softLine(soft)
  if (line) bump(s, 'edit', 'soft'), inject(s, 'soft', line.length)
  latency(s, 'edit', performance.now() - clock)
  return finish($, await next(e), [line], now)
}

async function bashGuard($: $, e: ToolCallInput, next: Next): Promise<ToolCallResult> {
  if (!enabled || (await off($)) || (e.tool !== 'Bash' && e.tool !== 'PowerShell')) return next(e)
  const now = await $.clock.now()
  const clock = performance.now()
  const { pre, ctx } = await preBash($, e.command, now)
  const s = await counters($, e.agentId ? 'sub' : 'main', pre.top ?? ctx.top, now)
  for (const mode of pre.modes) bump(s, mode, 'calls')
  const preMode: Mode = pre.modes.has('commit') ? 'commit' : pre.modes.has('heredoc') ? 'heredoc' : 'post'
  const { deny, soft: preSoft } = await settle($, s, pre, true, now)
  if (deny.length) return denyWith($, s, e, deny, preMode, clock, now)
  const preMs = performance.now() - clock
  await update($, LIVE, l => [...l.filter(t => ctx.t0 - t < LIVE_MS), ctx.t0])
  let ran: ToolCallResult
  try {
    ran = await next(e)
  } finally {
    await update($, LIVE, l => l.filter(t => t !== ctx.t0)).catch(() => undefined)
  }
  const postClock = performance.now()
  const { post, entered } = await afterBash($, ctx, ran)
  if (entered) bump(s, 'post', 'calls')
  const { deny: block, soft: postSoft } = await settle($, s, post, false, now)
  const lines: string[] = []
  if (block.length) lines.push(reason(block, await guide($), true)), inject(s, 'post', lines[0].length)
  const line = softLine([...new Set([...preSoft, ...postSoft])])
  if (line) lines.push(line), bump(s, entered ? 'post' : preMode, 'soft'), inject(s, 'soft', line.length)
  const postMs = entered ? performance.now() - postClock : 0
  latency(s, preMode, preMode === 'post' ? preMs + postMs : preMs)
  if (entered && preMode !== 'post') latency(s, 'post', postMs)
  return finish($, ran, lines, now)
}

type StartEvent = ClassicEventOf['classic.SessionStart']
type StartNext = (e: StartEvent) => Promise<ClassicResultOf['classic.SessionStart']>

async function sessionStart($: $, e: StartEvent, next: StartNext) {
  if (!enabled || (await off($))) return next(e)
  const text = `comment-guard is active. Before writing any code comment, file header, commit or MR text: ${await shortForm($)}\nFull rules: ${join($.plugin.root, GUIDE)}`
  const now = await $.clock.now()
  inject(await counters($, 'main', undefined, now), 'short', text.length)
  const r = await next(e)
  await saveSoon($, now)
  return { ...r, additionalContext: [...(r.additionalContext ?? []), text] }
}

async function sessionEnd($: $, e: SessionEndInput, next: (e: SessionEndInput) => Promise<SessionEndResult>): Promise<SessionEndResult> {
  if (stats) await save($, await $.clock.now()).catch(() => undefined)
  return next(e)
}

/** A guard that fails lets the call through. */
const passThrough = <E, R>(_$: $, e: E, next: (e: E) => R): R => next(e)

async function stored($: $): Promise<{ key: string; s: Stored }[]> {
  const keys = (await $.store.keys()).filter(k => k.startsWith(SESSION_PREFIX))
  return Promise.all(keys.map(async key => ({ key, s: coerceStored(await $.store.get(key)) })))
}

/** Folds sessions older than 30 days into the archive. */
async function prune($: $): Promise<void> {
  const cutoff = (await $.clock.now()) - ARCHIVE_AFTER_MS
  const old = (await stored($)).filter(({ s }) => s.t && s.t < cutoff)
  if (!old.length) return
  await $.store.set(ARCHIVE_KEY, mergeStored([coerceStored(await $.store.get(ARCHIVE_KEY)), ...old.map(o => o.s)]))
  for (const { key } of old) await $.store.delete(key)
}

async function statsCommand($: $, e: { args: string }): Promise<{ text: string }> {
  await off($)
  const now = await $.clock.now()
  const cost = await counters($, 'main', undefined, now)
  const current = stats?.st ?? { t: 0, by: {} }
  const others = (await stored($)).filter(x => x.key !== stats?.key)
  const all = mergeStored([...others.map(x => x.s), current, coerceStored(await $.store.get(ARCHIVE_KEY))])
  const text = renderStats(view(all, current, others.length + 1, e.args.trim() || undefined))
  inject(cost, 'stats', text.length)
  await save($, now)
  return { text }
}

export const register: Register = (on, options) => {
  enabled = options.enabled === true
  lazy = {}
  stats = undefined
  lastSave = 0
  dirTops.clear()
  on('tool.call', { tool: 'Edit' }, editGuard).catch(passThrough)
  on('tool.call', { tool: 'Write' }, editGuard).catch(passThrough)
  on('tool.call', { tool: 'Bash' }, bashGuard).catch(passThrough)
  on('tool.call', { tool: 'PowerShell' }, bashGuard).catch(passThrough)
  on('classic.SessionStart', sessionStart).catch(passThrough)
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: STATS, description: 'comment-guard counters: checks, denies, fixes, latency, token cost' })
    await prune($).catch(() => undefined)
    return next(e)
  })
  on('command.run', { command: STATS }, statsCommand)
  on('session.end', sessionEnd)
}
