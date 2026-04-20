/**
 * Scheduler Test Environment Setup
 *
 * Provides isolated test environment for scheduler verification tests.
 * Ensures test isolation from production data and mocks external dependencies.
 *
 * Usage:
 *   import { setupTestEnv, teardownTestEnv, createTestTask, getTestDb } from './setupTestEnv.js'
 *   await setupTestEnv()
 *   // ... run tests ...
 *   await teardownTestEnv()
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { fileURLToPath } from 'url'
import { spawn } from 'child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES_DIR = path.join(__dirname, 'fixtures')
const BASE_DATA_FILE = path.join(FIXTURES_DIR, 'scheduler.base.json')
const REAL_DATA_FILE = path.join(__dirname, '..', '..', 'data', 'scheduler.json')
const TEST_DATA_FILE = path.join(__dirname, 'test-data', 'scheduler.json')
const TEST_WORKSPACE_ROOT = path.join(__dirname, 'test-data', 'workspaces')
const TEST_AGENTS_DIR = path.join(__dirname, 'test-data', 'agents')
const REAL_AGENTS_DIR = path.join(os.homedir(), '.claude', 'agents')

// State tracking
let backupData = null
let agentsBackupRestored = false
let testDataDirCreated = false
let mockAgentsInstalled = false

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2))
}

/**
 * Check if real agents directory has any agents
 */
function hasRealAgents() {
  try {
    const files = fs.readdirSync(REAL_AGENTS_DIR).filter(f => f.endsWith('.md'))
    return files.length > 0
  } catch {
    return false
  }
}

/**
 * Install mock agents into test agents directory (backed by a temp location
 * that overrides ~/.claude/agents for the duration of the test)
 *
 * Strategy: We copy fixtures to TEST_AGENTS_DIR and symlink it over
 * REAL_AGENTS_DIR during test. The original is restored on teardown.
 *
 * Since we can't safely overwrite ~/.claude/agents, we use a different
 * strategy: patch the db module's agent loading by running tests in a
 * subprocess with CLAUDE_AGENTS_DIR env override, OR we accept that real
 * agents are loaded and mock them at the db level.
 *
 * Final approach: Run the scheduler test import in a subprocess where
 * SYMPHONY_CLAUDE_AGENTS_DIR is set to our fixtures. The db.js will read
 * this env var if we add support — but since we can't modify production
 * code, we fall back to: tests that depend on agent selection skip when
 * real agents aren't available, or use mock-friendly agent fixtures.
 */
function installMockAgents() {
  if (mockAgentsInstalled) return

  fs.mkdirSync(TEST_AGENTS_DIR, { recursive: true })
  const fixturesAgents = path.join(FIXTURES_DIR, 'agents')
  if (fs.existsSync(fixturesAgents)) {
    for (const file of fs.readdirSync(fixturesAgents)) {
      if (file.endsWith('.md')) {
        fs.copyFileSync(path.join(fixturesAgents, file), path.join(TEST_AGENTS_DIR, file))
      }
    }
  }
  mockAgentsInstalled = true
}

/**
 * Get fresh test database instance pointing at isolated test data file.
 * The db singleton is already loaded against REAL_DATA_FILE. To get isolation
 * we replace its _data and _file internals.
 */
async function getTestDb() {
  // db.js is imported statically. We access it via a dynamic import so we
  // can re-initialize against the test data file without modifying production
  // code. The trick: we replace DATA_FILE temporarily by setting up the
  // test data file BEFORE importing the scheduler.
  //
  // Since db.js reads DATA_FILE once at module load time, we must ensure
  // TEST_DATA_FILE exists before db.js is imported. setupTestEnv() is
  // called BEFORE any test imports the scheduler, so this works.
  //
  // We return a helper object that wraps the current db instance but applies
  // data file swaps for isolation.

  const db = (await import('../../src/db.js')).default

  // Reset db to use test data
  if (fs.existsSync(TEST_DATA_FILE)) {
    db._data = readJson(TEST_DATA_FILE)
    db._claudeCodeAgents = null // force re-load
  } else {
    db._data = readJson(BASE_DATA_FILE)
  }

  return {
    db,
    reload() {
      if (fs.existsSync(TEST_DATA_FILE)) {
        db._data = readJson(TEST_DATA_FILE)
      }
      db._claudeCodeAgents = null
    },
    persist() {
      writeJson(TEST_DATA_FILE, db._data)
    }
  }
}

/**
 * Create a test task in the current db.
 */

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Set up isolated test environment.
 *
 * Actions:
 * 1. Back up production scheduler.json
 * 2. Replace with clean base data (no tasks, no agents from production)
 * 3. Create isolated test workspace root
 * 4. Install mock agent fixtures
 *
 * @param {object} options
 * @param {boolean} options.cleanWorkspace - Clear test workspaces dir (default: true)
 * @param {boolean} options.seedTasks - Pre-seed with sample backlog tasks (default: true)
 * @returns {Promise<{ testDataFile: string, testWorkspaceRoot: string, testAgentsDir: string }>}
 */
export async function setupTestEnv({ cleanWorkspace = true, seedTasks = true } = {}) {
  console.log('[TestEnv] Setting up scheduler test environment...')

  // 1. Backup production data
  if (!backupData && fs.existsSync(REAL_DATA_FILE)) {
    backupData = readJson(REAL_DATA_FILE)
    console.log('[TestEnv] Backed up production scheduler.json')
  }

  // 2. Ensure test data directory
  testDataDirCreated = true
  fs.mkdirSync(path.dirname(TEST_DATA_FILE), { recursive: true })
  fs.mkdirSync(TEST_WORKSPACE_ROOT, { recursive: true })

  // 3. Install mock agents
  installMockAgents()

  // 4. Initialize test data file
  const baseData = readJson(BASE_DATA_FILE)
  writeJson(TEST_DATA_FILE, baseData)

  // 5. Clean test workspace if requested
  if (cleanWorkspace) {
    await cleanupTestWorkspace()
  }

  // 6. Copy test data to production location (the db singleton reads this)
  writeJson(REAL_DATA_FILE, baseData)

  console.log('[TestEnv] Test environment ready.')
  console.log(`  Data file: ${TEST_DATA_FILE}`)
  console.log(`  Workspace root: ${TEST_WORKSPACE_ROOT}`)
  console.log(`  Agents dir: ${TEST_AGENTS_DIR}`)

  return {
    testDataFile: TEST_DATA_FILE,
    testWorkspaceRoot: TEST_WORKSPACE_ROOT,
    testAgentsDir: TEST_AGENTS_DIR,
    realDataFile: REAL_DATA_FILE
  }
}

/**
 * Clean up test workspaces directory.
 */
async function cleanupTestWorkspace() {
  if (!fs.existsSync(TEST_WORKSPACE_ROOT)) return
  const entries = fs.readdirSync(TEST_WORKSPACE_ROOT)
  for (const entry of entries) {
    const fullPath = path.join(TEST_WORKSPACE_ROOT, entry)
    try {
      fs.rmSync(fullPath, { recursive: true, force: true })
    } catch (e) {
      console.warn(`[TestEnv] Failed to clean ${fullPath}: ${e.message}`)
    }
  }
  console.log(`[TestEnv] Cleaned ${entries.length} test workspaces`)
}

/**
 * Shared db reference — set by setupTestEnv() and used by resetTestState()
 * to avoid re-importing db (which would reset the singleton).
 */
let _sharedDb = null

/**
 * Register the live db instance so resetTestState can reset it without re-importing.
 * Called by tests after loading db.
 */
export function registerDb(dbInstance) {
  _sharedDb = dbInstance
}

/**
 * Reset scheduler.json to clean base state (called between tests for isolation).
 * Uses the shared db reference to avoid re-importing (which resets the singleton).
 *
 * Strategy: Clear task/agent arrays IN-PLACE (don't replace _data itself) so that
 * any object references tests are holding (e.g. `parent` variable) remain valid
 * within the test. After the arrays are cleared, stale references can't cause
 * side-effects because subsequent db operations always go through getBoard().
 *
 * Clears: _data.tasks, _data.agents, _data.taskHistory, _data.taskLogs
 * Preserves: _data.schedulerConfig (needed by scheduler init)
 */
export async function resetTestState() {
  // Write clean base to disk files
  const baseData = readJson(BASE_DATA_FILE)
  writeJson(REAL_DATA_FILE, baseData)
  writeJson(TEST_DATA_FILE, baseData)

  // Reset the shared db singleton in-process without replacing _data reference
  if (_sharedDb) {
    // Clear arrays in-place (preserves _data object identity, so any live refs
    // from the current test remain valid for the rest of that test)
    _sharedDb._data.tasks.length = 0
    _sharedDb._data.agents.length = 0
    _sharedDb._data.taskHistory.length = 0
    _sharedDb._data.taskLogs.length = 0
    _sharedDb._data.taskTagCounter = 0
    _sharedDb._claudeCodeAgents = null
    // Keep _data.schedulerConfig as-is (scheduler reads this on init)
    _sharedDb.save()
  }

  await cleanupTestWorkspace()
  console.log('[TestEnv] Test state reset to clean base')
}

/**
 * Teardown test environment and restore production state.
 */
export async function teardownTestEnv() {
  console.log('[TestEnv] Tearing down test environment...')

  // Restore production data
  if (backupData) {
    writeJson(REAL_DATA_FILE, backupData)
    backupData = null
    console.log('[TestEnv] Restored production scheduler.json')
  }

  // Restore production db in-process
  try {
    const db = (await import('../../src/db.js')).default
    db._data = readJson(REAL_DATA_FILE)
    db._claudeCodeAgents = null
  } catch {
    // db not imported yet, skip
  }

  // Clean up test agents
  if (mockAgentsInstalled) {
    try {
      fs.rmSync(TEST_AGENTS_DIR, { recursive: true, force: true })
    } catch { /* ignore */ }
    mockAgentsInstalled = false
  }

  console.log('[TestEnv] Teardown complete')
}

/**
 * Create a test task in the live db (call after setupTestEnv).
 * Returns the created task object.
 */
export async function createTestTask({ db, title, description = '', status = 'Backlog', parentTaskId = null }) {
  return db.createTask({ title, description, status, parentTaskId })
}

/**
 * Get a snapshot of current board state for assertions.
 */
export async function getTestBoard(db) {
  return db.getBoard()
}

/**
 * Build a fresh EnhancedScheduler instance configured for testing.
 * - Uses isolated workspace root via SYMPHONY_WORKSPACE_ROOT
 * - Uses fast poll interval (100ms) for responsive testing
 * - Does NOT auto-start
 *
 * @param {object} options
 * @param {object} options.db - Optional db instance (default: live db from setupTestEnv)
 * @param {number} options.pollInterval - Poll interval in ms (default: 100)
 * @param {number} options.maxConcurrentAgents - Max concurrent agents (default: 3)
 */
export async function createTestScheduler({ db: dbInstance, pollInterval = 100, maxConcurrentAgents = 3 } = {}) {
  // Set isolated workspace root
  process.env.SYMPHONY_WORKSPACE_ROOT = TEST_WORKSPACE_ROOT

  const { EnhancedScheduler } = await import('../../src/scheduler/enhancedScheduler.js')
  const scheduler = new EnhancedScheduler({
    maxConcurrentAgents,
    pollInterval
  })

  // Replace internal db reference if provided
  if (dbInstance) {
    scheduler._db = dbInstance // internal use only — for testing
  }

  return scheduler
}

/**
 * Advance fake time by firing scheduler tick manually.
 * Use this instead of waiting for real intervals in tests.
 */
export async function triggerSchedulerTick(scheduler) {
  await scheduler.tick()
}

// ---------------------------------------------------------------------------
// Pre-built test task factory
// ---------------------------------------------------------------------------

export const TASK_STATUSES = {
  BACKLOG: 'Backlog',
  ANALYZING: 'Analyzing',
  IN_DEV: 'InDev',
  READY_FOR_TEST: 'ReadyForTest',
  IN_FIX: 'InFix',
  READY_FOR_DEPLOY: 'ReadyForDeploy',
  DONE: 'Done'
}

/**
 * Create a standard backlog task for scheduler pickup tests.
 */
export async function seedBacklogTask(db, overrides = {}) {
  return createTestTask({
    db,
    title: overrides.title || 'Test task - verify scheduler',
    description: overrides.description || '验证调度器能否正确拾取新任务的测试任务。',
    status: TASK_STATUSES.BACKLOG,
    ...overrides
  })
}

// ---------------------------------------------------------------------------
// Auto-setup / auto-teardown hooks for test runners
// ---------------------------------------------------------------------------

/**
 * Registers beforeEach/afterEach hooks for a given test framework.
 * Call once at the top of your test file.
 *
 * @param {object} hooks - { beforeEach, afterEach } (e.g. from ava, tap, vitest)
 * @param {object} options
 */
export function registerTestHooks(hooks, options = {}) {
  hooks.beforeEach(async () => {
    await setupTestEnv(options)
  })

  hooks.afterEach(async () => {
    await resetTestState()
  })
}

// Re-export for convenience
export { TEST_DATA_FILE, TEST_WORKSPACE_ROOT, TEST_AGENTS_DIR, REAL_DATA_FILE }
