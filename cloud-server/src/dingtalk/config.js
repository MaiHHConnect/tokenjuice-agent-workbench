/**
 * 钉钉配置
 */

// Webhook 模式配置（简单推送）
export const webhookConfig = {
  // 是否启用 Webhook 推送
  enabled: true,
  // Webhook URL（从钉钉群机器人设置中获取）
  webhookUrl: process.env.DINGTALK_WEBHOOK_URL || '',
  // 加签密钥（如果启用了加签）
  secret: process.env.DINGTALK_SECRET || ''
}

// Stream 模式配置（双向通信）
export const streamConfig = {
  // 是否启用 Stream 模式
  enabled: true,
  // 钉钉企业的 AppKey
  appKey: process.env.DINGTALK_APP_KEY || '',
  // 钉钉企业的 AppSecret
  appSecret: process.env.DINGTALK_APP_SECRET || '',
  // Stream 模式类型：'RTC' | 'normal'
  // RTC 模式支持更多功能，推荐使用
  mode: 'RTC'
}

// 消息推送目标
export const pushTarget = {
  // 推送到群（使用群机器人）
  chatId: process.env.DINGTALK_CHAT_ID || '',
  // 推送到个人（使用微应用）
  userIds: (process.env.DINGTALK_USER_IDS || '').split(',').filter(Boolean)
}

// 通知规则：哪些事件需要推送
export const notifyRules = {
  // 任务创建
  taskCreated: true,
  // 任务状态变更
  taskStatusChanged: true,
  // 任务被认领
  taskClaimed: true,
  // Bug 报告
  bugReported: true,
  // Agent 注册/心跳
  agentEvents: true
}
