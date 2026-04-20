import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  createTestScheduler,
  registerDb,
  resetTestState,
  setupTestEnv,
  teardownTestEnv
} from './setupTestEnv.js'

let db = null

function installFakeAgents(dbInstance) {
  const plannerAgent = {
    id: 'test-agent-planner',
    name: 'Test Planner',
    role: 'planner',
    description: 'Planner smoke test agent',
    status: 'idle',
    currentTaskId: null,
    instructions: '用于三级拆解 smoke test 的固定 planner。'
  }

  const executorAgent = {
    id: 'test-agent-executor',
    name: 'Test Executor',
    role: 'executor',
    description: 'Executor smoke test agent',
    status: 'idle',
    currentTaskId: null,
    instructions: '用于三级拆解 smoke test 的固定 executor。'
  }

  dbInstance._claudeCodeAgents = [plannerAgent, executorAgent]
  return { plannerAgent, executorAgent }
}

function normalizeStringArray(values) {
  return Array.isArray(values)
    ? values.map(value => String(value || '').trim()).filter(Boolean)
    : []
}

function applySyntheticPlan(dbInstance, task, agent, plan) {
  const subTasks = Array.isArray(plan.subTasks) ? plan.subTasks : []
  const createdSubTasks = subTasks.map((subTask, index) => {
    return dbInstance.createSubTask(task.id, subTask.title, subTask.description || '', {
      sequenceIndex: index,
      dependencyRefs: Array.isArray(subTask.dependsOn) ? subTask.dependsOn : [],
      parallelGroup: subTask.parallelGroup || null,
      canRunInParallel: subTask.canRunInParallel !== false,
      acceptanceCriteria: normalizeStringArray(subTask.acceptanceCriteria),
      verificationPlan: normalizeStringArray(subTask.verificationPlan),
      handoffArtifacts: normalizeStringArray(subTask.handoffArtifacts),
      qaRubric: subTask.qaRubric || null,
      canExecuteDirectly: subTask.canExecuteDirectly !== false,
      shouldDecomposeFurther: subTask.shouldDecomposeFurther === true,
      decompositionReason: typeof subTask.decompositionReason === 'string' ? subTask.decompositionReason : '',
      riskSignals: normalizeStringArray(subTask.riskSignals)
    })
  })

  createdSubTasks.forEach((createdSubTask, index) => {
    const refs = Array.isArray(subTasks[index]?.dependsOn) ? subTasks[index].dependsOn : []
    createdSubTask.dependsOnSubTaskIds = refs
      .map(ref => {
        if (typeof ref !== 'number') return null
        const dependency = createdSubTasks[ref - 1]
        return dependency ? dependency.id : null
      })
      .filter(Boolean)
    createdSubTask.updatedAt = new Date().toISOString()
  })

  dbInstance.updateTaskStatus(task.id, 'InDev')
  dbInstance.addTaskLog(task.id, {
    agentId: agent.id,
    action: '任务分解',
    message: `Smoke test planner 分解为 ${createdSubTasks.length} 个子任务`
  })

  const taskRef = dbInstance.getTaskById(task.id)
  taskRef.decompositionNote = plan.summary || ''
  taskRef.decompositionReason = plan.summary || ''
  taskRef.shouldDecomposeFurther = false
  taskRef.canExecuteDirectly = createdSubTasks.length === 0
  taskRef.updatedAt = new Date().toISOString()
  dbInstance.save()

  return { success: true, subTaskCount: createdSubTasks.length }
}

describe('Smoke: adaptive third-level decomposition', () => {
  before(async () => {
    await setupTestEnv({ cleanWorkspace: true, seedTasks: false })
    const dbModule = await import('../../src/db.js')
    db = dbModule.default
    registerDb(db)
  })

  after(async () => {
    await teardownTestEnv()
  })

  it('splits a complex level-2 document task into level-3 grandchildren', async () => {
    await resetTestState()
    const { plannerAgent } = installFakeAgents(db)
    const scheduler = await createTestScheduler({ pollInterval: 999999, maxConcurrentAgents: 2 })

    const rootTask = db.createTask({
      title: 'Smoke：三级拆解文档流',
      description: '用最小文档流验证二级任务会按需继续拆到第三级。',
      status: 'Backlog',
      operationFolder: '/tmp/third-level-smoke-doc-target',
      maxDecompositionDepth: 3
    })

    const rootPlan = {
      summary: '第一层先拆成 SPEC 和综合交付，其中综合交付是写作+脚本+检查清单混合包，应继续拆解。',
      subTasks: [
        {
          title: '[L2-1] 产出 SPEC.md：定义目录结构、交付物清单和验收口径',
          description: '输出 SPEC.md，约束后续文档流。',
          canExecuteDirectly: true,
          shouldDecomposeFurther: false,
          acceptanceCriteria: ['SPEC.md 产出且可作为后续任务输入'],
          verificationPlan: ['检查 SPEC.md 存在'],
          handoffArtifacts: ['/tmp/third-level-smoke-doc-target/SPEC.md'],
          decompositionReason: '单一规格文档，可直接执行。',
          riskSignals: []
        },
        {
          title: '[L2-2] 综合交付：README + 验收脚本 + 交付检查清单',
          description: '基于 SPEC 产出 README、acceptance.sh、checklist.md。',
          dependsOn: [1],
          canExecuteDirectly: false,
          shouldDecomposeFurther: true,
          acceptanceCriteria: ['三个产物都需要真实落地'],
          verificationPlan: ['后续继续拆解后分别验证'],
          handoffArtifacts: [
            '/tmp/third-level-smoke-doc-target/README.md',
            '/tmp/third-level-smoke-doc-target/acceptance.sh',
            '/tmp/third-level-smoke-doc-target/checklist.md'
          ],
          decompositionReason: '同一任务内同时包含写作、脚本、人工检查三类产物，适合继续拆解。',
          riskSignals: ['多产物交付', '写作+实现混合', '强依赖 SPEC.md']
        }
      ]
    }

    const recursivePlan = {
      summary: '第二层综合交付继续拆成三个单一产物任务。',
      subTasks: [
        {
          title: '[L3-1] 产出 README.md — 交付包使用说明',
          description: '编写 README.md。',
          canExecuteDirectly: true,
          shouldDecomposeFurther: false,
          acceptanceCriteria: ['README.md 存在'],
          verificationPlan: ['检查 README.md 存在'],
          handoffArtifacts: ['/tmp/third-level-smoke-doc-target/README.md'],
          decompositionReason: '单一文档写作任务。',
          riskSignals: []
        },
        {
          title: '[L3-2] 产出 acceptance.sh — 自动化验收脚本',
          description: '编写 acceptance.sh。',
          canExecuteDirectly: true,
          shouldDecomposeFurther: false,
          acceptanceCriteria: ['acceptance.sh 存在'],
          verificationPlan: ['检查 acceptance.sh 存在'],
          handoffArtifacts: ['/tmp/third-level-smoke-doc-target/acceptance.sh'],
          decompositionReason: '单一脚本任务。',
          riskSignals: []
        },
        {
          title: '[L3-3] 产出 checklist.md — 人工复核检查清单',
          description: '编写 checklist.md。',
          canExecuteDirectly: true,
          shouldDecomposeFurther: false,
          acceptanceCriteria: ['checklist.md 存在'],
          verificationPlan: ['检查 checklist.md 存在'],
          handoffArtifacts: ['/tmp/third-level-smoke-doc-target/checklist.md'],
          decompositionReason: '单一文档任务。',
          riskSignals: []
        }
      ]
    }

    scheduler.analyzeAndDecompose = async (task, agent) => {
      if (task.id === rootTask.id) {
        return applySyntheticPlan(db, task, agent, rootPlan)
      }

      if (task.title === '[L2-2] 综合交付：README + 验收脚本 + 交付检查清单') {
        return applySyntheticPlan(db, task, agent, recursivePlan)
      }

      throw new Error(`Unexpected task analyzed in smoke test: ${task.title}`)
    }

    const initialQueues = scheduler.findClaimableTasks()
    assert.equal(initialQueues.analysisTasks.length, 1)
    assert.equal(initialQueues.analysisTasks[0].id, rootTask.id)

    await scheduler.claimAnalysisTask(rootTask, plannerAgent)

    const rootAfterAnalysis = db.getTaskById(rootTask.id)
    assert.equal(rootAfterAnalysis.status, 'InDev')
    assert.equal(rootAfterAnalysis.subTaskIds.length, 2)

    const level2Tasks = rootAfterAnalysis.subTaskIds.map(id => db.getTaskById(id))
    const directLevel2 = level2Tasks.find(task => task.title.includes('SPEC.md'))
    const recursiveLevel2 = level2Tasks.find(task => task.title.includes('综合交付'))

    assert.ok(directLevel2, 'should create direct level-2 task')
    assert.ok(recursiveLevel2, 'should create recursive level-2 task')
    assert.equal(directLevel2.depth, 2)
    assert.equal(directLevel2.shouldDecomposeFurther, false)
    assert.equal(recursiveLevel2.depth, 2)
    assert.equal(recursiveLevel2.shouldDecomposeFurther, true)
    assert.deepEqual(recursiveLevel2.dependsOnSubTaskIds, [directLevel2.id])

    const queuesBeforeDependencyDone = scheduler.findClaimableTasks()
    assert.equal(queuesBeforeDependencyDone.analysisTasks.length, 0)
    assert.equal(queuesBeforeDependencyDone.executionTasks.length, 1)
    assert.equal(queuesBeforeDependencyDone.executionTasks[0].id, directLevel2.id)

    db.updateTaskStatus(directLevel2.id, 'Done')

    const queuesAfterDependencyDone = scheduler.findClaimableTasks()
    assert.equal(queuesAfterDependencyDone.analysisTasks.length, 1)
    assert.equal(queuesAfterDependencyDone.analysisTasks[0].id, recursiveLevel2.id)
    assert.equal(queuesAfterDependencyDone.executionTasks.length, 0)

    await scheduler.claimAnalysisTask(recursiveLevel2, plannerAgent)

    const recursiveAfterAnalysis = db.getTaskById(recursiveLevel2.id)
    assert.equal(recursiveAfterAnalysis.status, 'InDev')
    assert.equal(recursiveAfterAnalysis.subTaskIds.length, 3)

    const grandchildren = recursiveAfterAnalysis.subTaskIds.map(id => db.getTaskById(id))
    assert.deepEqual(
      grandchildren.map(task => task.title),
      [
        '[L3-1] 产出 README.md — 交付包使用说明',
        '[L3-2] 产出 acceptance.sh — 自动化验收脚本',
        '[L3-3] 产出 checklist.md — 人工复核检查清单'
      ]
    )
    assert.ok(grandchildren.every(task => task.depth === 3), 'all grandchildren should be depth 3')
    assert.ok(grandchildren.every(task => task.shouldDecomposeFurther === false), 'last layer should not recurse again')

    const queuesAfterRecursiveAnalysis = scheduler.findClaimableTasks()
    assert.equal(queuesAfterRecursiveAnalysis.analysisTasks.length, 0)
    assert.equal(queuesAfterRecursiveAnalysis.executionTasks.length, 3)
    assert.deepEqual(
      queuesAfterRecursiveAnalysis.executionTasks.map(task => task.id).sort(),
      grandchildren.map(task => task.id).sort()
    )
  })
})
