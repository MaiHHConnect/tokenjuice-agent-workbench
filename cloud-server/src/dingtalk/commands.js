/**
 * 钉钉消息命令处理器
 *
 * 将钉钉消息转换为看板操作
 */

import db from '../db.js'

// 看板状态
const STATUSES = ['Backlog', 'InDev', 'ReadyForTest', 'InFix', 'ReadyForDeploy', 'Done', 'Blocked']

/**
 * 解析命令
 */
function parseCommand(text) {
  const trimmed = text.trim()
  const parts = trimmed.split(/\s+/)
  const command = parts[0].toLowerCase()
  const args = parts.slice(1)

  return { command, args, raw: trimmed }
}

/**
 * 获取用户绑定的 Agent
 */
function getAgentByUserId(userId) {
  // 在实际实现中，应该维护 userId -> agentId 的映射
  // 这里暂时返回第一个开发者 Agent
  const agent = db.agents.find(a => a.role === 'developer')
  return agent
}

/**
 * 执行命令
 */
async function executeCommand(command, args, message, apiBase) {
  const { chatId, userId, userName } = message

  const sendReply = async (text) => {
    // 通过 HTTP 请求发送到 Stream 客户端的回复方法
    console.log(`[DingTalk Command] Reply to ${chatId}: ${text}`)
  }

  const formatTask = (task) => {
    const assignee = task.assignedAgentId
      ? db.getAgentById(task.assignedAgentId)?.name || '未知'
      : '未分配'
    return `📋 ${task.title}\n   状态: ${task.status} | 分配: ${assignee}\n   ID: ${task.id.substring(0, 8)}...`
  }

  const formatBoard = () => {
    const board = db.getBoard()
    const lines = ['📊 **看板状态**\n']
    for (const status of STATUSES) {
      const tasks = board[status] || []
      if (tasks.length > 0) {
        lines.push(`\n**${status}** (${tasks.length})`)
        for (const task of tasks.slice(0, 3)) {
          lines.push(`- ${task.title}`)
        }
        if (tasks.length > 3) {
          lines.push(`- ...还有 ${tasks.length - 3} 个`)
        }
      }
    }
    return lines.join('\n')
  }

  switch (command) {
    case 'help':
      return sendReply(`🤖 **可用命令：**

- **board** - 查看看板状态
- **tasks** - 查看所有任务
- **task <标题>** - 创建新任务
- **claim <任务ID>** - 认领任务
- **status <任务ID> <状态>** - 更新状态
- **bug <任务ID> <描述>** - 报告 Bug
- **stats** - 统计信息`)

    case 'board':
      return sendReply(formatBoard())

    case 'tasks': {
      const tasks = db.getTasks().slice(0, 10)
      if (tasks.length === 0) {
        return sendReply('暂无任务')
      }
      return sendReply(tasks.map(formatTask).join('\n\n'))
    }

    case 'task': {
      if (args.length === 0) {
        return sendReply('请提供任务标题：task <标题>')
      }
      const title = args.join(' ')
      const task = db.createTask({ title })
      return sendReply(`✅ 任务已创建：${title}\n\nID: ${task.id}`)
    }

    case 'claim': {
      if (args.length === 0) {
        return sendReply('请提供任务ID：claim <任务ID>')
      }
      const taskId = args[0]
      const agent = getAgentByUserId(userId)

      if (!agent) {
        return sendReply('❌ 未找到可用的 Agent')
      }

      const result = db.claimTask(taskId, agent.id)
      if (!result) {
        return sendReply('❌ 任务不存在或已被认领')
      }

      const { task } = result
      return sendReply(`✅ 任务已认领：${task.title}\n由 ${agent.name} 处理`)
    }

    case 'status': {
      if (args.length < 2) {
        return sendReply('请提供任务ID和新状态：status <任务ID> <状态>')
      }

      const taskId = args[0]
      const newStatus = args[1]

      if (!STATUSES.includes(newStatus)) {
        return sendReply(`❌ 无效状态。可用状态：${STATUSES.join(', ')}`)
      }

      const result = db.updateTaskStatus(taskId, newStatus)
      if (!result) {
        return sendReply('❌ 任务不存在')
      }

      const { task, fromStatus } = result
      return sendReply(`✅ 状态已更新：${task.title}\n${fromStatus} → ${newStatus}`)
    }

    case 'bug': {
      if (args.length < 2) {
        return sendReply('请提供任务ID和Bug描述：bug <任务ID> <描述>')
      }

      const taskId = args[0]
      const bugReport = args.slice(1).join(' ')
      const result = db.reportBug(taskId, bugReport)

      if (!result) {
        return sendReply('❌ 任务不存在')
      }

      const { task, blocked, loopCount } = result
      if (blocked) {
        return sendReply(`🐛 Bug 已报告：${bugReport}\n\n⚠️ **任务已被阻塞** (循环次数: ${loopCount}/3)`)
      } else {
        return sendReply(`🐛 Bug 已报告：${bugReport}\n\n循环次数: ${loopCount}/3`)
      }
    }

    case 'stats': {
      const stats = db.getStats()

      const lines = ['📊 **统计信息**\n']
      lines.push(`总任务数: ${stats.totalTasks}`)
      lines.push(`在线 Agent: ${stats.onlineAgents}/${stats.totalAgents}\n`)
      lines.push('**任务分布：**')
      for (const [status, count] of Object.entries(stats.byStatus)) {
        if (count > 0) {
          lines.push(`- ${status}: ${count}`)
        }
      }

      return sendReply(lines.join('\n'))
    }

    case 'agents': {
      const agents = db.getAgents()
      if (agents.length === 0) {
        return sendReply('暂无注册的 Agent')
      }

      const lines = ['🤖 **在线 Agent**\n']
      for (const agent of agents) {
        const statusEmoji = agent.status === 'offline' ? '🔴' : '🟢'
        const task = agent.currentTaskId
          ? db.getTaskById(agent.currentTaskId)
          : null
        lines.push(`${statusEmoji} ${agent.name} (${agent.role})`)
        lines.push(`   状态: ${agent.status}${task ? ` - ${task.title}` : ''}`)
      }

      return sendReply(lines.join('\n'))
    }

    default:
      return sendReply(`❌ 未知命令：${command}\n\n输入 **help** 查看可用命令`)
  }
}

/**
 * 处理收到的钉钉消息
 */
export async function handleMessage(message, apiBase) {
  const { text } = message

  if (!text || !text.trim().startsWith('/')) {
    // 非命令消息，忽略或自动回复
    return
  }

  const { command, args } = parseCommand(text)
  await executeCommand(command, args, message, apiBase)
}

export default { handleMessage }
