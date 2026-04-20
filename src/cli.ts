#!/usr/bin/env node

/**
 * 调度器 CLI 工具
 *
 * 用法:
 *   npm run cli -- register <name> <role>
 *   npm run cli -- board
 *   npm run cli -- tasks
 *   npm run cli -- create <title> [skills...]
 *   npm run cli -- claim <taskId> <agentId>
 *   npm run cli -- status <taskId> <newStatus>
 *   npm run cli -- stats
 */

import {
  healthCheck,
  getBoard,
  getTasks,
  getStats,
  createTask,
  claimTask,
  updateTaskStatus,
  reportBug,
  appendLog,
  registerAgent,
  getAgents,
  Agent
} from './client'

// 颜色输出
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  red: '\x1b[31m',
  cyan: '\x1b[36m'
}

function color(c: string, text: string) {
  return `${colors[c]}${text}${colors.reset}`
}

async function main() {
  const args = process.argv.slice(2)
  const command = args[0]

  // 健康检查
  const healthy = await healthCheck()
  if (!healthy) {
    console.error(color('red', '错误: 无法连接到调度服务器 (http://localhost:6666)'))
    console.error('请确保服务器正在运行: cd cloud-server && npm start')
    process.exit(1)
  }

  switch (command) {
    case 'board': {
      const board = await getBoard()
      console.log(color('bright', '\n=== 看板视图 ===\n'))

      const columns = [
        { key: 'Backlog', label: '待处理', icon: '📋' },
        { key: 'InDev', label: '开发中', icon: '🔨' },
        { key: 'ReadyForTest', label: '待测试', icon: '🧪' },
        { key: 'InFix', label: '待修复', icon: '🐛' },
        { key: 'ReadyForDeploy', label: '待部署', icon: '🚀' },
        { key: 'Done', label: '已完成', icon: '✅' },
        { key: 'Blocked', label: '被阻塞', icon: '🚫' }
      ] as const

      for (const col of columns) {
        const tasks = board[col.key]
        console.log(`${col.icon} ${color('bright', col.label)} (${tasks.length})`)
        if (tasks.length === 0) {
          console.log(`   ${color('dim', '无任务')}`)
        } else {
          for (const task of tasks) {
            const assigned = task.assignedAgentId ? color('green', '✓') : color('yellow', '○')
            const loopInfo = task.loopCount > 0 ? color('red', ` [循环${task.loopCount}]`) : ''
            console.log(`   ${assigned} ${task.title}${loopInfo}`)
            if (task.bugReport) {
              console.log(`      ${color('red', 'Bug:')} ${task.bugReport.substring(0, 50)}...`)
            }
          }
        }
        console.log()
      }
      break
    }

    case 'tasks': {
      const tasks = await getTasks()
      console.log(color('bright', `\n=== 所有任务 (${tasks.length}) ===\n`))

      for (const task of tasks) {
        const statusColors: Record<string, string> = {
          Backlog: 'yellow',
          InDev: 'blue',
          ReadyForTest: 'cyan',
          InFix: 'red',
          ReadyForDeploy: 'green',
          Done: 'green',
          Blocked: 'red'
        }
        console.log(`${color(statusColors[task.status] || 'reset', `[${task.status}]`)} ${task.title}`)
        console.log(`   ID: ${task.id}`)
        if (task.assignedAgentId) {
          console.log(`   负责人: ${task.assignedAgentId}`)
        }
        if (task.skills.length > 0) {
          console.log(`   技能: ${task.skills.join(', ')}`)
        }
        console.log()
      }
      break
    }

    case 'create': {
      const title = args.slice(1).find(a => !a.startsWith('--'))
      const skillsArg = args.find(a => a.startsWith('--skills='))

      if (!title) {
        console.error('用法: cli.js create <标题> [--skills=frontend,backend]')
        process.exit(1)
      }

      const skills = skillsArg
        ? skillsArg.replace('--skills=', '').split(',')
        : []

      const task = await createTask(title, undefined, skills)
      console.log(color('green', `✓ 任务已创建`))
      console.log(`   ID: ${task.id}`)
      console.log(`   标题: ${task.title}`)
      console.log(`   状态: ${task.status}`)
      if (task.skills.length > 0) {
        console.log(`   技能: ${task.skills.join(', ')}`)
      }
      break
    }

    case 'claim': {
      const taskId = args[1]
      const agentId = args[2]

      if (!taskId || !agentId) {
        console.error('用法: cli.js claim <taskId> <agentId>')
        process.exit(1)
      }

      const task = await claimTask(taskId, agentId)
      console.log(color('green', `✓ 任务已认领`))
      console.log(`   ID: ${task.id}`)
      console.log(`   状态: ${task.status}`)
      break
    }

    case 'status': {
      const taskId = args[1]
      const newStatus = args[2]

      if (!taskId || !newStatus) {
        console.error('用法: cli.js status <taskId> <newStatus>')
        console.error('状态可选: Backlog, InDev, ReadyForTest, InFix, ReadyForDeploy, Done, Blocked')
        process.exit(1)
      }

      const task = await updateTaskStatus(taskId, newStatus as any)
      console.log(color('green', `✓ 状态已更新`))
      console.log(`   ID: ${task.id}`)
      console.log(`   新状态: ${task.status}`)
      break
    }

    case 'bug': {
      const taskId = args[1]
      const bugReport = args.slice(2).join(' ')

      if (!taskId || !bugReport) {
        console.error('用法: cli.js bug <taskId> <bug描述>')
        process.exit(1)
      }

      const result = await reportBug(taskId, bugReport)
      console.log(color('yellow', `⚠ Bug已报告`))
      console.log(`   任务ID: ${result.task.id}`)
      console.log(`   新状态: ${result.task.status}`)
      console.log(`   循环次数: ${result.loopCount}`)
      if (result.blocked) {
        console.log(color('red', `   ⚠ 任务已被阻塞 (超过3次循环)`))
      }
      break
    }

    case 'agents': {
      const agents = await getAgents()
      console.log(color('bright', `\n=== Agent列表 (${agents.length}) ===\n`))

      for (const agent of agents) {
        const statusColor = agent.status === 'offline' ? 'red' : 'green'
        console.log(`${color('bright', agent.name)} (${agent.role})`)
        console.log(`   ID: ${agent.id}`)
        console.log(`   状态: ${color(statusColor, agent.status)}`)
        if (agent.capabilities.length > 0) {
          console.log(`   能力: ${agent.capabilities.join(', ')}`)
        }
        console.log()
      }
      break
    }

    case 'register': {
      const name = args[1]
      const role = args[2] as any
      const skillsArg = args.find(a => a.startsWith('--skills='))
      const skills = skillsArg ? skillsArg.replace('--skills=', '').split(',') : []

      if (!name || !role) {
        console.error('用法: cli.js register <name> <role> [--skills=frontend,backend]')
        console.error('角色可选: pm, developer, tester, deployer')
        process.exit(1)
      }

      const agent = await registerAgent(name, role, skills)
      console.log(color('green', `✓ Agent已注册`))
      console.log(`   ID: ${agent.id}`)
      console.log(`   名称: ${agent.name}`)
      console.log(`   角色: ${agent.role}`)
      if (agent.capabilities.length > 0) {
        console.log(`   能力: ${agent.capabilities.join(', ')}`)
      }
      break
    }

    case 'stats': {
      const stats = await getStats()
      console.log(color('bright', '\n=== 统计信息 ===\n'))
      console.log(`总任务数: ${stats.totalTasks}`)
      console.log(`总Agent数: ${stats.totalAgents}`)
      console.log(`在线Agent: ${stats.onlineAgents}`)
      console.log(color('dim', '\n按状态统计:'))
      for (const [status, count] of Object.entries(stats.byStatus)) {
        console.log(`  ${status}: ${count}`)
      }
      break
    }

    case 'help':
    default:
      console.log(color('bright', '\n=== 调度器 CLI ===\n'))
      console.log('命令:')
      console.log('  board                    查看看板')
      console.log('  tasks                    查看所有任务')
      console.log('  create <标题> [--skills=...]  创建任务')
      console.log('  claim <taskId> <agentId> 认领任务')
      console.log('  status <taskId> <状态>   更新任务状态')
      console.log('  bug <taskId> <描述>      报告Bug')
      console.log('  agents                   查看所有Agent')
      console.log('  register <名称> <角色> [--skills=...] 注册Agent')
      console.log('  stats                    查看统计')
      console.log()
      break
  }
}

main().catch(console.error)
