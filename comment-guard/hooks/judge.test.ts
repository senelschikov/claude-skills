import { describe, expect, test } from 'claude-code/testing'

import {
  addedOf, addedVs, EXT, extOf, heredocTargets, hunks, judge, judgeBody, judgeEdit, lang, namedTokens, NEVER_COUNT, parseCommit,
  reason, redirectTargets, resolver, ROT, runs, section, setWindows, slash, dirname, norm, isAbs, join, basename,
} from './judge'
import type { Kind } from './judge'
import { code, com } from './fixtures'

const kindOf = (p: string, text = ''): Kind => {
  const k = lang(p, text)
  if (!k) throw new Error(`no kind for ${p}`)
  return k
}
const verdict = (path: string, text: string, newFile = false) =>
  judge(text, '', kindOf(path, text), path, { newFile })
const block = (open: string, close: string, n: number) =>
  [open, ...Array.from({ length: n - 2 }, (_, i) => `  line ${i} of the explanation`), close].join('\n')
const middle = (body: string) => [code(3), body, code(30)].join('\n')

describe('edit/lang', () => {
  const lineCases: [string, string][] = [
    ['a.py', '#'], ['a.tf', '#'], ['b.tf', '//'], ['a.yaml', '#'], ['a.go', '//'], ['a.ts', '//'], ['a.sql', '--'],
    ['a.lua', '--'], ['a.ini', ';'], ['a.el', ';'], ['a.sh', '#'], ['a.rb', '#'], ['Dockerfile', '#'], ['Makefile', '#'],
    ['a.proto', '//'], ['a.hcl', '#'], ['a.groovy', '//'], ['a.rs', '//'], ['Jenkinsfile', '#'], ['a.tpl', '#'],
  ]
  for (const [path, p] of lineCases) {
    test(`${path} 6-run denied`, () => {
      expect(verdict(path, middle(com(6, p))).hard).toHaveLength(1)
    })
  }
  const blockCases: [string, string, string][] = [
    ['a.xml', '<!--', '-->'], ['a.css', '/*', '*/'], ['values.yaml', '{{- /*', '*/}}'], ['a.js', '/**', ' */'],
  ]
  for (const [path, o, c] of blockCases) {
    test(`${path} 7-line block denied`, () => {
      expect(verdict(path, middle(block(o, c, 7))).hard).toHaveLength(1)
    })
  }
})

describe('edit/skip', () => {
  for (const p of ['a.md', 'README', 'x/README.rst', 'CHANGELOG.md', 'docs/a.py', 'a.json', 'a.txt', 'a.rst', 'a.unknownext',
    '.env', '.env.local', 'x/.env.prod', '/tmp/a.py', '/private/tmp/x/a.py', 'repo/.git/hooks/a.sh']) {
    test(`${p} is never judged`, () => {
      expect(lang(p)).toBeNull()
    })
  }
  test('extensionless file needs a shebang', () => {
    expect(lang('runme')).toBeNull()
    expect(lang('runme', '#!/bin/sh')).not.toBeNull()
  })
  test('EXT has no empty key', () => {
    expect(Object.keys(EXT).every(k => k.startsWith('.'))).toBe(true)
  })
  test('dotfile extensions', () => {
    expect(lang('.gitignore')).not.toBeNull()
    expect(extOf('.bashrc')).toBe('')
  })
})

describe('limits', () => {
  test('5-run is soft, 4-run passes, 6-run denied', () => {
    const five = verdict('a.py', middle(com(5)))
    expect(five.hard).toHaveLength(0)
    expect(five.soft.join(';')).toMatch(/run of 5 lines/)
    expect(verdict('a.py', middle(com(4))).hard.concat()).toHaveLength(0)
    const six = verdict('a.py', middle(com(6)))
    expect(six.hard[0].section).toBe('Code comments')
    expect(six.hard[0].capped).toBe(false)
    expect(six.hard[0].keyText).not.toBeNull()
    expect(six.hard[0].runLines).toBe(6)
  })
  test('new-file header 8 passes, 9 denied', () => {
    expect(verdict('a.py', [com(8), code(40)].join('\n'), true).hard).toHaveLength(0)
    const nine = verdict('a.py', [com(9), code(40)].join('\n'), true)
    expect(nine.hard).toHaveLength(1)
    expect(nine.hard[0].section).toBe('In-file header')
  })
  test('header after a shebang', () => {
    expect(verdict('a.sh', ['#!/bin/bash', com(8), code(40)].join('\n'), true).hard).toHaveLength(0)
  })
  test('header of an existing file is held to 5', () => {
    expect(verdict('a.py', [com(6), code(40)].join('\n'), false).hard).toHaveLength(1)
  })
  test('run over twice its limit is capped', () => {
    const f = verdict('a.py', middle(com(11))).hard[0]
    expect(f.capped).toBe(true)
    expect(f.keyText).toBeNull()
  })
  test('share 8/18 denied and capped, 7 under MIN_ABS passes', () => {
    const dense = [com(4), code(5), com(4), code(5)].join('\n')
    const v = verdict('a.py', dense)
    expect(v.hard).toHaveLength(1)
    expect(v.hard[0].msg).toMatch(/8\/18 added non-blank lines/)
    expect(v.hard[0].capped).toBe(true)
    expect(verdict('a.py', [com(4), code(1), com(3), code(1)].join('\n')).hard).toHaveLength(0)
  })
  test('date or version marker is soft', () => {
    const v = verdict('a.py', middle('# pinned at 1.2.3 as of 2026-01-01'))
    expect(v.soft.join(';')).toMatch(/date, version/)
  })
  test('ROT leaves IPv4 and CIDR alone', () => {
    expect(ROT.test('# allow 10.0.0.1 here')).toBe(false)
    expect(ROT.test('# net 10.1.2/24')).toBe(false)
    expect(ROT.test('# bumped to v1.2.3')).toBe(true)
  })
  test('untouched run of the old text passes', () => {
    const text = middle(com(7))
    expect(judge(text, text, kindOf('a.py'), 'a.py').hard).toHaveLength(0)
  })
})

describe('T7 whole-file replay', () => {
  const k = kindOf('a.py')
  test('growing a 4-run to 7 is denied', () => {
    const file = [code(10), com(4), code(10)].join('\n')
    const last = com(4).split('\n')[3]
    const v = judgeEdit(file, { old_string: last, new_string: [last, com(3, '#', 'extra')].join('\n') }, k, 'a.py')
    expect(v.hard).toHaveLength(1)
    expect(v.hard[0].runLines).toBe(7)
  })
  test('editing beside a 9-run passes', () => {
    const file = [code(10), com(9), code(10)].join('\n')
    expect(judgeEdit(file, { old_string: 'x5 = 5', new_string: 'x5 = 6' }, k, 'a.py').hard).toHaveLength(0)
  })
  test('one code line in a 60% comment file passes', () => {
    const file = [com(4), code(1), com(4), code(1), com(4), code(4)].join('\n')
    expect(judgeEdit(file, { old_string: 'x0 = 0', new_string: 'x0 = 0\ny = 1' }, k, 'a.py').hard).toHaveLength(0)
  })
  test('a reworded legacy run of equal length is denied however narrow the old_string', () => {
    const file = [code(10), com(7), code(10)].join('\n')
    const line = com(7).split('\n')[2]
    const v = judgeEdit(file, { old_string: line, new_string: line.replace('reason', 'cause') }, k, 'a.py')
    expect(v.hard[0].msg).toMatch(/run of 7 comment lines/)
    expect(v.hard[0].capped).toBe(false)
  })
  const words = Array.from({ length: 49 }, (_, i) => `word${i}`)
  const wrap = (w: number) => {
    const out: string[] = []
    let cur = '#'
    for (const x of words) {
      if (cur.length + x.length + 1 > w) {
        out.push(cur)
        cur = '#'
      }
      cur += ` ${x}`
    }
    return [...out, cur].join('\n')
  }
  test('a 7-line run rewrapped at 70 is soft', () => {
    const old = wrap(50)
    const fresh = wrap(70)
    expect(old.split('\n')).toHaveLength(7)
    expect(fresh.split('\n').length).toBe(6)
    const file = [code(10), old, code(10)].join('\n')
    const v = judgeEdit(file, { old_string: old, new_string: fresh }, k, 'a.py')
    expect(v.hard).toHaveLength(0)
    expect(v.soft.join(';')).toMatch(/touched a 6-line comment/)
  })
  test('one word replaced in 3 lines of a 7-run is denied', () => {
    const old = com(7)
    const edited = old.split('\n').map((l, i) => (i < 3 ? l.replace('reason', 'cause') : l)).join('\n')
    const v = judgeEdit([code(10), old, code(10)].join('\n'), { old_string: old, new_string: edited }, k, 'a.py')
    expect(v.hard[0].msg).toMatch(/run of 7 comment lines/)
  })
  test('one word changed on every line of a 7-run is denied', () => {
    const old = com(7)
    const edited = old.split('\n').map(l => l.replace('matters', 'counts')).join('\n')
    const v = judgeEdit([code(10), old, code(10)].join('\n'), { old_string: old, new_string: edited }, k, 'a.py')
    expect(v.hard[0].msg).toMatch(/run of 7 comment lines/)
  })
  test('old_string missing judges the fragments alone', () => {
    expect(judgeEdit(code(3), { old_string: 'nope', new_string: middle(com(6)) }, k, 'a.py').hard).toHaveLength(1)
  })
})

describe('share of the added lines', () => {
  const k = kindOf('a.py')
  const dense = [com(4), code(8), com(4), code(8), com(4), code(7), com(4), code(7)].join('\n')
  test('a Write over an existing 35% comment file counts only the lines it changes', () => {
    expect(judge(dense, dense, k, 'a.py').hard).toHaveLength(0)
    expect(judge(dense.replace('x3 = 3', 'x3 = 4'), dense, k, 'a.py').hard).toHaveLength(0)
  })
  test('an Edit whose old_string spans a legacy comment block counts only what it changes', () => {
    const doc = com(8)
    const body = 'def f():\n    a = 1\n    return a'
    const file = [code(30), doc, body, code(30)].join('\n')
    expect(judgeEdit(file, { old_string: `${doc}\n${body}`, new_string: `${doc}\n${body.replace('a = 1', 'a = 2')}` }, k, 'a.py').hard).toHaveLength(0)
    const legacy = com(9)
    const typo = judgeEdit([code(30), legacy, code(30)].join('\n'), { old_string: legacy, new_string: legacy.replace('premise 4', 'premiss 4') }, k, 'a.py')
    expect(typo.hard[0].msg).toMatch(/run of 9 comment lines/)
  })
  test('a Write that changes a legacy run is denied, one that changes code next to it passes', () => {
    const old = [code(10), com(7), code(10)].join('\n')
    expect(judge(old.replace('reason', 'cause'), old, k, 'a.py').hard[0].msg).toMatch(/run of 7/)
    expect(judge(old.replace('x3 = 3', 'x3 = 4'), old, k, 'a.py').hard).toHaveLength(0)
  })
  test('a run indented unchanged is not a change to it, one rewrapped longer is', () => {
    const run = com(7)
    const indented = run.split('\n').map(l => `    ${l}`).join('\n')
    const file = [code(30), run].join('\n')
    expect(judgeEdit(file, { old_string: run, new_string: `if x:\n${indented}` }, k, 'a.py').hard).toHaveLength(0)
    const longer = run.replace('\n', ' \n# ').split('\n').map(l => l.trimEnd()).join('\n')
    expect(judgeEdit(file, { old_string: run, new_string: longer }, k, 'a.py').hard).toHaveLength(1)
  })
  test('dense comments added to a long existing file are denied', () => {
    const v = judge([code(30), com(4), code(5), com(4), code(5)].join('\n'), code(30), k, 'a.py')
    expect(v.hard).toHaveLength(1)
    expect(v.hard[0].msg).toMatch(/8\/18 added non-blank lines/)
    expect(v.hard[0].capped).toBe(true)
  })
})

describe('T9 NEVER_COUNT and file kinds', () => {
  for (const l of ['//go:build linux', '//nolint:errcheck', '// +kubebuilder:object:root=true', '# syntax=docker/dockerfile:1',
    '# -- helm-docs value', '#!/bin/sh', '# noqa: E501']) {
    test(`${l} is not a comment`, () => {
      expect(NEVER_COUNT.test(l)).toBe(true)
    })
  }
  test('directives do not lengthen a run', () => {
    const text = [code(3), '//go:build linux', '//nolint:all', com(4, '//'), code(30)].join('\n')
    expect(runs(text, kindOf('a.go')).runs[0][1]).toHaveLength(4)
  })
  for (const p of ['a.gotmpl', 'a.bats', 'a.exs', 'app.Dockerfile']) {
    test(`${p} 7-run denied`, () => {
      expect(verdict(p, middle(com(7))).hard).toHaveLength(1)
    })
  }
})

describe('T11 headers', () => {
  test('helm template header of 6 in a new file passes', () => {
    expect(verdict('t.yaml', [block('{{- /*', '*/}}', 6), code(20, i => `k${i}: v`)].join('\n'), true).hard).toHaveLength(0)
  })
  test('20-line script with an 8-line header passes', () => {
    expect(verdict('s.sh', ['#!/usr/bin/env bash', com(8), code(11, i => `echo ${i}`)].join('\n'), true).hard).toHaveLength(0)
  })
})

describe('commit', () => {
  const msg = (n: number) => ['subject', '', ...Array.from({ length: n }, (_, i) => `body line ${i}`)].join('\n')
  test('body 10 passes, 11 denied, 21 capped', () => {
    expect(judgeBody(msg(10))).toBeNull()
    const f = judgeBody(msg(11))
    expect(f?.section).toBe('Commit message')
    expect(f?.capped).toBe(false)
    expect(judgeBody(msg(21))?.capped).toBe(true)
    expect(judgeBody('subject only')).toBeNull()
  })
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `l${i}`).join('\n')
  test('-m s -m body joins as git does', () => {
    const c = parseCommit(`git commit -m s -m "${lines(11)}"`)
    expect(judgeBody(c?.msg ?? '')?.runLines).toBe(11)
    expect(judgeBody(parseCommit(`git commit -m s -m "${lines(10)}"`)?.msg ?? '')).toBeNull()
  })
  test('-qm, --message= and -am', () => {
    expect(parseCommit(`git commit -qm "s\n\n${lines(11)}"`)?.msg).toMatch(/^s\n/)
    expect(parseCommit(`git commit --message="s\n\n${lines(11)}"`)?.msg).toMatch(/l10/)
    const am = parseCommit('git commit -am "s"')
    expect(am?.all).toBe(true)
    expect(am?.msg).toBe('s')
    expect(parseCommit('git commit -m s')?.all).toBe(false)
  })
  test('heredoc body counts from the commit line', () => {
    const cmd = `cat > a.py <<'X'\n${com(3)}\nX\ngit commit -F- <<'M'\nsubject\n\n${lines(15)}\nM`
    expect(judgeBody(parseCommit(cmd)?.msg ?? '')?.runLines).toBe(15)
  })
  test('git -C and -c forms', () => {
    expect(parseCommit('git -C r commit -m x')?.repo).toBe('r')
    expect(parseCommit('git -c k=v commit -m x')?.msg).toBe('x')
    expect(parseCommit('git -C r -c k=v commit -m x')?.repo).toBe('r')
  })
  test('git and commit in a path are not a commit', () => {
    expect(parseCommit(`git rm skills/git/git-commit.md && cat > a.md <<'E'\n${lines(14)}\nE`)).toBeNull()
    expect(parseCommit('git --no-pager commit -m x')?.msg).toBe('x')
    expect(parseCommit('cd r && /usr/bin/git commit -m x')?.msg).toBe('x')
  })
  test('grep -m before the commit is not a message', () => {
    expect(parseCommit('grep -m 5 foo f; git commit -m s')?.msg).toBe('s')
    expect(parseCommit('git commit -m s | grep -m 5 x')?.msg).toBe('s')
  })
  test('same-command git add files', () => {
    expect(parseCommit('git add b.py a.py -f && git commit -m x')?.adds).toEqual(['a.py', 'b.py'])
    expect(parseCommit('git -C r add a.py && git -C r commit -m x')?.adds).toEqual(['a.py'])
  })
  test('git commit inside a heredoc body is data', () => {
    expect(parseCommit(`cat > s.sh <<'E'\ngit commit -m x\nE`)).toBeNull()
    expect(parseCommit('git status')).toBeNull()
  })
})

describe('bash parsing', () => {
  test('heredoc targets', () => {
    expect(heredocTargets("cat > a.py <<'EOF'\nx = 1\nEOF").map(t => t.target)).toEqual(['a.py'])
    expect(heredocTargets('cat <<EOF > b.py\nx = 1\nEOF')[0].target).toBe('b.py')
    expect(heredocTargets('tee -a c.py <<EOF\nx = 1\nEOF')[0].target).toBe('c.py')
    expect(heredocTargets('cat <<EOF | tee d.py\nx = 1\nEOF')[0].target).toBe('d.py')
    expect(heredocTargets('cat <<-EOF > e.py\n\tx = 1\n\tEOF')[0].body).toBe('\tx = 1')
    expect(heredocTargets("cat > a.py <<'A'\nx\nA\ncat > b.py <<'B'\ny\nB").map(t => t.target)).toEqual(['a.py', 'b.py'])
    expect(heredocTargets('ls > out.txt')).toEqual([])
  })
  test('resolver expands VAR=, env, ~ and cd', () => {
    const env = { HOME: '/home/u', TMPDIR: '/var/t', PWD: '/repo' }
    const r = resolver('D=sub; cd w && cat > $D/a.py', '/repo', env)
    expect(r.workdir).toBe('/repo/w')
    expect(r.expand('$D/a.py', r.workdir)).toBe('/repo/w/sub/a.py')
    expect(r.expand('~/x.py')).toBe('/home/u/x.py')
    expect(r.expand('$TMPDIR/x.py')).toBe('/var/t/x.py')
    expect(r.expand('${PWD}/x.py')).toBe('/repo/x.py')
    expect(r.expand('$NOPE/x.py')).toBe('/repo/$NOPE/x.py')
    expect(r.expand("'q.py'")).toBe('/repo/q.py')
  })
  test('heredoc forms with mkdir, cd and tee', () => {
    const t = (cmd: string) => heredocTargets(cmd).map(h => h.target)
    expect(t("mkdir -p sub && cat > sub/a.py <<'EOF'\nx\nEOF")).toEqual(['sub/a.py'])
    const cd = "cd sub && cat > a.py <<'EOF'\nx\nEOF"
    expect(t(cd)).toEqual(['a.py'])
    const r = resolver(cd, '/w', {})
    expect(r.expand(t(cd)[0], r.workdir)).toBe('/w/sub/a.py')
    expect(t("tee f.py <<'EOF'\nx\nEOF")).toEqual(['f.py'])
    expect(t("cat > 'q.py' <<'EOF'\nx\nEOF")).toEqual(["'q.py'"])
  })
  test('named tokens', () => {
    expect(namedTokens('cp a.py src/b && sed -i s/x/y/ Makefile notes')).toEqual(['a.py', 'src/b', 's/x/y/', 'Makefile'])
  })
})

describe('hunks as input', () => {
  const k = kindOf('a.py')
  test('T5: 3 lines top and 3 bottom of a new file pass', () => {
    expect(judge([[1, com(3)], [20, com(3)]], '', k, 'a.py', { newFile: true }).hard).toHaveLength(0)
  })
  test('finding carries the file line, offset by the hunk base', () => {
    const v = judge([[12, [code(2), com(6)].join('\n')]], '', k, 'a.py')
    expect(v.hard[0].at).toBe('a.py:14')
  })
  test('the header budget applies only to a hunk at line 1', () => {
    expect(judge([[1, [com(7), code(20)].join('\n')]], '', k, 'a.py', { newFile: true }).hard).toHaveLength(0)
    expect(judge([[5, [com(7), code(20)].join('\n')]], '', k, 'a.py', { newFile: true }).hard).toHaveLength(1)
  })
  test('two 3-line hunks are not one run', () => {
    expect(judge([[3, com(3)], [6, com(3)]], '', k, 'a.py').hard).toHaveLength(0)
  })
})

describe('addedVs', () => {
  test('a copy adds nothing, an append is one hunk at its line', () => {
    expect(addedVs(code(5), code(5))).toEqual([])
    expect(addedVs(code(5), `${code(5)}\n${com(2)}`)).toEqual([[6, com(2)]])
  })
})

describe('addedOf', () => {
  test('a diff section gives its hunks; a tracked file without one adds nothing; an untracked file is new as a whole', () => {
    const chunk = 'diff --git a/f b/f\n+++ b/f\n@@ -1,0 +2,1 @@\n+a\n'
    expect(addedOf(chunk, 'whole', true)).toEqual({ added: [[2, 'a']], newFile: false })
    expect(addedOf(chunk, 'whole', false)).toEqual({ added: [[2, 'a']], newFile: false })
    expect(addedOf(undefined, 'whole', true)).toBeNull()
    expect(addedOf(undefined, 'whole', false)).toEqual({ added: 'whole', newFile: true })
  })
})

describe('diffs', () => {
  test('hunks per @@', () => {
    const d = 'diff --git a/f b/f\n+++ b/f\n@@ -1,0 +2,2 @@\n+a\n+b\n@@ -9 +12 @@\n-old\n+c\n'
    expect(hunks(d)).toEqual([[2, 'a\nb'], [12, 'c']])
  })
})

describe('guide text', () => {
  const guide = ['# Guide', '## Code comments. Budget', 'keep it short', '```', '## inside a fence', '```', 'tail',
    '## In-file header', 'two lines', '## Commit message', 'subject plus body'].join('\n')
  test('section stops at the next heading, ignores fenced ones', () => {
    expect(section(guide, 'Code comments')).toBe(['## Code comments. Budget', 'keep it short', '```', '## inside a fence', '```', 'tail'].join('\n'))
    expect(section(guide, 'Nope')).toBe('')
  })
  test('reason carries the section and the right task', () => {
    const f = verdict('a.py', middle(com(6))).hard
    const r = reason(f, guide)
    expect(r.startsWith('comment-guard:')).toBe(true)
    expect(r).toContain('keep it short')
    expect(r).toMatch(/resubmit/)
    expect(reason(verdict('a.py', middle(com(12))).hard, guide)).toMatch(/Rewrite the comment\.$/)
    expect(reason(f, guide, true)).toMatch(/already written/)
    const body = judgeBody(['s', '', ...Array.from({ length: 11 }, (_, i) => `b${i}`)].join('\n'))
    expect(reason(body ? [body] : [], guide)).toContain('subject plus body')
  })
  test('reason stays near 3000 chars', () => {
    const big = `## Code comments\n${'x'.repeat(20000)}`
    expect(reason(verdict('a.py', middle(com(6))).hard, big).length <= 3000).toBe(true)
  })
})

/** Runs fn with Windows path handling on, restoring POSIX after. */
const onWindows = (fn: () => void) => () => {
  setWindows(true)
  try { fn() } finally { setWindows(false) }
}

describe('paths', () => {
  test('macOS and Linux paths pass unchanged, a backslash included', () => {
    expect(slash('/w/a.py')).toBe('/w/a.py')
    expect(slash('/c/x')).toBe('/c/x')
    expect(slash('a\\ b.py')).toBe('a\\ b.py')
    expect(dirname('/a')).toBe('/')
    expect(dirname('/')).toBe('/')
    expect(norm('/a/./b/../c')).toBe('/a/c')
    expect(isAbs('C:\\x')).toBe(false)
  })
  test('Windows paths get one spelling', onWindows(() => {
    expect(slash('C:\\Users\\u\\a.py')).toBe('C:/Users/u/a.py')
    expect(slash('c:/x')).toBe('C:/x')
    expect(slash('/c/Users/u')).toBe('C:/Users/u')
    expect(slash('/cygdrive/d/x')).toBe('D:/x')
    expect(slash('/w/a.py')).toBe('W:/a.py')
    expect(isAbs('C:\\x')).toBe(true)
    expect(join('C:\\w', 'sub\\a.py')).toBe('C:/w/sub/a.py')
    expect(basename('C:\\w\\a.py')).toBe('a.py')
    expect(dirname('C:/w')).toBe('C:/')
    expect(dirname('C:/')).toBe('C:/')
    expect(norm('C:\\w\\..\\x\\.\\a.py')).toBe('C:/x/a.py')
    expect(lang('C:\\Users\\u\\AppData\\Local\\Temp\\x.py')).toBeNull()
    expect(lang('C:\\w\\docs\\a.py')).toBeNull()
    expect(lang('C:\\w\\a.py')).not.toBeNull()
  }))
  test('PowerShell cd, $env: and ~ resolve', onWindows(() => {
    const r = resolver('Set-Location C:\\w\\sub; Get-Content x', 'C:\\w', { HOME: 'C:/Users/u', USERPROFILE: 'C:/Users/u' })
    expect(r.workdir).toBe('C:/w/sub')
    expect(r.expand('$env:USERPROFILE\\x.py')).toBe('C:/Users/u/x.py')
    expect(r.expand('~\\x.py')).toBe('C:/Users/u/x.py')
    expect(r.expand('a.py', r.workdir)).toBe('C:/w/sub/a.py')
  }))
})

describe('PowerShell parsing', () => {
  test('here-string targets', () => {
    expect(heredocTargets("@'\nx = 1\n'@ | Set-Content -Path a.py -Encoding utf8").map(t => t.target)).toEqual(['a.py'])
    expect(heredocTargets('@"\nx = 1\n"@ | Out-File b.py')[0]).toEqual({ target: 'b.py', body: 'x = 1' })
    expect(heredocTargets("Set-Content -LiteralPath c.py -Value @'\nx = 1\n'@")[0].target).toBe('c.py')
    expect(heredocTargets("@'\r\nx = 1\r\n'@ | Add-Content d.py")[0].target).toBe('d.py')
    expect(heredocTargets("$s = @'\nx\n'@")).toEqual([])
  })
  test('redirect targets of cmdlets', () => {
    expect(redirectTargets('Get-Date | Out-File -FilePath e.py -Encoding utf8')).toEqual(['e.py'])
    expect(redirectTargets('Set-Content f.py "x"')).toEqual(['f.py'])
  })
  test('git commit with a here-string message', () => {
    const c = parseCommit("git add a.py; git commit -m @'\nfix: x\n\nwhy; it matters\n'@")
    expect(c?.msg).toBe('fix: x\n\nwhy; it matters')
    expect(c?.adds).toEqual(['a.py'])
  })
})
