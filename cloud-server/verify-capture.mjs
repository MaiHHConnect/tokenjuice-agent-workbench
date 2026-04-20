/**
 * 终端输出捕获验证测试 (含 WebSocket 广播验证)
 *
 * 验证目标：检查捕获机制是否成功接收输出内容，
 * 对比捕获内容与原始输出一致性，并验证 WebSocket 实时推送。
 * 完成标准：捕获的输出与原始输出完全匹配，无截断或遗漏。
 */

import http from 'http'
import { WebSocket } from 'ws'

const BASE_URL = 'http://localhost:8085'
const WS_URL = 'ws://localhost:8085/ws'

function api(path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL)
    const reqOptions = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...options.headers
      }
    }

    const req = http.request(reqOptions, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try {
          const json = JSON.parse(data)
          if (res.statusCode >= 400) {
            reject(new Error(`API Error ${res.statusCode}: ${JSON.stringify(json)}`))
          } else {
            resolve(json)
          }
        } catch (e) {
          reject(new Error(`Parse error: ${data}`))
        }
      })
    })

    req.on('error', reject)
    if (options.body) {
      const body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body)
      req.write(body)
    }
    req.end()
  })
}

async function test(name, fn) {
  try {
    await fn()
    console.log(`✅ ${name}`)
    return true
  } catch (e) {
    console.error(`❌ ${name}: ${e.message}`)
    return false
  }
}

// 已知输出内容，用于对比
const KNOWN_OUTPUT_LINES = [
  'Test line 1: Hello World',
  'Test line 2: 中文测试',
  'Test line 3: Special chars !@#$%',
  'Test line 4: Numbers 12345',
  'Test line 5: Empty line follows',
  '',
  'Test line 7: After empty line',
  'Test line 8: Unicode 你好 🎉',
  'Test line 9: 终端输出捕获验证',
  'Test line 10: End of test'
]

async function connectWS() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL)
    const timeout = setTimeout(() => {
      ws.close()
      reject(new Error('WebSocket connection timeout'))
    }, 5000)

    ws.on('open', () => {
      clearTimeout(timeout)
      resolve(ws)
    })
    ws.on('error', reject)
  })
}

async function runCaptureTest() {
  console.log('🧪 终端输出捕获验证测试\n')
  console.log('═'.repeat(60))

  let passed = 0
  let failed = 0

  // Step 1: 健康检查
  if (await test('1. 服务健康检查', async () => {
    const res = await api('/health')
    if (res.status !== 'ok') throw new Error('Service not healthy')
  })) passed++; else failed++

  // Step 2: 创建测试任务
  let testTaskId
  if (!await test('2. 创建测试任务', async () => {
    const res = await api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Output Capture Verification Test',
        description: 'Testing terminal output capture mechanism'
      })
    })
    if (!res.task?.id) throw new Error('No task ID returned')
    testTaskId = res.task.id
    console.log(`   Task ID: ${testTaskId}`)
  })) { failed++; }

  // Step 3: 连接 WebSocket 并准备接收广播
  let ws
  let wsReceived = []
  if (!await test('3. WebSocket 连接', async () => {
    ws = await connectWS()
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        wsReceived.push(msg)
      } catch (e) {
        // ignore parse errors
      }
    })
    // Give WS a moment to be ready
    await new Promise(r => setTimeout(r, 200))
  })) { failed++; }

  // Step 4: 写入测试数据（原始输出）
  console.log('\n4. 测试 appendTaskOutput API')
  for (const line of KNOWN_OUTPUT_LINES) {
    await api(`/api/tasks/${testTaskId}/output`, {
      method: 'POST',
      body: JSON.stringify({ line })
    })
  }
  console.log(`   写入 ${KNOWN_OUTPUT_LINES.length} 行测试数据`)
  passed++

  // Step 5: 等待 WebSocket 广播到达
  await new Promise(r => setTimeout(r, 500))

  // Step 6: 验证 WebSocket 广播
  let wsBroadcastCorrect = true
  if (!await test('6. WebSocket 广播验证', async () => {
    const outputBroadcasts = wsReceived.filter(m => m.type === 'task_output' && m.taskId === testTaskId)
    console.log(`   WebSocket 收到 ${outputBroadcasts.length} 条广播 (期望 ${KNOWN_OUTPUT_LINES.length} 条)`)
    if (outputBroadcasts.length === 0) {
      throw new Error('WebSocket 未收到任何广播！捕获机制未触发实时推送。')
    }
    // 验证广播内容
    for (const bc of outputBroadcasts) {
      if (!bc.line || !bc.taskId || !bc.outputLine) {
        wsBroadcastCorrect = false
        break
      }
    }
    if (!wsBroadcastCorrect) {
      throw new Error('广播消息格式不正确，缺少必要字段')
    }
    // 验证非空行全部被广播
    const nonEmptyLines = KNOWN_OUTPUT_LINES.filter(l => l.trim() !== '')
    if (outputBroadcasts.length < nonEmptyLines.length) {
      throw new Error(`广播数量不足: 收到${outputBroadcasts.length}条, 期望${nonEmptyLines.length}条`)
    }
  })) { failed++; }

  // Step 7: 获取捕获的输出（先清空再重新写入，保证干净状态）
  let capturedLines = []
  console.log('\n7. 获取捕获的输出')
  await api(`/api/tasks/${testTaskId}/output`, { method: 'DELETE' })
  for (const line of KNOWN_OUTPUT_LINES) {
    await api(`/api/tasks/${testTaskId}/output`, {
      method: 'POST',
      body: JSON.stringify({ line })
    })
  }
  {
    const res = await api(`/api/tasks/${testTaskId}/output`)
    capturedLines = res.outputLines.map(l => l.content)
    console.log(`   捕获到 ${capturedLines.length} 行`)
  }

  // Step 8: 一致性对比分析
  console.log('\n8. 一致性对比分析')
  const originalFiltered = KNOWN_OUTPUT_LINES.filter(l => l.trim() !== '')
  console.log(`   原始数据 (过滤空行): ${originalFiltered.length} 行`)
  console.log(`   捕获数据: ${capturedLines.length} 行`)

  // 8a. 行数一致性
  if (!await test('   8a. 行数一致性', async () => {
    if (capturedLines.length !== originalFiltered.length) {
      throw new Error(`行数不匹配: 原始=${originalFiltered.length}, 捕获=${capturedLines.length}`)
    }
  })) { failed++; }

  // 8b. 逐行内容对比
  let lineComparisonPassed = true
  console.log('\n   8b. 逐行内容对比:')
  for (let i = 0; i < Math.max(originalFiltered.length, capturedLines.length); i++) {
    const orig = originalFiltered[i] || '(缺失)'
    const cap = capturedLines[i] || '(缺失)'
    const match = orig === cap ? '✅' : '❌'
    if (orig !== cap) lineComparisonPassed = false
    const display = (s) => s.length > 50 ? s.substring(0, 50) + '...' : s
    console.log(`   ${match} 行${i + 1}: "${display(orig)}"`)
    if (orig !== cap) {
      console.log(`       捕获为: "${display(cap)}"`)
    }
  }

  if (!await test('   8b. 内容一致性', async () => {
    if (!lineComparisonPassed) throw new Error('存在内容不一致的行')
  })) { failed++; }

  // Step 9: currentOutput 字段（在空行测试之前执行）
  console.log('\n9. currentOutput 字段验证')
  const lastKnownLine = KNOWN_OUTPUT_LINES[KNOWN_OUTPUT_LINES.length - 1]
  if (!await test('9. currentOutput 正确更新', async () => {
    const res = await api(`/api/tasks/${testTaskId}/output`)
    if (res.currentOutput !== lastKnownLine) {
      throw new Error(`currentOutput 不正确: 期望="${lastKnownLine}", 实际="${res.currentOutput}"`)
    }
  })) { failed++; }

  // Step 10: 测试空行处理
  console.log('\n10. 空行处理测试')
  await api(`/api/tasks/${testTaskId}/output`, { method: 'DELETE' })

  const linesWithEmpty = ['Line 1', '', 'Line 3']
  for (const line of linesWithEmpty) {
    await api(`/api/tasks/${testTaskId}/output`, {
      method: 'POST',
      body: JSON.stringify({ line })
    })
  }

  if (!await test('10. 空行处理', async () => {
    const res = await api(`/api/tasks/${testTaskId}/output`)
    const captured = res.outputLines.map(l => l.content)
    // 空行被跳过不存储，outputLines 只包含非空行
    // 验证 outputLines 只包含 2 条（空行被过滤）
    if (captured.length !== 2) {
      throw new Error(`空行未正确处理: 期望2行, 实际${captured.length}行`)
    }
  })) { failed++; }

  // Step 11: 验证 50 行限制
  console.log('\n11. 输出行数限制测试')
  if (!await test('11. 50行限制检查', async () => {
    const task = await api(`/api/tasks/${testTaskId}`)
    if (task.task.outputLines && task.task.outputLines.length > 50) {
      throw new Error(`outputLines 超过50行限制: ${task.task.outputLines.length}`)
    }
    console.log(`   当前输出行数: ${task.task.outputLines?.length || 0}`)
  })) { failed++; }

  // Step 12: 清理测试任务
  if (ws) ws.close()
  await api(`/api/tasks/${testTaskId}`, { method: 'DELETE' })
  console.log('\n12. 测试任务已清理')

  console.log('\n' + '═'.repeat(60))
  console.log(`📊 结果: ${passed} 通过, ${failed} 失败`)

  if (failed > 0) {
    console.log('\n⚠️  捕获机制存在问题，需要修复')
    process.exit(1)
  } else {
    console.log('\n✅ 所有验证通过! 捕获机制工作正常')
    process.exit(0)
  }
}

runCaptureTest().catch(e => {
  console.error('\n测试执行失败:', e)
  process.exit(1)
})
