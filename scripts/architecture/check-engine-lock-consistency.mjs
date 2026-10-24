#!/usr/bin/env node

// Keeps the desktop Engine pin (Cargo.toml uc-engine rev) and the HarmonyOS
// official HAR lock (apps/ohos/engine-lock.json) on the same Engine source.
// adopt-engine-release.mjs updates both atomically, so any remaining mismatch
// is drift: one side was edited without adopting a real release.

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = resolve(SCRIPT_DIR, '../..')

// Transitional exception (mirrors the cargo-audit exception pattern): the
// desktop dependency already tracks a post-rc.22 Engine commit, while the
// HarmonyOS official HAR lock stays at v1.1.0-rc.22 because Engine has not
// published a release carrying the ohos client's binding work yet (W1.2 in
// .planning/research/harmony-client/COMPLETION_PLAN.md). The lag is accepted
// only for this exact pair; when either side moves, adoption must update both
// and this exception has to be removed.
const EXPECTED_TRANSITIONAL_LAG = {
  cargoCommit: 'a8e1b2c912cebbbb835049d3bc343cfe9a036bb7',
  lockRelease: 'v1.1.0-rc.22',
  lockCommit: '18415aa83a47bd3870c2a1f114b268fc3ed0495a',
}

const root = resolve(process.argv[2] ?? DEFAULT_ROOT)

function fail(message) {
  process.stderr.write(`Engine lock consistency: ${message}\n`)
  process.exit(1)
}

const cargo = readFileSync(join(root, 'Cargo.toml'), 'utf8')
const cargoMatch = cargo.match(/^uc-engine\s*=\s*\{[^\n]*rev\s*=\s*"([0-9a-f]{40})"[^\n]*\}$/m)
if (!cargoMatch) fail('Cargo.toml does not contain a pinned uc-engine revision')

const lock = JSON.parse(readFileSync(join(root, 'apps/ohos/engine-lock.json'), 'utf8'))
if (typeof lock.release !== 'string' || !/^[0-9a-f]{40}$/.test(lock.commit ?? '')) {
  fail('apps/ohos/engine-lock.json is not a valid official Engine lock')
}

const cargoCommit = cargoMatch[1]
if (cargoCommit === lock.commit) {
  process.stdout.write(
    `Engine lock consistent at ${lock.release} (${cargoCommit.slice(0, 12)})\n`
  )
  process.exit(0)
}

const transitional =
  cargoCommit === EXPECTED_TRANSITIONAL_LAG.cargoCommit &&
  lock.release === EXPECTED_TRANSITIONAL_LAG.lockRelease &&
  lock.commit === EXPECTED_TRANSITIONAL_LAG.lockCommit
if (transitional) {
  process.stdout.write(
    `Engine lock at the accepted transitional lag: desktop ${cargoCommit.slice(0, 12)}, ` +
      `ohos official ${lock.release} (${lock.commit.slice(0, 12)}); see the exception note in ` +
      `check-engine-lock-consistency.mjs\n`
  )
  process.exit(0)
}

fail(
  `desktop uc-engine rev ${cargoCommit} and apps/ohos/engine-lock.json ${lock.release} ` +
    `(${lock.commit}) disagree; run scripts/adopt-engine-release.mjs so both track one release, ` +
    `or update the transitional exception with fresh justification`
)
