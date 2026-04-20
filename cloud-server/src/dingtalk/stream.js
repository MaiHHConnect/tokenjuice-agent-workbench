/**
 * 钉钉 Stream 客户端
 *
 * 使用钉钉 Stream 模式建立持久连接，支持：
 * - 接收钉钉消息并转换为 API 调用
 * - 通过 Long Connection 推送消息
 */

import https from 'https'
import http from 'http'
import { URL } from 'url'
import { streamConfig } from './config.js'

class DingTalkStreamClient {
  constructor() {
    this.appKey = streamConfig.appKey
    this.appSecret = streamConfig.appSecret
    this.enabled = streamConfig.enabled && streamConfig.appKey && streamConfig.appSecret
    this.mode = streamConfig.mode || 'normal'

    this.accessToken = null
    this.connection = null
    this.callbacks = new Map()
    this.running = false
    this.reconnectDelay = 5000
    this.maxReconnectDelay = 60000
  }

  /**
   * 获取 Access Token
   */
  async getAccessToken() {
    if (this.accessToken && this._tokenExpiry > Date.now()) {
      return this.accessToken
    }

    try {
      const url = `https://api.dingtalk.com/v1.0/oauth2/accessToken`
      const body = JSON.stringify({
        appKey: this.appKey,
        appSecret: this.appSecret
      })

      const response = await this._httpPost(url, body)
      if (response.accessToken) {
        this.accessToken = response.accessToken
        // token 有效期 2 小时，提前 1 小时刷新
        this._tokenExpiry = Date.now() + (2 * 60 * 60 * 1000) - (60 * 60 * 1000)
        console.log('[DingTalk Stream] Access token obtained')
        return this.accessToken
      }
      throw new Error(response.errmsg || 'Failed to get access token')
    } catch (error) {
      console.error('[DingTalk Stream] Failed to get access token:', error.message)
      throw error
    }
  }

  /**
   * 订阅事件
   */
  on(event, callback) {
    this.callbacks.set(event, callback)
  }

  /**
   * 发送 HTTP POST 请求
   */
  _httpPost(url, body) {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url)
      const options = {
        hostname: urlObj.hostname,
        port: 443,
        path: urlObj.pathname,
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
   * 建立 Stream 连接
   */
  async connect() {
    if (!this.enabled) {
      console.log('[DingTalk Stream] Stream mode not enabled or not configured')
      return
    }

    try {
      const token = await this.getAccessToken()

      // 根据模式选择不同的连接方式
      if (this.mode === 'RTC') {
        await this._connectRTC(token)
      } else {
        await this._connectNormal(token)
      }
    } catch (error) {
      console.error('[DingTalk Stream] Connection failed:', error.message)
      this._scheduleReconnect()
    }
  }

  /**
   * 普通 Stream 模式连接
   */
  async _connectNormal(token) {
    // 普通 Stream 模式使用 HTTP 长轮询
    this.running = true
    console.log('[DingTalk Stream] Starting normal stream mode (long polling)')

    this._pollLoop(token)
  }

  /**
   * RTC 模式连接（WebSocket 风格）
   */
  async _connectRTC(token) {
    try {
      // 获取 endpoint
      const endpointResponse = await this._httpPost(
        'https://api.dingtalk.com/v1.0/gateway/connections/open',
        JSON.stringify({
          subscriptions: [
            { type: 'EVENT', topic: '*' },
            { type: 'CALLBACK', topic: '/v1.0/im/bot/messages/get' }
          ]
        })
      )

      if (endpointResponse.endpoint) {
        this._connectWebSocket(endpointResponse.endpoint, token)
      } else {
        console.log('[DingTalk Stream] RTC mode not available, falling back to normal')
        await this._connectNormal(token)
      }
    } catch (error) {
      console.log('[DingTalk Stream] RTC connection failed, falling back to normal')
      await this._connectNormal(token)
    }
  }

  /**
   * WebSocket 连接 (RTC 模式)
   */
  _connectWebSocket(endpoint, token) {
    this.running = true
    console.log('[DingTalk Stream] RTC mode connected')

    // 注意：这里需要 ws 模块，实际实现时需要安装依赖
    // 为了保持简单，这里先实现 HTTP 长轮询版本
  }

  /**
   * 长轮询循环（普通模式）
   */
  async _pollLoop(token) {
    while (this.running) {
      try {
        await this._pollMessages(token)
      } catch (error) {
        console.error('[DingTalk Stream] Poll error:', error.message)
        if (this.running) {
          this._scheduleReconnect()
        }
      }

      if (this.running) {
        // 避免过于频繁的请求
        await this._sleep(3000)
      }
    }
  }

  /**
   * 拉取消息
   */
  async _pollMessages(token) {
    const url = 'https://api.dingtalk.com/v1.0/im/bot/messages/get'
    const body = JSON.stringify({})

    const response = await this._httpPost(url, body)

    // 处理错误码
    if (response.errcode && response.errcode !== 0) {
      if (response.errcode === 400001 || response.errcode === 400002) {
        // Token 过期，刷新并重试
        this.accessToken = null
        throw new Error('Token expired')
      }
      return
    }

    // 处理消息
    if (response.data && Array.isArray(response.data)) {
      for (const message of response.data) {
        this._handleMessage(message)
      }
    }
  }

  /**
   * 处理收到的消息
   */
  _handleMessage(message) {
    console.log('[DingTalk Stream] Received message:', JSON.stringify(message).substring(0, 200))

    try {
      const { conversationType, conversationId, senderNick, senderStaffId, chatbotCorpId, content } = message

      // 解析消息内容
      let text = ''
      if (typeof content === 'string') {
        text = content
      } else if (content && content.text) {
        text = content.text
      }

      // 触发消息回调
      const callback = this.callbacks.get('message')
      if (callback) {
        callback({
          type: conversationType === '2' ? 'group' : 'private',
          chatId: conversationId,
          userId: senderStaffId,
          userName: senderNick,
          text: text,
          raw: message
        })
      }
    } catch (error) {
      console.error('[DingTalk Stream] Error handling message:', error)
    }
  }

  /**
   * 发送回复消息
   */
  async sendMessage(chatId, text) {
    try {
      const token = await this.getAccessToken()
      const url = 'https://api.dingtalk.com/v1.0/im/robot/send'

      const body = JSON.stringify({
        robotCode: this.appKey,
        msg: {
          msgType: 'text',
          content: { text }
        },
        conversationType: '2', // 群聊
        conversationId: chatId
      })

      const response = await this._httpPost(url, body)
      if (response.errcode === 0) {
        console.log('[DingTalk Stream] Message sent successfully')
        return true
      } else {
        console.error('[DingTalk Stream] Send failed:', response.errmsg)
        return false
      }
    } catch (error) {
      console.error('[DingTalk Stream] Send error:', error.message)
      return false
    }
  }

  /**
   * 调度重连
   */
  _scheduleReconnect() {
    if (!this.running) return

    console.log(`[DingTalk Stream] Reconnecting in ${this.reconnectDelay / 1000}s...`)
    setTimeout(() => this.connect(), this.reconnectDelay)

    // 指数退避
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay)
  }

  /**
   * 休眠
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  /**
   * 启动客户端
   */
  async start() {
    if (!this.enabled) {
      console.log('[DingTalk Stream] Not enabled, skipping')
      return
    }

    console.log('[DingTalk Stream] Starting...')
    await this.connect()
  }

  /**
   * 停止客户端
   */
  stop() {
    console.log('[DingTalk Stream] Stopping...')
    this.running = false
    this.reconnectDelay = 5000 // 重置重连延迟
  }
}

// 导出单例
export const streamClient = new DingTalkStreamClient()

export default streamClient
