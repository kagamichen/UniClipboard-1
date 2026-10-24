import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const repositoryRoot = resolve(__dirname, '../..')
const checker = resolve(repositoryRoot, 'scripts/architecture/check-engine-lock-consistency.mjs')

// The real transitional lag shipped on main while the HarmonyOS binding work
// awaits an official Engine release carrying the HAR (W1.2).
const REAL_CARGO_COMMIT = 'a8e1b2c912cebbbb835049d3bc343cfe9a036bb7'
const REAL_LOCK = {
  release: 'v1.1.0-rc.22',
  commit: '18415aa83a47bd3870c2a1f114b268fc3ed0495a',
  minimumApi: 24,
  artifact: 'UniClipboardEngine.har',
  sha256: 'df65472233da55754e7108b6dcef30ad777faab1efe0504c706411c19a461cb7',
  size: 30451988,
}

const roots: string[] = []

function writeTree(cargoCommit: string, lock: object) {
  const root = mkdtempSync(join(tmpdir(), 'engine-lock-consistency-'))
  roots.push(root)
  writeFileSync(
    join(root, 'Cargo.toml'),
    `[workspace.dependencies]\nuc-engine = { git = "https://github.com/UniClipboard/Engine.git", rev = "${cargoCommit}" }\n`
  )
  mkdirSync(join(root, 'apps/ohos'), { recursive: true })
  writeFileSync(join(root, 'apps/ohos/engine-lock.json'), `${JSON.stringify(lock, null, 2)}\n`)
  return root
}

function run(root: string) {
  return spawnSync(process.execPath, [checker, root], { encoding: 'utf8' })
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('desktop and HarmonyOS Engine lock consistency', () => {
  it('passes when both pins point at the same Engine commit', () => {
    const commit = 'b'.repeat(40)
    const root = writeTree(commit, { ...REAL_LOCK, commit })
    const result = run(root)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`Engine lock consistent at v1.1.0-rc.22 (${'b'.repeat(12)})`)
  })

  it('accepts only the exact documented transitional lag', () => {
    const result = run(writeTree(REAL_CARGO_COMMIT, REAL_LOCK))
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('accepted transitional lag')
  })

  it('flags the rc.22 drift drill when either side of the lag moves alone', () => {
    // Desktop adopted the newer Engine while the HarmonyOS official lock was
    // left behind on rc.22 with a different commit: must fail.
    const newerCommit = 'c'.repeat(40)
    const drifted = run(writeTree(newerCommit, REAL_LOCK))
    expect(drifted.status).toBe(1)
    expect(drifted.stderr).toContain('disagree')

    // Same desktop commit but the lock was hand-edited to another release.
    const editedLock = run(writeTree(REAL_CARGO_COMMIT, { ...REAL_LOCK, release: 'v1.1.0-rc.21' }))
    expect(editedLock.status).toBe(1)
    expect(editedLock.stderr).toContain('disagree')
  })

  it('fails loudly on a malformed lock or a missing desktop pin', () => {
    const noPin = mkdtempSync(join(tmpdir(), 'engine-lock-consistency-'))
    roots.push(noPin)
    writeFileSync(join(noPin, 'Cargo.toml'), '[workspace.dependencies]\n')
    mkdirSync(join(noPin, 'apps/ohos'), { recursive: true })
    writeFileSync(
      join(noPin, 'apps/ohos/engine-lock.json'),
      `${JSON.stringify({ ...REAL_LOCK, commit: 'short' }, null, 2)}\n`
    )
    const result = run(noPin)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('pinned uc-engine revision')
  })

  it('keeps the real repository tree at a passing state', () => {
    expect(() =>
      execFileSync(process.execPath, [checker], { cwd: repositoryRoot, encoding: 'utf8' })
    ).not.toThrow()
    const content = readFileSync(join(repositoryRoot, 'apps/ohos/engine-lock.json'), 'utf8')
    expect(JSON.parse(content).release).toBe(REAL_LOCK.release)
  })
})
