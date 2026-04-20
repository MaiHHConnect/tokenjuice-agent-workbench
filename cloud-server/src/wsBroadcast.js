/**
 * WebSocket 广播模块
 *
 * 将 wsClients 集合和 broadcast 函数独立出来，
 * 避免 index.js 和 db.js 之间的循环依赖。
 */

import { WebSocketServer } from 'ws'

// 存储活跃的 WebSocket 连接（供外部访问）
export const wsClients = new Set()

// WebSocket 广播函数
export function broadcast(data) {
  const message = JSON.stringify(data)
  wsClients.forEach(client => {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(message)
    }
  })
}

// 创建并配置 WebSocket 服务器（供 index.js 调用）
export function createWebSocketServer(server) {
  const wss = new WebSocketServer({ noServer: true })

  // 处理 WebSocket 升级请求
  server.on('upgrade', (request, socket, head) => {
    if (request.url === '/ws') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request)
      })
    } else {
      socket.destroy()
    }
  })

  // WebSocket 连接处理
  wss.on('connection', (ws) => {
    wsClients.add(ws)
    console.log('[WS] Client connected, total:', wsClients.size)

    ws.on('close', () => {
      wsClients.delete(ws)
      console.log('[WS] Client disconnected, total:', wsClients.size)
    })

    ws.on('error', (err) => {
      console.error('[WS] Error:', err.message)
      wsClients.delete(ws)
    })
  })

  return wss
}
