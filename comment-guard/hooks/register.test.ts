import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { code, com } from './fixtures'

const GUIDE = ['## Code comments. Budget', 'guide-code-section', '## In-file header', 'guide-header-section',
  '## Commit message', 'guide-commit-section'].join('\n')
const SKILL = 'name: x\n\nShort form: two lines per fact.\n\nmore'
const ON = { options: { enabled: true } }

/** A world beneath the plugin: files by path, no processes, and a log of every path the plugin touched. */
type Proc = (argv: readonly string[]) => string
const noGit: Proc = () => ''

function world(on: On, files: Record<string, string> = {}, env: Record<string, string> = {}, proc: Proc = noGit, exec: (cmd: string) => void = () => {}, store: Record<string, unknown> = {}, cwd = '/w') {
  const touched: string[] = []
  const key = keyer(/^[A-Za-z]:/.test(cwd))
  mock.env(on, { HOME: '/home/u', ...env })
  const kept = new Map<string, unknown>(Object.entries(store))
  const saves: string[] = []
  on('store.get', ($, e) => ({ value: kept.get(e.key) }))
  on('store.set', ($, e) => {
    saves.push(e.key)
    kept.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    kept.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...kept.keys()] }))
  const clock = mock.clock(on, { now: Date.now() })
  on('session.cwd', () => ({ value: cwd }))
  on('fs.exists', ($, e) => {
    touched.push(key(e.path))
    return { value: files[key(e.path)] !== undefined }
  })
  on('fs.stat', ($, e) => {
    touched.push(key(e.path))
    const text = files[key(e.path)]
    if (text === undefined) throw new Error('ENOENT')
    return { value: { kind: 'file' as const, size: text.length, mtimeMs: Date.now() + 60_000, isLink: false, realPath: key(e.path) } }
  })
  on('fs.read', ($, e) => {
    const shipped = Object.entries(SHIPPED).find(([k]) => key(e.path).endsWith(k))?.[1]
    if (!shipped) touched.push(key(e.path))
    const text = files[key(e.path)] ?? shipped
    if (text === undefined) throw new Error('ENOENT')
    return { value: e.as === 'bytes' ? { base64: btoa(text) } : text }
  })
  on('process.run', ($, e) => ({ value: { exitCode: 0, stdout: proc(e.argv), stderr: '' } }))
  on('tool.call', ($, e) => {
    if (e.tool === 'Bash' || e.tool === 'PowerShell') exec(e.command)
    return { result: 'ran' }
  })
  on('classic.SessionStart', () => ({}))
  return { touched, files, saves, clock }
}

/**
 * The engine hands fs hooks the path as the host resolves it: `/w/a.py` is `C:\w\a.py` on a Windows host, and
 * `C:/w/a.py` lands under the cwd on macOS. The world keys files as the test spelled them, `/w/..` or `C:/w/..`.
 */
const keyer = (win: boolean) => (p: string): string => {
  const s = p.replace(/\\/g, '/'), at = s.search(/[A-Za-z]:\/(?!.*[A-Za-z]:\/)/)
  const d = at < 0 ? s : s.slice(at)
  return win ? d : d.replace(/^[A-Za-z]:/, '')
}

/** The skill files ship in the plugin, whose root a test does not know: matched by their path inside it. */
const SHIPPED = { '/skills/comment-style/comment-style.md': GUIDE, '/skills/comment-style/SKILL.md': SKILL }
const guideFiles: Record<string, string> = {}

type Call = { deny?: string; text?: string; isError?: true; context?: readonly string[] }
const outcome = (r: Call) => (r.deny ?? (r.isError ? r.text : undefined))

describe('edit gate', () => {
  test('6-run write is denied with the Code comments section', ON, async ($, on) => {
    world(on, guideFiles)
    const r = await $.tool.call({ tool: 'Write', file_path: '/w/a.py', content: [code(3), com(6), code(30)].join('\n') })
    const d = outcome(r)
    expect(d).toMatch(/^comment-guard:/)
    expect(d).toContain('guide-code-section')
    expect(d).toMatch(/resubmit/)
  })
  test('identical retry passes with a soft note, a changed text denies again', ON, async ($, on) => {
    world(on, guideFiles)
    const content = [code(3), com(6), code(30)].join('\n')
    expect(outcome(await $.tool.call({ tool: 'Write', file_path: '/w/a.py', content }))).toBeDefined()
    const again = await $.tool.call({ tool: 'Write', file_path: '/w/a.py', content })
    expect(outcome(again)).toBeUndefined()
    expect(again.context?.join(' ')).toMatch(/passed on resubmission/)
    const changed = content.replace('premise 2', 'premise 9')
    expect(outcome(await $.tool.call({ tool: 'Write', file_path: '/w/a.py', content: changed }))).toBeDefined()
    expect(outcome(await $.tool.call({ tool: 'Write', file_path: '/w/b.py', content }))).toBeDefined()
  })
  test('12-run is capped: denied on both attempts, no key stored', ON, async ($, on) => {
    world(on, guideFiles)
    const content = [code(3), com(12), code(30)].join('\n')
    expect(outcome(await $.tool.call({ tool: 'Write', file_path: '/w/a.py', content }))).toMatch(/Rewrite the comment\.$/)
    expect(outcome(await $.tool.call({ tool: 'Write', file_path: '/w/a.py', content }))).toBeDefined()
  })
  test('new-file header 8 passes, 9 denied with the header section', ON, async ($, on) => {
    world(on, guideFiles)
    expect(outcome(await $.tool.call({ tool: 'Write', file_path: '/w/n.py', content: [com(8), code(40)].join('\n') }))).toBeUndefined()
    const d = outcome(await $.tool.call({ tool: 'Write', file_path: '/w/m.py', content: [com(9), code(40)].join('\n') }))
    expect(d).toContain('guide-header-section')
  })
  test('a Write or heredoc over an existing 35% comment file is judged on the lines it changes', ON, async ($, on) => {
    const dense = [com(4), code(8), com(4), code(8), com(4), code(7), com(4), code(7)].join('\n')
    world(on, { ...guideFiles, '/w/d.py': dense })
    expect(outcome(await $.tool.call({ tool: 'Write', file_path: '/w/d.py', content: dense.replace('x3 = 3', 'x3 = 4') }))).toBeUndefined()
    expect(outcome(await $.tool.call({ tool: 'Bash', command: `cat > d.py <<'EOF'\n${dense}\nEOF` }))).toBeUndefined()
  })
  test('Edit extends a 4-run to 7 in the real file', ON, async ($, on) => {
    const last = com(4).split('\n')[3]
    world(on, { ...guideFiles, '/w/e.py': [code(10), com(4), code(10)].join('\n') })
    const r = await $.tool.call({ tool: 'Edit', file_path: '/w/e.py', old_string: last, new_string: `${last}\n${com(3, '#')}` })
    expect(outcome(r)).toMatch(/run of 7 comment lines/)
    const soft = await $.tool.call({ tool: 'Edit', file_path: '/w/e.py', old_string: 'x5 = 5', new_string: `x5 = 5\n${com(5)}` })
    expect(outcome(soft)).toBeUndefined()
    expect(soft.context?.join(' ')).toMatch(/run of 5 lines/)
  })
})

describe('security and gates', () => {
  test('.env, prose and /tmp are never stat-ed or read', ON, async ($, on) => {
    const w = world(on, guideFiles)
    for (const p of ['/w/.env', '/w/.env.local', '/w/README.md', '/tmp/x.py', '/w/docs/a.py', '/w/token']) {
      expect(outcome(await $.tool.call({ tool: 'Write', file_path: p, content: com(9) }))).toBeUndefined()
      expect(outcome(await $.tool.call({ tool: 'Edit', file_path: p, old_string: 'a', new_string: com(9) }))).toBeUndefined()
    }
    expect(w.touched.filter(p => !p.includes('comment-style') && !p.endsWith('/.git'))).toEqual([])
  })
  test('enabled=false passes everything through', { options: { enabled: false } }, async ($, on) => {
    const w = world(on, guideFiles)
    const r = await $.tool.call({ tool: 'Write', file_path: '/w/a.py', content: com(12) })
    expect(outcome(r)).toBeUndefined()
    expect(w.touched).toEqual([])
    expect((await $.classic.SessionStart({ source: 'startup' })).additionalContext ?? []).toHaveLength(0)
  })
  test('the manifest default is on: a 12-run is denied with no options given', async ($, on) => {
    world(on, guideFiles)
    expect(outcome(await $.tool.call({ tool: 'Write', file_path: '/w/a.py', content: com(12) }))).toBeDefined()
  })
  test('CLAUDE_COMMENT_GUARD=off passes everything through', ON, async ($, on) => {
    world(on, guideFiles, { CLAUDE_COMMENT_GUARD: 'off' })
    expect(outcome(await $.tool.call({ tool: 'Write', file_path: '/w/a.py', content: com(12) }))).toBeUndefined()
    expect((await $.classic.SessionStart({ source: 'startup' })).additionalContext ?? []).toHaveLength(0)
  })
  test('SessionStart carries the short form when enabled', ON, async ($, on) => {
    world(on, guideFiles)
    const r = await $.classic.SessionStart({ source: 'compact' })
    expect(r.additionalContext?.[0]).toMatch(/^comment-guard is active/)
    expect(r.additionalContext?.[0]).toContain('Short form: two lines per fact.')
    expect(r.additionalContext?.[0]).toMatch(/Full rules: (\/|[A-Za-z]:)\S+\/skills\/comment-style\/comment-style\.md$/)
  })
})

describe('post and stats', () => {
  const files = { ...guideFiles, '/w/x.py': [code(3), com(7), code(30)].join('\n'), '/w/.git': '' }
  test('printf into a new x.py gets a post block, not a deny', ON, async ($, on) => {
    const w = world(on, { ...guideFiles, '/w/.git': '' }, {}, argv => (argv.includes('ls-files') && argv.includes('-t') ? '? x.py\0' : ''),
      () => { w.files['/w/x.py'] = files['/w/x.py'] })
    const r = await $.tool.call({ tool: 'Bash', command: 'printf "%s\\n" > x.py' })
    expect(outcome(r)).toBeUndefined()
    const ctx = r.context?.join('\n') ?? ''
    expect(ctx).toMatch(/comment-guard:\n\nx\.py:4 run of 7 comment lines/)
    expect(ctx).toMatch(/already written: shorten these comments now/)
    expect(ctx).toContain('guide-code-section')
  })
  test('an untracked file the command did not name is only a soft note', ON, async ($, on) => {
    world(on, files, {}, argv => (argv.includes('ls-files') && argv.includes('-t') ? '? x.py\0' : ''))
    const r = await $.tool.call({ tool: 'Bash', command: 'python3 gen.py' })
    expect(r.context?.join('\n')).toMatch(/^comment-guard: x\.py:4 run of 7 comment lines \(limit 5\): \(not blocked: untracked file the command did not create by name\)/)
  })
  test('read-only and failed git give no post context', ON, async ($, on) => {
    world(on, files)
    const r = await $.tool.call({ tool: 'Bash', command: 'ls' })
    expect(r.context ?? []).toHaveLength(0)
  })
  test('stats command renders the counters of this session', ON, async ($, on) => {
    world(on, guideFiles)
    on('session.start', () => ({ cwd: '/w' }))
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    on('command.run', () => ({}))
    await $.session.start({ cwd: '/w' })
    await $.tool.call({ tool: 'Write', file_path: '/w/a.py', content: [code(3), com(6), code(30)].join('\n') })
    await $.tool.call({ tool: 'Write', file_path: '/w/a.py', content: [code(3), com(2), code(30)].join('\n') })
    const r = await $.command.run({ command: 'comment-guard-stats', args: '' })
    const text = r.text ?? ''
    expect(text).toMatch(/^comment-guard stats, 1 session/)
    const edit = text.split('\n').find(l => l.startsWith('edit'))?.split(/\s+/) ?? []
    expect(edit.slice(1, 7)).toEqual(['2', '2', '1', '1', '0', '0'])
    expect(edit[9]).toBe('1')
    expect(text).toMatch(/savings, ESTIMATE: ~\d+ tokens from 4 comment lines/)
    expect(text).toMatch(/deny \d+, post 0, soft 0, retry \d+, stats \d+/)
    expect(text).toMatch(/^main agent: checks 2, deny 1, fixed 1,/m)
    expect(text).toMatch(/^project w: checks 2,/m)
    const other = await $.command.run({ command: 'comment-guard-stats', args: 'nope' })
    expect(other.text).toMatch(/^comment-guard stats for project nope/)
    expect(other.text).toMatch(/^current session: checks 0,/m)
  })
})

describe('metric edge cases', () => {
  const statsWorld = (on: On, files: Record<string, string> = guideFiles) => {
    world(on, { ...files, '/w/.git': '' })
    on('session.start', () => ({ cwd: '/w' }))
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    on('command.run', () => ({}))
  }
  const row = async ($: { command: { run: (e: { command: string; args: string }) => Promise<{ text?: string }> } }, mode: string) =>
    ((await $.command.run({ command: 'comment-guard-stats', args: '' })).text ?? '').split('\n').find(l => l.startsWith(mode))?.split(/\s+/) ?? []
  test('a resubmission pass clears the deny, so a later shorter write is not counted as fixed', ON, async ($, on) => {
    statsWorld(on)
    const bad = [code(3), com(6), code(30)].join('\n')
    await $.tool.call({ tool: 'Write', file_path: '/w/a.py', content: bad })
    await $.tool.call({ tool: 'Write', file_path: '/w/a.py', content: bad })
    await $.tool.call({ tool: 'Write', file_path: '/w/a.py', content: [code(3), com(2), code(30)].join('\n') })
    const r = await row($, 'edit')
    expect([r[6], r[9]]).toEqual(['1', '0'])
  })
  test('a commit body fixed from 11 to 3 lines credits 8 prevented lines', ON, async ($, on) => {
    statsWorld(on)
    const msg = (n: number) => `git commit -m s -m "${Array.from({ length: n }, (_, i) => `line ${i}`).join('\n')}"`
    expect(outcome(await $.tool.call({ tool: 'Bash', command: msg(11) }))).toBeDefined()
    expect(outcome(await $.tool.call({ tool: 'Bash', command: msg(3) }))).toBeUndefined()
    expect((await row($, 'commit'))[9]).toBe('1')
    const text = (await $.command.run({ command: 'comment-guard-stats', args: '' })).text ?? ''
    expect(text).toMatch(/from 8 comment lines not written/)
  })
  test('a Bash call that changes no file counts a post call but no post check', ON, async ($, on) => {
    statsWorld(on)
    await $.tool.call({ tool: 'Bash', command: 'echo hi' })
    const r = await row($, 'post')
    expect([r[1], r[2]]).toEqual(['1', '0'])
  })
})

describe('project per call', () => {
  test('a write is counted under the repo of its path, not the session cwd', ON, async ($, on) => {
    world(on, { ...guideFiles, '/w/.git': '', '/w/r1/.git': '', '/w/r2/.git': '' })
    on('session.start', () => ({ cwd: '/w' }))
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    on('command.run', () => ({}))
    const bad = [code(3), com(6), code(30)].join('\n')
    await $.tool.call({ tool: 'Write', file_path: '/w/r1/a.py', content: bad })
    await $.tool.call({ tool: 'Write', file_path: '/w/r2/sub/b.py', content: bad })
    await $.tool.call({ tool: 'Write', file_path: '/w/r2/c.py', content: bad })
    const text = (await $.command.run({ command: 'comment-guard-stats', args: '' })).text ?? ''
    expect(text).toMatch(/^project r2: checks 2, deny 2,/m)
    expect(text).toMatch(/^project r1: checks 1, deny 1,/m)
    expect(text).toMatch(/^project w: checks 0,/m)
  })
})

describe('heredoc counted once', () => {
  test('a heredoc write is judged before the call only; its retry is one heredoc resub', ON, async ($, on) => {
    const w = world(on, { ...guideFiles, '/w/.git': '' }, {}, argv => (argv.includes('ls-files') && argv.includes('-t') ? '? h.py\0' : ''),
      () => { w.files['/w/h.py'] = [code(3), com(6), code(30)].join('\n') })
    on('session.start', () => ({ cwd: '/w' }))
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    on('command.run', () => ({}))
    const cmd = `cat > h.py <<'EOF'\n${code(3)}\n${com(6)}\n${code(30)}\nEOF`
    expect(outcome(await $.tool.call({ tool: 'Bash', command: cmd }))).toBeDefined()
    const again = await $.tool.call({ tool: 'Bash', command: cmd })
    expect(outcome(again)).toBeUndefined()
    expect(again.context?.join(' ')).toMatch(/passed on resubmission/)
    expect(again.context?.join(' ')).not.toMatch(/already written/)
    const text = (await $.command.run({ command: 'comment-guard-stats', args: '' })).text ?? ''
    const r = (m: string) => text.split('\n').find(l => l.startsWith(m))?.split(/\s+/) ?? []
    expect(r('heredoc').slice(1, 7)).toEqual(['2', '2', '1', '1', '0', '1'])
    expect(r('post').slice(1, 4)).toEqual(['1', '0', '0'])
  })
})

describe('simplify coverage', () => {
  test('sessions older than 30 days fold into the archive at session start', ON, async ($, on) => {
    const old = { t: Date.now() - 40 * 86_400_000, by: { 'old\tmain': { t: 1, m: { edit: { checks: 3 } }, inj: {} } } }
    world(on, { ...guideFiles, '/w/.git': '' }, {}, noGit, () => {}, { 's:old': old })
    on('session.start', () => ({ cwd: '/w' }))
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    on('command.run', () => ({}))
    await $.session.start({ cwd: '/w' })
    const text = (await $.command.run({ command: 'comment-guard-stats', args: '' })).text ?? ''
    expect(text).toMatch(/^comment-guard stats, 1 session\(s\)/)
    expect(text).toMatch(/^project old: checks 3,/m)
  })
  test('git add of several files: each judged from one batched diff, clean and in-HEAD files pass', ON, async ($, on) => {
    const six = [code(3), com(6), code(30)].join('\n')
    const diff = `diff --git a/c.py b/c.py\n--- a/c.py\n+++ b/c.py\n@@ -1,0 +2,6 @@\n${com(6).split('\n').map(l => `+${l}`).join('\n')}\n`
    const proc: Proc = argv => (argv.includes('-s') ? '100644 0123456789abcdef0123456789abcdef01234567 0\tc.py\n' : argv.includes('HEAD') ? diff : '')
    world(on, { ...guideFiles, '/w/.git': '', '/w/a.py': six, '/w/b.py': [code(3), com(2)].join('\n'), '/w/c.py': six }, {}, proc)
    const d = outcome(await $.tool.call({ tool: 'Bash', command: 'git add a.py b.py c.py && git commit -m fix' })) ?? ''
    expect(d).toMatch(/a\.py:4 run of 6/)
    expect(d).toMatch(/c\.py:2 run of 6/)
    expect(d).not.toMatch(/b\.py/)
  })
})

describe('throttled save', () => {
  test('counters reach the store at most once a minute, a deny included; session end flushes', ON, async ($, on) => {
    const w = world(on, guideFiles)
    on('session.end', () => ({ sessionId: 'x' }))
    const write = (content: string) => $.tool.call({ tool: 'Write', file_path: '/w/a.py', content })
    await write(code(3))
    expect(w.saves).toHaveLength(1)
    await w.clock.advance(20_000)
    await write(code(4))
    await w.clock.advance(30_000)
    expect(outcome(await write([code(3), com(6), code(30)].join('\n')))).toBeDefined()
    expect(w.saves).toHaveLength(1)
    await w.clock.advance(10_000)
    await write(code(5))
    expect(w.saves).toHaveLength(2)
    await $.session.end({ reason: 'other', sessionId: 'x' } as never)
    expect(w.saves).toHaveLength(3)
    expect(new Set(w.saves).size).toBe(1)
  })
  test('the runtime has Uint8Array toHex and fromBase64, which hashing and byte reads rely on', () => {
    expect(new Uint8Array([1, 255]).toHex()).toBe('01ff')
    expect([...Uint8Array.fromBase64('Af8=')]).toEqual([1, 255])
  })
})

describe('named files outside the repo', () => {
  const long = [code(3), com(7), code(30)].join('\\n')
  const short = [code(3), com(2), code(30)].join('\\n')
  const setup = (on: On, extra: Record<string, string> = {}, write: Record<string, string> = {}) => {
    const w = world(on, { ...guideFiles, '/w/.git': '', ...extra }, {}, noGit, () => Object.assign(w.files, write))
    return w
  }
  test('python writing a long comment into a named outside file gets a post block', ON, async ($, on) => {
    setup(on, {}, { '/o/x.tf': long.replaceAll('\\n', '\n') })
    const r = await $.tool.call({ tool: 'Bash', command: `python3 -c "open('/o/x.tf','w').write('...')"` })
    expect(outcome(r)).toBeUndefined()
    expect(r.context?.join('\n')).toMatch(/x\.tf:4 run of 7 comment lines[\s\S]*already written/)
  })
  test('the same with a short comment is silent', ON, async ($, on) => {
    setup(on, {}, { '/o/x.tf': short.replaceAll('\\n', '\n') })
    const r = await $.tool.call({ tool: 'Bash', command: `python3 -c "open('/o/x.tf','w').write('...')"` })
    expect(r.context ?? []).toHaveLength(0)
  })
  test('an existing outside file is judged on what the command added to it', ON, async ($, on) => {
    const before = [code(3), com(7), code(30)].join('\n')
    setup(on, { '/o/y.tf': before }, { '/o/y.tf': `${before}\nz = 1` })
    const r = await $.tool.call({ tool: 'Bash', command: `printf 'z = 1\\n' >> /o/y.tf` })
    expect(r.context ?? []).toHaveLength(0)
  })
  test('an outside file copied unchanged is silent', ON, async ($, on) => {
    const text = long.replaceAll('\\n', '\n')
    setup(on, { '/o/a.tf': text }, { '/o/b.tf': text })
    const r = await $.tool.call({ tool: 'Bash', command: 'cp /o/a.tf /o/b.tf' })
    expect(r.context ?? []).toHaveLength(0)
  })
  test('documented limit: a computed path outside the repo is not checked', ON, async ($, on) => {
    setup(on, { '/w/gen.py': 'x = 1' }, { '/o/z.tf': long.replaceAll('\\n', '\n') })
    const r = await $.tool.call({ tool: 'Bash', command: 'python3 gen.py' })
    expect(r.context ?? []).toHaveLength(0)
  })
})

describe('bash gate', () => {
  test('heredoc with a 6-run is denied, a 4-run passes', ON, async ($, on) => {
    world(on, guideFiles)
    const bad = `cat > a.py <<'EOF'\n${code(3)}\n${com(6)}\n${code(30)}\nEOF`
    expect(outcome(await $.tool.call({ tool: 'Bash', command: bad }))).toMatch(/a\.py:4 run of 6/)
    const ok = `cat > a.py <<'EOF'\n${code(3)}\n${com(4)}\nEOF`
    expect(outcome(await $.tool.call({ tool: 'Bash', command: ok }))).toBeUndefined()
    expect(outcome(await $.tool.call({ tool: 'Bash', command: `cat > notes.md <<'EOF'\n${com(9)}\nEOF` }))).toBeUndefined()
    expect(outcome(await $.tool.call({ tool: 'Bash', command: `cat > /tmp/t.py <<'EOF'\n${com(9)}\nEOF` }))).toBeUndefined()
  })
  test('cd, mkdir and quoted targets resolve to the written file', ON, async ($, on) => {
    world(on, guideFiles)
    const body = [code(3), com(6), code(30)].join('\n')
    expect(outcome(await $.tool.call({ tool: 'Bash', command: `cd sub && cat > a.py <<'EOF'\n${body}\nEOF` }))).toMatch(/a\.py:4 run of 6/)
    expect(outcome(await $.tool.call({ tool: 'Bash', command: `mkdir -p s && tee 'q.py' <<'EOF'\n${body}\nEOF` }))).toMatch(/q\.py:4 run of 6/)
    const again = await $.tool.call({ tool: 'Bash', command: `cd sub && cat > a.py <<'EOF'\n${body}\nEOF` })
    expect(outcome(again)).toBeUndefined()
    expect(again.context?.join(' ')).toMatch(/passed on resubmission/)
  })
  test('commit body over 10 is denied once; git failures give no finding', ON, async ($, on) => {
    world(on, { ...guideFiles, '/w/.git': '' })
    const body = Array.from({ length: 11 }, (_, i) => `line ${i}`).join('\n')
    const cmd = `git commit -m s -m "${body}"`
    const d = outcome(await $.tool.call({ tool: 'Bash', command: cmd }))
    expect(d).toMatch(/commit body has 11 lines/)
    expect(d).toContain('guide-commit-section')
    expect(d).toMatch(/Rewrite the commit body, or keep it/)
    const again = await $.tool.call({ tool: 'Bash', command: cmd })
    expect(outcome(again)).toBeUndefined()
    expect(again.context?.join(' ')).toMatch(/commit body passed on resubmission/)
  })
  test('staged 6-run in the diff is denied', ON, async ($, on) => {
    const diff = `diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1,0 +2,6 @@\n${com(6).split('\n').map(l => `+${l}`).join('\n')}\n`
    world(on, { ...guideFiles, '/w/.git': '' }, {}, argv => (argv.includes('--cached') ? diff : ''))
    expect(outcome(await $.tool.call({ tool: 'Bash', command: 'git commit -m fix' }))).toMatch(/a\.py:2 run of 6/)
    expect(outcome(await $.tool.call({ tool: 'Bash', command: 'git status' }))).toBeUndefined()
  })
})

describe('windows session', () => {
  const W = 'C:\\w'
  const winWorld = (on: On, files: Record<string, string> = {}, proc: Proc = noGit) => world(on, { ...guideFiles, ...files }, {}, proc, () => {}, {}, W)
  const body = [code(3), com(6), code(30)].join('\n')
  test('a backslash Write is denied, its retry by another drive-letter case passes', ON, async ($, on) => {
    winWorld(on)
    expect(outcome(await $.tool.call({ tool: 'Write', file_path: 'C:\\w\\a.py', content: body }))).toMatch(/a\.py:4 run of 6/)
    const again = await $.tool.call({ tool: 'Write', file_path: 'c:\\w\\a.py', content: body })
    expect(outcome(again)).toBeUndefined()
    expect(again.context?.join(' ')).toMatch(/passed on resubmission/)
  })
  test('no .git up to the drive root: the walk ends', ON, async ($, on) => {
    const w = winWorld(on)
    expect(outcome(await $.tool.call({ tool: 'Write', file_path: 'C:\\w\\deep\\x.py', content: code(3) }))).toBeUndefined()
    expect(w.touched).toContain('C:/.git')
  })
  test('Windows temp is never read', ON, async ($, on) => {
    const w = winWorld(on)
    const p = 'C:\\Users\\u\\AppData\\Local\\Temp\\x.py'
    expect(outcome(await $.tool.call({ tool: 'Write', file_path: p, content: [code(3), com(12), code(30)].join('\n') }))).toBeUndefined()
    expect(w.touched.filter(t => t.includes('Temp/x.py'))).toEqual([])
  })
  test('PowerShell here-string into Set-Content is judged like a heredoc', ON, async ($, on) => {
    winWorld(on)
    const cmd = `@'\n${body}\n'@ | Set-Content -Path a.py -Encoding utf8`
    expect(outcome(await $.tool.call({ tool: 'PowerShell', command: cmd }))).toMatch(/a\.py:4 run of 6/)
    expect(outcome(await $.tool.call({ tool: 'PowerShell', command: `@'\n${code(3)}\n'@ | Set-Content a.py` }))).toBeUndefined()
  })
  test('PowerShell git commit with a here-string body over 10 is denied', ON, async ($, on) => {
    winWorld(on, { 'C:/w/.git': '' })
    const msg = ['fix: x', '', ...Array.from({ length: 11 }, (_, i) => `line ${i}`)].join('\n')
    expect(outcome(await $.tool.call({ tool: 'PowerShell', command: `git commit -m @'\n${msg}\n'@` }))).toMatch(/commit body has 11 lines/)
  })
  test('a Git Bash /c/ path is the same file as C:/', ON, async ($, on) => {
    const w = winWorld(on)
    expect(outcome(await $.tool.call({ tool: 'Bash', command: `cat > /c/w/b.py <<'EOF'\n${body}\nEOF` }))).toMatch(/b\.py:4 run of 6/)
    expect(w.touched).toContain('C:/w/b.py')
  })
})
