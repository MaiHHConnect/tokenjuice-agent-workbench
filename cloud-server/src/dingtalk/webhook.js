/**
 * 钉钉 Webhook 推送服务
 *
 * 使用钉钉群机器人的 Webhook 协议进行消息推送
 */

import crypto from 'crypto'
import https from 'https'
import { webhookConfig, notifyRules } from './config.js'

const { webhookUrl, secret } = webhookConfig

/**
 * 生成加签签名
 */
function generateSign(timestamp) {
  if (!secret) return ''

  const stringToSign = `${timestamp}\n${secret}`
  const hmac = crypto.createHmac('sha256', secret)
  hmac.update(stringToSign)
  return encodeURIComponent(hmac.digest('base64'))
}

/**
 * 发送 POST 请求到钉钉
 */
function post(url, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data)

    const urlObj = new URL(url)
    const options = {
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }

    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try {
          resolve(JSON.parse(data))
        } catch {
          resolve(data)
        }
      })
    })

    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

/**
 * 构建 Markdown 消息
 */
function buildMarkdown(title, text) {
  return {
    msgtype: 'markdown',
    markdown: {
      title,
      text
    }
  }
}

/**
 * 构建文本消息
 */
function buildText(content) {
  return {
    msgtype: 'text',
    text: { content }
  }
}

/**
 * 发送消息到钉钉
 */
export async function sendMessage(message) {
  if (!webhookUrl || !webhookUrl.startsWith('https://')) {
    console.log('[DingTalk] Webhook not configured, skipping')
    return null
  }

  try {
    const timestamp = Date.now()
    let url = webhookUrl

    // 如果配置了加签密钥，添加签名参数
    if (secret) {
      const sign = generateSign(timestamp)
      url += `&timestamp=${timestamp}&sign=${sign}`
    }

    const result = await post(url, message)

    if (result.errcode === 0) {
      console.log('[DingTalk] Message sent successfully')
      return true
    } else {
      console.error('[DingTalk] Send failed:', result.errmsg)
      return false
    }
  } catch (error) {
    console.error('[DingTalk] Send error:', error.message)
    return false
  }
}

/**
 * 发送任务创建通知
 */
export async function notifyTaskCreated(task) {
  if (!notifyRules.taskCreated) return

  const message = buildMarkdown(
    '📋 新任务创建',
    `### 新任务创建\n\n**${task.title}**\n\n> ${task.description || '无描述'}\n\n状态：${task.status}\n技能要求：${task.skills?.join(', ') || '无'}`
  )

  return sendMessage(message)
}

/**
 * 发送任务状态变更通知
 */
export async function notifyTaskStatusChanged(task, fromStatus, toStatus, operator) {
  if (!notifyRules.taskStatusChanged) return

  const statusEmoji = {
    'Backlog': '📥',
    'InDev': '🔨',
    'ReadyForTest': '🧪',
    'InFix': '🔧',
    'ReadyForDeploy': '🚀',
    'Done': '✅',
    'Blocked': '🚫'
  }

  const emoji = statusEmoji[toStatus] || '📌'
  const message = buildMarkdown(
    `${emoji} 任务状态变更`,
    `### ${task.title}\n\n状态变更：${fromStatus} → **${toStatus}**\n\n${operator ? `操作人：${operator}` : ''}\n${task.bugReport ? `\n> Bug报告：${task.bugReport}` : ''}`
  )

  return sendMessage(message)
}

/**
 * 发送任务被认领通知
 */
export async function notifyTaskClaimed(task, agent) {
  if (!notifyRules.taskClaimed) return

  const message = buildMarkdown(
    '🎯 任务被认领',
    `### ${task.title}\n\n已被 **${agent.name}** (${agent.role}) 认领\n\n当前状态：${task.status}`
  )

  return sendMessage(message)
}

/**
 * 发送 Bug 报告通知
 */
export async function notifyBugReported(task, bugReport, loopCount) {
  if (!notifyRules.bugReported) return

  const warning = loopCount >= 3 ? '\n\n⚠️ **警告：Bug 循环次数过多，将被阻塞！**' : ''

  const message = buildMarkdown(
    '🐛 Bug 报告',
    `### ${task.title}\n\n> ${bugReport}\n\n循环次数：${loopCount}/3${warning}`
  )

  return sendMessage(message)
}

/**
 * 发送 Agent 注册通知
 */
export async function notifyAgentRegistered(agent) {
  if (!notifyRules.agentEvents) return

  const roleEmoji = {
    'developer': '👨‍💻',
    'tester': '🧪',
    'deployer': '🚀',
    'pm': '📋'
  }

  const emoji = roleEmoji[agent.role] || '🤖'
  const message = buildMarkdown(
    `${emoji} 新 Agent 注册`,
    `### ${agent.name}\n\n角色：${agent.role}\n能力：${agent.capabilities?.join(', ') || '无'}\n\n已上线！`
  )

  return sendMessage(message)
}

/**
 * 发送看板统计
 */
export async function notifyBoardStats(stats) {
  const message = buildMarkdown(
    '📊 看板统计',
    `### 当前状态\n\n` +
    `| 状态 | 数量 |\n|------|------|\n` +
    Object.entries(stats.byStatus)
      .map(([status, count]) => `| ${status} | ${count} |`)
      .join('\n') +
    `\n\n在线 Agent：${stats.onlineAgents}/${stats.totalAgents}\n总任务数：${stats.totalTasks}`
  )

  return sendMessage(message)
}
