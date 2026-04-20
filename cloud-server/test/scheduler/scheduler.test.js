/**
 * Scheduler Pickup Verification Tests
 *
 * Verifies the scheduler correctly detects and picks up new tasks.
 *
 * Test environment is prepared by setupTestEnv.js which:
 * 1. Backs up production scheduler.json
 * 2. Loads clean base data (no residual tasks)
 * 3. Configures isolated workspace root
 * 4. Installs mock agent fixtures
 *
 * Run:
 *   node --test test/scheduler/scheduler.test.js
 *   # or with isolation:
 *   node cleanupTestState.js && node --test test/scheduler/scheduler.test.js
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import {
  setupTestEnv,
  teardownTestEnv,
  resetTestState,
  registerDb,
  createTestTask,
  seedBacklogTask,
  TASK_STATUSES
} from './setupTestEnv.js'

// ---------------------------------------------------------------------------
// Shared module references (loaded once, avoid re-import to prevent singleton reset)
// ---------------------------------------------------------------------------

let env = null
let db = null
let EnhancedScheduler = null

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

before(async () => {
  env = await setupTestEnv({ cleanWorkspace: true, seedTasks: false })
  // Load db and scheduler once — re-importing db resets the singleton
  const dbModule = await import('../../src/db.js')
  db = dbModule.default
  registerDb(db) // register so resetTestState() can reset without re-import
  const schedulerModule = await import('../../src/scheduler/enhancedScheduler.js')
  EnhancedScheduler = schedulerModule.EnhancedScheduler
})

after(async () => {
  await teardownTestEnv()
})

// ---------------------------------------------------------------------------
// Helper: fresh scheduler per test (to avoid singleton state leaking)
// ---------------------------------------------------------------------------

function freshScheduler(pollInterval = 999999, maxConcurrentAgents = 3) {
  return new EnhancedScheduler({ pollInterval, maxConcurrentAgents })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Scheduler: Task Pickup Verification', () => {

  it('setup: test environment is accessible', () => {
    assert.ok(env, 'Test environment should be set up')
    assert.ok(env.testDataFile, 'Test data file path should be set')
    assert.ok(env.testWorkspaceRoot, 'Test workspace root should be set')
    assert.ok(db, 'db singleton should be loaded')
    assert.ok(EnhancedScheduler, 'EnhancedScheduler should be loaded')
  })

  it('db: starts empty after clean setup', () => {
    const board = db.getBoard()
    const totalTasks = Object.values(board).reduce((sum, t) => sum + t.length, 0)
    assert.strictEqual(totalTasks, 0, 'Board should be empty after clean setup')
  })

  it('findClaimableTasks: returns Backlog task as analysisTask', async () => {
    await resetTestState() // clears tasks in db singleton without re-importing
    await seedBacklogTask(db)
    const scheduler = freshScheduler()
    const result = scheduler.findClaimableTasks()

    assert.ok(Array.isArray(result.analysisTasks))
    assert.ok(Array.isArray(result.executionTasks))
    assert.ok(Array.isArray(result.verificationTasks))
    assert.strictEqual(result.analysisTasks.length, 1, 'Should find 1 analysis task from Backlog')
    assert.strictEqual(result.executionTasks.length, 0, 'Should have no execution tasks')
    assert.strictEqual(result.verificationTasks.length, 0, 'Should have no verification tasks')
  })

  it('findClaimableTasks: ReadyForTest task becomes verificationTask', async () => {
    await resetTestState()
    await createTestTask({
      db,
      title: 'Completed implementation',
      description: 'Implementation done, needs QA',
      status: TASK_STATUSES.READY_FOR_TEST
    })

    const scheduler = freshScheduler()
    const result = scheduler.findClaimableTasks()

    assert.strictEqual(result.verificationTasks.length, 1, 'Should find 1 verification task')
    assert.strictEqual(result.analysisTasks.length, 0, 'Should have no analysis tasks')
    assert.strictEqual(result.executionTasks.length, 0, 'Should have no execution tasks')
  })

  it('captureTaskArtifacts: absolute handoff artifact should not spawn fake root index.html requirements', async () => {
    await resetTestState()

    const operationFolder = fs.mkdtempSync(path.join(env.testWorkspaceRoot, 'artifact-op-'))
    const workspacePath = fs.mkdtempSync(path.join(env.testWorkspaceRoot, 'artifact-ws-'))
    const deckDir = path.join(operationFolder, 'deck-01')
    const deckFile = path.join(deckDir, 'index.html')

    fs.mkdirSync(deckDir, { recursive: true })
    fs.writeFileSync(deckFile, '<html><body>deck</body></html>')

    const task = await createTestTask({
      db,
      title: 'Deck artifact capture',
      description: '验证 artifact 捕获不会把绝对路径里的文件名拆成根目录必需工件。',
      status: TASK_STATUSES.IN_DEV
    })

    task.operationFolder = operationFolder
    task.handoffArtifacts = [deckFile]
    task.acceptanceCriteria = [`deck 路径：${deckFile}`]
    task.verificationPlan = [
      `ls ${deckDir}/`,
      `grep -c '<body>' ${deckFile}`
    ]
    task.outputLines = [{
      id: 'artifact-output',
      content: `产物路径：${deckFile}`,
      timestamp: new Date().toISOString()
    }]
    db.save()

    const scheduler = freshScheduler()
    const result = scheduler.captureTaskArtifacts(task.id, workspacePath)
    const requiredPaths = result.requiredArtifacts.map(item => item.absolutePath).sort()

    assert.deepStrictEqual(requiredPaths, [deckFile], 'Only the real deck artifact should remain required')
    assert.strictEqual(result.missingRequired.length, 0, 'Real artifact exists, so nothing should be missing')
    assert.ok(!requiredPaths.includes(path.join(operationFolder, 'index.html')), 'Should not require operation-folder root index.html')
    assert.ok(!requiredPaths.includes(path.join(workspacePath, 'index.html')), 'Should not require workspace-root index.html')
  })

  it('findClaimableTasks: InDev task becomes executionTask', async () => {
    await resetTestState()
    await createTestTask({
      db,
      title: 'In-progress work',
      description: 'Started but not done',
      status: TASK_STATUSES.IN_DEV
    })

    const scheduler = freshScheduler()
    const result = scheduler.findClaimableTasks()

    assert.strictEqual(result.executionTasks.length, 1, 'Should find 1 execution task')
    assert.strictEqual(result.analysisTasks.length, 0, 'Should have no analysis tasks')
  })

  it('findClaimableTasks: InFix task becomes executionTask', async () => {
    await resetTestState()
    await createTestTask({
      db,
      title: 'Bug fix in progress',
      description: 'Fixing reported bug',
      status: TASK_STATUSES.IN_FIX
    })

    const scheduler = freshScheduler()
    const result = scheduler.findClaimableTasks()

    assert.strictEqual(result.executionTasks.length, 1, 'InFix task should be in execution queue')
    assert.strictEqual(result.executionTasks[0].status, 'InFix', 'Status should be preserved')
  })

  it('findClaimableTasks: skipped if assignedAgentId is set', async () => {
    await resetTestState()
    const agent = db.createAgent({ name: `Test Dev ${Date.now()}-${Math.random()}`, role: 'developer' })
    const task = await createTestTask({
      db,
      title: 'Already claimed',
      description: 'Assigned to an agent',
      status: TASK_STATUSES.IN_DEV
    })
    db.claimTask(task.id, agent.id)
    db.save()

    const scheduler = freshScheduler()
    const result = scheduler.findClaimableTasks()

    assert.strictEqual(result.executionTasks.length, 0, 'Claimed task should not be in queue')
  })

  it('findClaimableTasks: skipped if task has subTasks (parent task)', async () => {
    await resetTestState()
    const parent = await createTestTask({
      db,
      title: 'Parent with subtasks',
      description: 'Has subtasks, should not be directly scheduled',
      status: TASK_STATUSES.IN_DEV
    })
    db.createSubTask(parent.id, 'Subtask 1', 'Do part 1')

    const scheduler = freshScheduler()
    const result = scheduler.findClaimableTasks()

    assert.ok(
      !result.executionTasks.some(task => task.id === parent.id),
      'Parent with subtasks should not be directly scheduled'
    )
    assert.ok(
      result.executionTasks.some(task => task.parentTaskId === parent.id),
      'Runnable subtasks should still enter the execution queue'
    )
  })

  it('findClaimableTasks: InFix task skipped if loopCount >= 3', async () => {
    await resetTestState()
    const task = await createTestTask({
      db,
      title: 'Stuck in fix loop',
      status: TASK_STATUSES.IN_FIX
    })
    task.loopCount = 3
    db.save()

    const scheduler = freshScheduler()
    const result = scheduler.findClaimableTasks()

    assert.strictEqual(result.executionTasks.length, 0, 'Task at max loop count should be skipped')
  })

  it('handleUserMessage: Done task creates a follow-up task and keeps source task completed', async () => {
    await resetTestState()

    const task = await createTestTask({
      db,
      title: 'Completed travel guide',
      description: 'Initial delivery is complete',
      status: TASK_STATUSES.DONE
    })

    const scheduler = freshScheduler()
    let scheduleCalls = 0
    scheduler.running = true
    scheduler.scheduleNext = () => {
      scheduleCalls += 1
    }

    const result = await scheduler.handleUserMessage(task.id, '补一个汇总导航页')
    const sourceTask = db.getTaskById(task.id)
    const followUpTask = db.getTaskById(result.followUpTaskId)
    const messages = db.getTaskMessages(task.id)

    assert.strictEqual(result.delivery, 'followup_created', 'Completed task should create a dedicated follow-up task')
    assert.strictEqual(sourceTask.status, TASK_STATUSES.DONE, 'Source task should remain completed')
    assert.ok(followUpTask, 'Follow-up task should be created')
    assert.strictEqual(followUpTask.status, TASK_STATUSES.BACKLOG, 'Follow-up task should enter Backlog')
    assert.strictEqual(followUpTask.linkedTaskId, task.id, 'Follow-up task should link back to the source task')
    assert.ok(
      followUpTask.description.includes('【原始任务要求】'),
      'Follow-up task should carry the original task context'
    )
    assert.strictEqual(scheduleCalls, 1, 'Scheduler should be asked to pick the follow-up task immediately')
    assert.ok(
      messages.some(message => message.role === 'system' && message.content.includes('已创建新任务')),
      'System should confirm that a new follow-up task was created'
    )
  })

  it('handleUserMessage: Done subtask creates a standalone follow-up task without reopening parent chain', async () => {
    await resetTestState()

    const parent = await createTestTask({
      db,
      title: 'Parent itinerary task',
      description: 'Collects all travel outputs',
      status: TASK_STATUSES.DONE
    })
    const child = db.createSubTask(parent.id, 'Deck summary page', 'Generate the summary page')
    db.updateTaskStatus(child.id, TASK_STATUSES.DONE)
    db.updateTaskStatus(parent.id, TASK_STATUSES.DONE)

    const scheduler = freshScheduler()
    let scheduleCalls = 0
    scheduler.running = true
    scheduler.scheduleNext = () => {
      scheduleCalls += 1
    }

    const result = await scheduler.handleUserMessage(child.id, '再加一个入口导航')
    const updatedChild = db.getTaskById(child.id)
    const updatedParent = db.getTaskById(parent.id)
    const followUpTask = db.getTaskById(result.followUpTaskId)

    assert.strictEqual(result.delivery, 'followup_created', 'Completed subtask follow-up should create a new task')
    assert.strictEqual(updatedChild.status, TASK_STATUSES.DONE, 'Source subtask should stay completed')
    assert.strictEqual(updatedParent.status, TASK_STATUSES.DONE, 'Completed parent chain should remain unchanged')
    assert.ok(followUpTask, 'Standalone follow-up task should be created')
    assert.strictEqual(followUpTask.parentTaskId, null, 'Follow-up task should not inherit the old subtask hierarchy')
    assert.strictEqual(followUpTask.linkedTaskId, child.id, 'Follow-up task should point to the original subtask')
    assert.ok(
      followUpTask.description.includes('【父任务背景】'),
      'Follow-up task should carry parent task context when sourced from a subtask'
    )
    assert.strictEqual(scheduleCalls, 1, 'Scheduler should be notified after creating the follow-up task')
  })

  it('findBestAgentForTask: execution scoring prefers executor over architect for implementation work mentioning 方案', async () => {
    await resetTestState()

    const scheduler = freshScheduler()
    const task = await createTestTask({
      db,
      title: '汇总导航页实现',
      description: '为现有 deck 实现一个汇总导航页，我希望保留 10 套方案的入口展示。',
      status: TASK_STATUSES.IN_DEV
    })

    const originalGetAgents = db.getAgents.bind(db)
    const architectAgent = {
      id: 'agent-architect',
      name: 'architect',
      role: 'architect',
      status: 'idle',
      currentTaskId: null,
      disallowedTools: ['Write', 'Edit'],
      instructions: 'You are READ-ONLY and not responsible for implementing changes.'
    }
    const executorAgent = {
      id: 'agent-executor',
      name: 'executor',
      role: 'executor',
      status: 'idle',
      currentTaskId: null,
      instructions: 'Implement code changes end-to-end.'
    }

    db.getAgents = () => [architectAgent, executorAgent]

    try {
      const bestAgent = scheduler.findBestAgentForTask(task, 'execution')
      const architectScore = scheduler.scoreExecutionAgentForTask(task, architectAgent)
      const executorScore = scheduler.scoreExecutionAgentForTask(task, executorAgent)

      assert.strictEqual(bestAgent.id, executorAgent.id, 'Executor should be selected for implementation-oriented follow-up work')
      assert.ok(executorScore.score > architectScore.score, 'Executor should score higher than architect')
    } finally {
      db.getAgents = originalGetAgents
    }
  })

  it('priority: InFix > ReadyForTest > ReadyForDeploy > InDev > Backlog', async () => {
    await resetTestState()

    // Create actual db tasks (have createdAt for age calculation)
    const t1 = await createTestTask({ db, title: 'T1 Backlog',         status: TASK_STATUSES.BACKLOG })
    const t2 = await createTestTask({ db, title: 'T2 InDev',           status: TASK_STATUSES.IN_DEV })
    const t3 = await createTestTask({ db, title: 'T3 ReadyForTest',     status: TASK_STATUSES.READY_FOR_TEST })
    const t4 = await createTestTask({ db, title: 'T4 InFix',            status: TASK_STATUSES.IN_FIX })
    const t5 = await createTestTask({ db, title: 'T5 ReadyForDeploy',   status: TASK_STATUSES.READY_FOR_DEPLOY })

    const scheduler = freshScheduler()

    // Use actual db task objects (they have createdAt set by db.createTask)
    const getPriority = (task) => scheduler.getTaskPriority(task)
    assert.ok(getPriority(t4) > getPriority(t3), 'InFix > ReadyForTest')
    assert.ok(getPriority(t3) > getPriority(t5), 'ReadyForTest > ReadyForDeploy')
    assert.ok(getPriority(t5) > getPriority(t2), 'ReadyForDeploy > InDev')
    assert.ok(getPriority(t2) > getPriority(t1), 'InDev > Backlog')
  })

  it('canAcceptTask: respects maxConcurrentAgents limit', async () => {
    const scheduler = freshScheduler(999999, 2)
    scheduler.maxConcurrentAgents = 2

    assert.strictEqual(scheduler.canAcceptTask(), true, 'Should accept at start')
    assert.strictEqual(scheduler.getActiveCount(), 0, 'Should have 0 active tasks')

    // Simulate full capacity by populating activeTasks
    scheduler.activeTasks.set('fake-task-1', { id: 'fake-task-1' })
    scheduler.activeTasks.set('fake-task-2', { id: 'fake-task-2' })

    assert.strictEqual(scheduler.canAcceptTask(), false, 'Should reject at max capacity')
    assert.strictEqual(scheduler.getActiveCount(), 2, 'Should show 2 active tasks')
  })

  it('cleanupOrphanedTasks: clears assignedAgentId for stale tasks', async () => {
    await resetTestState()
    const agent = db.createAgent({ name: `Orphan Agent ${Date.now()}-${Math.random()}`, role: 'developer' })
    const task = await createTestTask({
      db,
      title: 'Orphan task',
      status: TASK_STATUSES.IN_DEV
    })
    // Simulate task assigned to agent but not tracked by scheduler
    db.claimTask(task.id, agent.id)
    db.save()

    const scheduler = freshScheduler()
    // Scheduler has no active tasks, but task is assigned in db
    scheduler.cleanupOrphanedTasks()

    const updatedTask = db.getTaskById(task.id)
    assert.strictEqual(updatedTask.assignedAgentId, null, 'Orphan task should be released')
  })

  it('test isolation: residual state from one test does not leak to next', async () => {
    await resetTestState()
    const board = db.getBoard()
    const totalTasks = Object.values(board).reduce((sum, t) => sum + t.length, 0)
    assert.strictEqual(totalTasks, 0, 'Board should be clean before each test')
  })
})

// ---------------------------------------------------------------------------
// Run instructions (printed at end)
// ---------------------------------------------------------------------------

console.log(`
========================================
  Scheduler Test Environment — Ready
========================================

Files created:
  fixtures/scheduler.base.json   — Clean base data template
  fixtures/agents/*.md           — Mock agent definitions
  setupTestEnv.js               — Test environment setup module
  cleanupTestState.js            — Standalone cleanup / restore script

Usage in test files:
  import { setupTestEnv, teardownTestEnv, createTestTask } from './setupTestEnv.js'

  before(async () => { await setupTestEnv() })
  after(async () => { await teardownTestEnv() })

Standalone commands:
  node cleanupTestState.js         # Full reset + backup
  node cleanupTestState.js --check  # Inspect current state
  node cleanupTestState.js --restore # Restore from backup
`)
