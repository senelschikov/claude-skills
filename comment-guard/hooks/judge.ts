// Pure judging logic of comment-guard: no `$`, no IO, so `claude plugin test` covers it.

export const MAX_RUN = 5, MAX_HEADER = 8, MAX_SHARE = 0.25, MIN_ABS = 8, MAX_BODY = 10

export type Kind = { line: readonly string[]; block: readonly [string, string] | null }
export type Hunk = [number, string]
export type Section = 'Code comments' | 'In-file header' | 'Commit message'
export type Finding = { at: string; msg: string; section: Section; capped: boolean; keyText: string | null; runLines: number; chars: number; pass?: string }
export type AddedRun = { lines: number; chars: number; keyText: string }
export type Verdict = { hard: Finding[]; soft: string[]; added: AddedRun[] }

const C: [string, string] = ['/*', '*/']
const SPECS: [readonly string[], [string, string] | null, string][] = [
  [['#'], null, '.yaml .yml .py .sh .bash .zsh .fish .toml .cfg .conf .j2 .vrl .rego .rb .tpl .ps1 .gotmpl .bats .ex .exs .pl .r .nix ' +
    '.cmake .properties .service .timer .mk .tcl .gitignore .dockerignore .helmignore .gitattributes .editorconfig'],
  [['#', '//'], C, '.tf .tfvars .hcl .nomad .php'],
  [['//'], C, '.go .js .mjs .cjs .ts .tsx .jsx .groovy .gradle .java .kt .kts .scala .swift .rs .c .h .cc .cpp .hpp .cs ' +
    '.dart .proto .jsonnet .libsonnet .cue .css .scss .less'],
  [['--'], C, '.sql .lua .hs'],
  [[';', '#'], null, '.ini'],
  [[';'], null, '.el .clj .lisp .asm'],
  [[], ['<!--', '-->'], '.xml .html .htm .xsd .plist'],
]
export const EXT: Record<string, Kind> = {}
for (const [line, block, exts] of SPECS) for (const x of exts.split(/\s+/).filter(Boolean)) EXT[x] = { line, block }
export const HASH_NAMES = new Set(['Dockerfile', 'Containerfile', 'Makefile', 'GNUmakefile', 'Jenkinsfile', 'Vagrantfile', 'Gemfile',
  'Brewfile', 'Procfile', 'Justfile', 'justfile', 'Earthfile', 'CODEOWNERS', 'Tiltfile'])
export const SKIP_PATH = /(^|\/)(docs|\.git)\/|^\/(private\/)?tmp\/|^[A-Z]:\/(Windows\/Temp|Users\/[^/]+\/AppData\/Local\/Temp)\/|(^|\/)(README|CHANGELOG|LICENSE)[^/]*$|\.(md|txt|rst)$/
export const NEVER_COUNT = new RegExp(String.raw`^\s*(#!|# -\*-|#\s*(noqa|nosec|type:|pragma|yamllint|checkov:|tflint-ignore|trivy:|pylint:|shellcheck` +
  String.raw`|(syntax|escape|check)=|yaml-language-server:|@schema|@param)|#\s*--\s|//go:|//\s*nolint|// \+|//\s*eslint-|//\s*@ts-|///\s*<reference)`)
// A semver-like string followed by a fourth octet or /N is an IPv4 or CIDR, not a version.
export const ROT = new RegExp(String.raw`\b\d{4}-\d{2}-\d{2}\b|(?<![\w.])v?\d+\.\d+\.\d+(?![.\d/])` +
  String.raw`|\b[0-9a-f]{7,40}\b(?=.*\b(commit|sha|rev)\b)|\b(as of|currently|since 0\.|was v)\b`, 'i')
const TEMPLATE_OPEN = ['{{/*', '{{- /*']
export const PASSED = 'passed on resubmission; state in one sentence why it stays'

// On Windows paths are kept as `C:/x`: Git Bash `/c/x` and `/cygdrive/c/x` too. On macOS and Linux they pass unchanged.
export let WINDOWS = false
export const setWindows = (on: boolean): void => void (WINDOWS = on)
export const slash = (p: string): string => !WINDOWS ? p
  : p.replace(/\\/g, '/').replace(/^\/(?:cygdrive\/)?([A-Za-z])(?=\/|$)/, '$1:').replace(/^([a-z]):/, (_, d: string) => `${d.toUpperCase()}:`)
const DRIVE = /^[A-Za-z]:(?=\/|$)/
/** The root a path starts with: `/`, `C:/` or none for a relative one. */
const rootOf = (p: string): string => (DRIVE.test(p) ? `${p.slice(0, 2)}/` : p.startsWith('/') ? '/' : '')
export const basename = (p: string): string => slash(p).replace(/\/+$/, '').split('/').pop() ?? ''
export const isAbs = (p: string): boolean => rootOf(slash(p)) !== ''
export const join = (a: string, b: string): string => (isAbs(b) ? slash(b) : `${slash(a).replace(/\/+$/, '')}/${slash(b)}`)
/** The parent; a root is its own parent, so a walk up stops when dirname(d) === d. */
export function dirname(p: string): string {
  const root = rootOf(slash(p)), s = slash(p).replace(/\/+$/, '')
  const i = s.lastIndexOf('/')
  if (i < 0) return root || '.'
  return i < root.length ? root : s.slice(0, i)
}
/** `.` and `..` segments resolved by spelling, so two spellings of one path compare equal. */
export function norm(p: string): string {
  const s = slash(p), root = rootOf(s) || '/'
  const out: string[] = []
  for (const seg of s.slice(DRIVE.test(s) ? 2 : 0).split('/')) {
    if (seg === '..') out.pop()
    else if (seg && seg !== '.') out.push(seg)
  }
  return root + out.join('/')
}
/** Path equality and prefix tests: Windows paths compare case-insensitively. */
export const fold = (p: string): string => (DRIVE.test(p) ? p.toLowerCase() : p)

/** Python's os.path.splitext on a basename: leading dots never start an extension. */
export function extOf(base: string): string {
  const i = base.lastIndexOf('.')
  return i > 0 && /[^.]/.test(base.slice(0, i)) ? base.slice(i) : ''
}

export function splitLines(text: string): string[] {
  const ls = text.split(/\r\n|\r|\n/)
  if (ls.length && ls[ls.length - 1] === '') ls.pop()
  return ls
}

/** Comment syntax of path, or null when it is never judged and so never read. */
export function lang(raw: string, text = ''): Kind | null {
  const path = slash(raw), base = basename(path)
  if (SKIP_PATH.test(path) || base.startsWith('.env')) return null
  const ext = base.startsWith('.') && base.split('.').length === 2 ? base : extOf(base)
  if (ext in EXT) return EXT[ext]
  if (HASH_NAMES.has(base) || /^(Dockerfile|Containerfile)/.test(base) || base.endsWith('.Dockerfile') || text.startsWith('#!')) return EXT['.sh']
  return null
}

type BlockState = { block: string | false }

const OPENERS = new WeakMap<Kind, [string, string][]>()
function openersOf(kind: Kind): [string, string][] {
  let o = OPENERS.get(kind)
  if (!o) OPENERS.set(kind, (o = [...(kind.block ? [[...kind.block] as [string, string]] : []), ...TEMPLATE_OPEN.map(t => [t, '*/'] as [string, string])]))
  return o
}

export function isComment(line: string, kind: Kind, state: BlockState): boolean {
  const s = line.trim()
  if (!s || NEVER_COUNT.test(line)) return false
  if (state.block) {
    if (s.includes(state.block)) state.block = false
    return true
  }
  const opener = openersOf(kind).find(([o]) => s.startsWith(o))
  if (opener) {
    state.block = s.slice(opener[0].length).includes(opener[1]) ? false : opener[1]
    return true
  }
  return kind.line.some(p => s.startsWith(p))
}

export type Runs = { runs: [number, string[]][]; com: number; code: number }

export function runs(text: string, kind: Kind): Runs {
  const out: [number, string[]][] = []
  const state: BlockState = { block: false }
  let cur: string[] = [], start = 0, com = 0, code = 0
  const flush = () => { if (cur.length) out.push([start, cur]); cur = [] }
  splitLines(text).forEach((line, idx) => {
    if (!line.trim()) return state.block ? undefined : flush()
    if (isComment(line, kind, state)) {
      com++
      if (!cur.length) start = idx + 1
      cur.push(line.trimEnd())
    } else {
      code++
      flush()
    }
  })
  flush()
  return { runs: out, com, code }
}

/** First new line and added text per `@@` hunk of a unified diff. */
export function hunks(diff: string): Hunk[] {
  const out: [number, string[]][] = []
  for (const l of splitLines(diff)) {
    const m = /^@@ -\S+ \+(\d+)/.exec(l)
    if (m) out.push([Number(m[1]), []])
    else if (out.length && l.startsWith('+')) out[out.length - 1][1].push(l.slice(1))
  }
  return out.filter(([, ls]) => ls.length).map(([n, ls]) => [n, ls.join('\n')])
}

/** Dice coefficient over the word multisets; stands in for difflib's ratio on a legacy run. */
export function overlap(a: string, b: string): number {
  const la = a.split(/\s+/).filter(Boolean), lb = b.split(/\s+/).filter(Boolean)
  const left = new Map<string, number>()
  for (const l of la) left.set(l, (left.get(l) ?? 0) + 1)
  let common = 0
  for (const l of lb) {
    const n = left.get(l) ?? 0
    if (n > 0) left.set(l, n - 1), common++
  }
  return (2 * common) / (la.length + lb.length)
}

export const normalize = (text: string): string => splitLines(text).filter(l => l.trim()).map(l => l.trim().split(/\s+/).join(' ')).join('\n')

export type JudgeOptions = { newFile?: boolean; scope?: 'all' | 'runs' | 'share' }

const finding = (at: string, msg: string, section: Section, capped: boolean, text: string, runLines: number, chars = text.length): Finding =>
  ({ at, msg, section, capped, keyText: capped ? null : normalize(text), runLines, chars })

type Tally = Runs & { hdr: [number, string[]] | null }

/** Runs and line counts of parts at their file lines; a new file's header run is left out of the comment count. */
function tally(parts: Hunk[], kind: Kind, newFile = false): Tally {
  const t: Tally = { runs: [], com: 0, code: 0, hdr: null }
  for (const [base, text] of parts) {
    const rs = runs(text, kind)
    for (const [start, r] of rs.runs) t.runs.push([base + start - 1, r])
    t.com += rs.com
    t.code += rs.code
    if (newFile && base === 1 && rs.runs.length && splitLines(text).slice(0, rs.runs[0][0] - 1).every(l => !l.trim() || NEVER_COUNT.test(l))) {
      t.hdr = rs.runs[0]
      t.com -= t.hdr[1].length
    }
  }
  return t
}

/** Every over-limit finding of one text or hunk list; the share counts only lines not in old. Approvals are the caller's. */
export function judge(input: string | Hunk[], old: string, kind: Kind, label: string, opts: JudgeOptions = {}): Verdict {
  const scope = opts.scope ?? 'all'
  const parts: Hunk[] = typeof input === 'string' ? [[1, input]] : input
  const v: Verdict = { hard: [], soft: [], added: [] }
  const oldRuns = new Set(old ? runs(old, kind).runs.map(([, r]) => r.join('\n')) : [])
  const all = tally(parts, kind, opts.newFile), hdr = all.hdr
  for (const [start, r] of all.runs) {
    const joined = r.join('\n')
    if (oldRuns.has(joined)) continue
    v.added.push({ lines: r.length, chars: joined.length, keyText: normalize(joined) })
    if (scope === 'share') continue
    const limit = hdr && start === hdr[0] ? MAX_HEADER : MAX_RUN
    if (r.length > limit && oldRuns.size) {
      let best = '', score = -1
      for (const o of oldRuns) {
        const x = overlap(o, joined)
        if (x > score) best = o, score = x
      }
      const len = best.split('\n').length
      if (score >= 0.6 && (r.length < len || (score === 1 && r.length === len))) {
        v.soft.push(`${label}:${start} touched a ${r.length}-line comment, could it shrink?`)
        continue
      }
    }
    if (r.length > limit) {
      const head = r.slice(0, 3).join('\n') + (r.length > 3 ? `\n... (${r.length} lines)` : '')
      v.hard.push(finding(`${label}:${start}`, `${label}:${start} run of ${r.length} comment lines (limit ${limit}):\n${head}`,
        limit === MAX_HEADER ? 'In-file header' : 'Code comments', r.length > 2 * limit, joined, r.length))
    } else if (r.length === MAX_RUN) v.soft.push(`${label}:${start} run of ${MAX_RUN} lines, could this be 1-2?`)
    if (ROT.test(joined)) v.soft.push(`${label}:${start} carries a date, version or 'as of' marker: provenance belongs in the commit body`)
  }
  if (scope === 'runs') return v
  const share = typeof input === 'string' && old ? tally(addedVs(old, input), kind, opts.newFile) : all
  const { com, code } = share
  const total = com + code
  if (com >= MIN_ABS && total && com / total > MAX_SHARE) {
    v.hard.push(finding(`${label}: comment share`, `${label}: ${com}/${total} added non-blank lines are comments (${Math.floor((com * 100) / total)}%, limit ${Math.floor(MAX_SHARE * 100)}%)`,
      'Code comments', true, '', com, share.runs.reduce((n, [, r]) => n + r.join('\n').length, 0)))
  }
  return v
}

export type EditOp = { old_string?: string; new_string?: string; replace_all?: boolean }

/** Edit: runs on the whole resulting file (so an extended run is judged whole), share on what the fragment adds. */
export function judgeEdit(file: string | null, e: EditOp, kind: Kind, label: string): Verdict {
  const o = e.old_string ?? '', n = e.new_string ?? ''
  const next = file !== null && file.includes(o) ? (e.replace_all ? file.split(o).join(n) : file.replace(o, () => n)) : null
  const frag = judge(n, o, kind, label, { scope: next === null ? 'all' : 'share' })
  if (next === null || file === null) return frag
  const whole = judge(next, file, kind, label, { scope: 'runs' })
  return { hard: [...whole.hard, ...frag.hard], soft: [...whole.soft, ...frag.soft], added: frag.added }
}

/** Lines of text not in src, counted as a multiset, grouped into consecutive hunks. */
export function addedVs(src: string, text: string): Hunk[] {
  const left = new Map<string, number>()
  for (const l of splitLines(src)) left.set(l, (left.get(l) ?? 0) + 1)
  const out: Hunk[] = []
  let cur: string[] = [], start = 0
  splitLines(text).forEach((l, i) => {
    const n = left.get(l) ?? 0
    if (n > 0) {
      left.set(l, n - 1)
      if (cur.length) out.push([start, cur.join('\n')])
      cur = []
    } else {
      if (!cur.length) start = i + 1
      cur.push(l)
    }
  })
  if (cur.length) out.push([start, cur.join('\n')])
  return out
}

/** What a write added: a diff section's hunks, else nothing for a tracked file, else the whole text of a new one. */
export function addedOf(chunk: string | undefined, text: string, tracked: boolean): { added: string | Hunk[]; newFile: boolean } | null {
  if (chunk) return { added: hunks(chunk), newFile: false }
  return tracked ? null : { added: text, newFile: true }
}

/** Commit body: every line after the subject that is not blank. */
export const bodyLines = (msg: string): string[] => splitLines(msg).slice(1).filter(l => l.trim())

export function judgeBody(msg: string): Finding | null {
  const body = bodyLines(msg)
  if (body.length <= MAX_BODY) return null
  return finding('commit body', `commit body has ${body.length} lines (limit ${MAX_BODY}); keep the why, move the rest to the MR`,
    'Commit message', body.length > 2 * MAX_BODY, body.join('\n'), body.length)
}

/** The body as a Verdict: its finding, and its size as the added run that a later fix is measured against. */
export function bodyVerdict(msg: string): Verdict {
  const body = bodyLines(msg)
  const f = judgeBody(msg)
  return { hard: f ? [f] : [], soft: [], added: [{ lines: body.length, chars: body.join('\n').length, keyText: '' }] }
}

/** The guide section whose `## ` heading starts with name; headings inside ``` fences are examples. */
export function section(guide: string, name: string): string {
  let out: string[] | null = null, fence = false
  for (const l of guide.split('\n')) {
    if (l.startsWith('```')) fence = !fence
    if (l.startsWith('## ') && !fence) {
      if (out !== null) break
      if (l.slice(3).startsWith(name)) out = []
    }
    if (out !== null) out.push(l)
  }
  return (out ?? []).join('\n').trim()
}

/** Findings, the guide sections that cover them inline, and what to do, in about 3000 chars. */
export function reason(hard: readonly Finding[], guide: string, post = false): string {
  const names = [...new Set(hard.map(h => h.section))]
  const what = names.length === 1 && names[0] === 'Commit message' ? 'commit body' : 'comment'
  const task = post ? 'The file is already written: shorten these comments now.' : hard.some(h => h.keyText === null) ? `Rewrite the ${what}.`
    : `Rewrite the ${what}, or keep it unchanged, resubmit, and state in one sentence in your reply why it must stay as is.`
  const head = ('comment-guard:\n\n' + [...new Set(hard.map(h => h.msg))].join('\n\n')).slice(0, 1000)
  const text = names.map(n => section(guide, n)).join('\n\n').slice(0, Math.max(0, 2900 - head.length - task.length))
  return `${head}\n\n${text}\n\n${task}`
}

/** `$VAR`/`~` expansion from VAR=path of the same command, then `env`; an unknown `$VAR` stays literal. */
export function resolver(cmd: string, cwd: string, env: Readonly<Record<string, string>>) {
  const vars: Record<string, string> = { ...env }
  for (const m of cmd.matchAll(/(?:^|[;&|\n]\s*)([A-Za-z_]\w*)=([^\s;&|]+)/g)) vars[m[1]] = m[2]
  const expand = (p: string, base = cwd): string => {
    let q = p.replace(/\$env:([A-Za-z_]\w*)/gi, (all, name: string) => vars[name] ?? vars[name.toUpperCase()] ?? all)
      .replace(/\$\{?([A-Za-z_]\w*)\}?/g, (all, name: string) => vars[name] ?? all).replace(/^['"]+|['"]+$/g, '')
    q = slash(q)
    if (q === '~' || q.startsWith('~/')) q = slash(env.HOME ?? '/') + q.slice(1)
    return join(base, q)
  }
  const m = /(?:^|[;&|]\s*)(?:cd|Set-Location|sl|pushd|Push-Location)\s+(?:-(?:Literal)?Path\s+)?([^\s;&|]+)/i.exec(cmd)
  return { expand, workdir: m ? expand(m[1]) : slash(cwd) }
}

const HEREDOC = /^([^\n]*?)<<-?\s*(['"]?)(\w+)\2([^\n]*)\n(.*?)\n\s*\3\s*$/gms
// PowerShell here-string: the closing '@ or "@ starts its line.
const HERESTRING = /^([^\n]*?)@(['"])\r?\n(.*?)\r?\n\2@([^\n]*)$/gms
const TARGET = new RegExp(String.raw`(?:^|[^\d&>])>>?\s*([^\s;&|<>]+)|\btee\s+(?:-a\s+)?([^\s;&|<>]+)` +
  String.raw`|\b(?:Set-Content|Add-Content|Out-File)\s+(?!-)([^\s;&|<>]+)|\s-(?:Literal|File)?Path\s+([^\s;&|<>]+)`, 'gi')
const COMMIT = /(?<=^|[\s;&|(\/])git(?:\s+-[Cc]\s+[^\s;&|]+|\s+--[\w-]+(?:=[^\s;&|]+)?)*\s+commit(?![\w.\/-])/
const MSG = /(?<!\S)(?:-[A-Za-z]*m|--message)(?:=|\s*)(?:(["'])(.*?)\1|([^\s"';&|]+))/gs

export const redirectTargets = (text: string): string[] => [...text.matchAll(TARGET)].map(m => m[1] ?? m[2] ?? m[3] ?? m[4])

type Doc = { pre: string; body: string; post: string }
/** Bash heredocs and PowerShell here-strings of cmd: the text around each on its line, and its body. */
function docs(cmd: string): Doc[] {
  const out: Doc[] = []
  if (cmd.includes('<<')) for (const m of cmd.matchAll(HEREDOC)) out.push({ pre: m[1], body: m[5], post: m[4] })
  if (cmd.includes('@')) for (const m of cmd.matchAll(HERESTRING)) out.push({ pre: m[1], body: m[3], post: m[4] })
  return out
}

/** Raw (unexpanded) file targets of each heredoc or here-string in cmd, with the body written to them. */
export const heredocTargets = (cmd: string): { target: string; body: string }[] =>
  docs(cmd).flatMap(d => redirectTargets(`${d.pre} ${d.post}`).map(target => ({ target, body: d.body })))

/** Tokens of cmd that look like paths: a slash, a code extension or a known code file name. */
export const namedTokens = (cmd: string): string[] =>
  (cmd.match(/[^\s'";&|<>()=,]+/g) ?? []).filter(t => /[/\\]/.test(t) ||extOf(basename(t)) in EXT || HASH_NAMES.has(basename(t)))

export type CommitCall = { repo: string | null; all: boolean; adds: string[]; msg: string | null }

/** The `git commit` of cmd: its -C repo, -a flag, same-command `git add` files and message; null when there is none. */
export function parseCommit(cmd: string): CommitCall | null {
  const shell = cmd.replace(HEREDOC, (_all, pre: string, _q, tag: string, post: string) => `${pre}<<${tag}${post}\n${tag}`)
    .replace(HERESTRING, (_all, pre: string, q: string, _body, post: string) => `${pre}@${q}${q}@${post}`)
  const cm = COMMIT.exec(shell)
  if (!cm) return null
  const tail = shell.slice(cm.index)
  const seg = /^[^\n;&|]*/.exec(tail)?.[0] ?? ''
  const repo = /^git\b[^\n;&|]*?\s-C\s+([^\s;&|]+)/.exec(seg)?.[1] ?? null
  const all = /(?<!\S)(-[A-Za-z]*a[A-Za-z]*|--all)(?!\S)/.test(seg)
  const am = /\bgit(?:\s+-[Cc]\s+[^\s;&|]+)*\s+add\s+([^;&|\n]+)/.exec(shell)
  const adds = am ? [...new Set(am[1].split(/\s+/).filter(f => f && !f.startsWith('-')))].sort() : []
  const hd = docs(cmd).find(d => COMMIT.test(d.pre))
  const ms: string[] = []
  let pos = 0
  for (const m of tail.matchAll(MSG)) {
    if (/[;&|\n]/.test(tail.slice(pos, m.index))) break
    ms.push(m[1] ? m[2] : m[3])
    pos = (m.index ?? 0) + m[0].length
  }
  return { repo, all, adds, msg: hd ? hd.body : ms.length ? ms.join('\n\n') : null }
}
