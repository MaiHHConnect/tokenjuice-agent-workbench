/**
 * Standalone test isolation cleanup script.
 *
 * Run this before a test suite to ensure clean state, or after a failed test
 * to restore production data.
 *
 * Usage:
 *   node cleanupTestState.js          # full reset (backup + cleanup)
 *   node cleanupTestState.js --restore # restore from backup only
 *   node cleanupTestState.js --check   # check current state
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import os from 'os'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REAL_DATA_FILE = path.join(__dirname, '..', '..', 'data', 'scheduler.json')
const BASE_DATA_FILE = path.join(__dirname, 'fixtures', 'scheduler.base.json')
const TEST_DATA_DIR = path.join(__dirname, 'test-data')
const BACKUP_FILE = path.join(TEST_DATA_DIR, '.scheduler.backup.json')

const mode = process.argv[2]

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf-8')) }
function writeJson(p, d) { fs.writeFileSync(p, JSON.stringify(d, null, 2)) }

async function ensureBackup() {
  if (!fs.existsSync(REAL_DATA_FILE)) {
    console.log('[Cleanup] No production data file found — nothing to back up')
    return null
  }
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true })
  const data = readJson(REAL_DATA_FILE)
  writeJson(BACKUP_FILE, data)
  console.log(`[Cleanup] Backed up production data to ${BACKUP_FILE}`)
  return data
}

async function restore() {
  if (!fs.existsSync(BACKUP_FILE)) {
    console.error('[Cleanup] No backup file found — cannot restore')
    process.exit(1)
  }
  const data = readJson(BACKUP_FILE)
  writeJson(REAL_DATA_FILE, data)
  console.log('[Cleanup] Restored production data from backup')
}

async function check() {
  if (!fs.existsSync(REAL_DATA_FILE)) {
    console.log('[Check] Production data file: MISSING')
  } else {
    const data = readJson(REAL_DATA_FILE)
    console.log('[Check] Production data:')
    console.log(`  Tasks: ${data.tasks?.length || 0}`)
    console.log(`  Agents: ${data.agents?.length || 0}`)
    console.log(`  Active tasks: ${
      data.tasks?.filter(t => ['InDev', 'InFix', 'Analyzing'].includes(t.status) && t.assignedAgentId).length || 0
    }`)
  }
  if (fs.existsSync(BACKUP_FILE)) {
    const bk = readJson(BACKUP_FILE)
    console.log(`[Check] Backup exists: ${bk.tasks?.length || 0} tasks`)
  }
  if (fs.existsSync(TEST_DATA_DIR)) {
    const files = fs.readdirSync(TEST_DATA_DIR).filter(f => !f.startsWith('.'))
    console.log(`[Check] Test data dir: ${files.length} files/dirs`)
  }
}

async function fullReset() {
  await ensureBackup()
  if (fs.existsSync(BACKUP_FILE)) {
    // Restore backup as current state (production restore)
    await restore()
  }
  // Clean test data dir
  if (fs.existsSync(TEST_DATA_DIR)) {
    for (const entry of fs.readdirSync(TEST_DATA_DIR)) {
      if (entry.startsWith('.')) continue
      fs.rmSync(path.join(TEST_DATA_DIR, entry), { recursive: true, force: true })
    }
    console.log('[Cleanup] Test data directory cleared')
  }
  // Reset in-process db if imported
  try {
    const db = (await import('../../src/db.js')).default
    const productionData = fs.existsSync(REAL_DATA_FILE) ? readJson(REAL_DATA_FILE) : readJson(BASE_DATA_FILE)
    db._data = productionData
    db._claudeCodeAgents = null
    console.log('[Cleanup] In-process db state reset')
  } catch {
    // db not yet imported, skip
  }
  console.log('[Cleanup] Full reset complete')
}

switch (mode) {
  case '--restore':
    restore()
    break
  case '--check':
    check()
    break
  default:
    fullReset()
}
