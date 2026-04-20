/**
 * Playwright 截图脚本 — Cloud Server AI Agent 看板
 * 目标：捕获 5 个核心界面截图，保存至 /Users/linhao/Desktop/测试视频/assets/
 */

import { chromium } from 'playwright'
import path from 'path'
import fs from 'fs'

const ASSETS_DIR = '/Users/linhao/Desktop/测试视频/assets/'
const BASE_URL = 'http://localhost:8085'
const VIEWPORT = { width: 1400, height: 900 }

// 确保目录存在
if (!fs.existsSync(ASSETS_DIR)) {
  fs.mkdirSync(ASSETS_DIR, { recursive: true })
}

const screenshots = []

async function capture(page, filename, description) {
  const filepath = path.join(ASSETS_DIR, filename)
  await page.screenshot({ path: filepath, fullPage: false })
  screenshots.push({ filename, description, filepath })
  console.log(`  ✅ 截图: ${filename} (${description})`)
}

async function waitForLoad(page) {
  // 等待 DOM 稳定，不再依赖 networkidle（避免 JS fetch 请求干扰）
  await page.waitForFunction(() => {
    return document.querySelector('.kanban-column') !== null
  }, { timeout: 10000 }).catch(() => {
    console.log('  ⚠️  看板列未找到，继续执行')
  })
  await page.waitForTimeout(1000)
}

async function main() {
  console.log('🚀 启动 Playwright 截图...\n')

  const browser = await chromium.launch({ headless: false })
  const page = await browser.newPage()
  await page.setViewportSize(VIEWPORT)

  try {
    // =============================================
    // 截图 1: 看板主视图（Backlog→Done 全流程）
    // =============================================
    console.log('\n📸 截图 1: 看板主视图')
    await page.goto(BASE_URL, { waitUntil: 'load' })
    await waitForLoad(page)
    await capture(page, '01-kanban-board.png', 'AI Agent 看板 — Backlog→Done 全流程')

    // =============================================
    // 截图 2: Wiki 知识沉淀页面
    // =============================================
    console.log('\n📸 截图 2: Wiki 知识沉淀页面')
    // 找到并点击 Wiki 统计卡片
    const wikiCard = page.locator('[onclick*="wiki"]').first()
    await wikiCard.click()
    // 等待 modal 出现
    await page.waitForSelector('#knowledge-modal.active', { timeout: 5000 })
    await page.waitForTimeout(1000)
    await capture(page, '02-wiki-knowledge.png', 'Wiki 知识沉淀页面')

    // 关闭 Wiki modal（点击遮罩或按钮）
    const closeBtn = page.locator('#knowledge-modal button[onclick*="closeModal"]').first()
    if (await closeBtn.isVisible()) {
      await closeBtn.click()
    }
    await page.waitForTimeout(800)

    // =============================================
    // 截图 3: Skills 自优化面板
    // =============================================
    console.log('\n📸 截图 3: Skills 自优化面板')
    const skillsCard = page.locator('[onclick*="skill"]').first()
    await skillsCard.click()
    await page.waitForSelector('#knowledge-modal.active', { timeout: 5000 })
    await page.waitForTimeout(1000)
    await capture(page, '03-skills-panel.png', 'Skills 自优化面板')

    // 关闭 Skills modal
    if (await page.locator('#knowledge-modal button[onclick*="closeModal"]').first().isVisible()) {
      await page.locator('#knowledge-modal button[onclick*="closeModal"]').first().click()
    }
    await page.waitForTimeout(800)

    // =============================================
    // 截图 4: 多 Agent 协作界面（点击任务卡片）
    // =============================================
    console.log('\n📸 截图 4: 任务详情 / 多 Agent 协作界面')
    const firstCard = page.locator('.task-card').first()
    if (await firstCard.isVisible({ timeout: 3000 }).catch(() => false)) {
      await firstCard.click()
      await page.waitForSelector('#task-modal.active', { timeout: 5000 })
      await page.waitForTimeout(1000)
      await capture(page, '04-task-detail.png', '任务详情 — 多 Agent 协作界面')
      // 关闭任务详情
      if (await page.locator('#task-modal button[onclick*="closeModal"]').first().isVisible().catch(() => false)) {
        await page.locator('#task-modal button[onclick*="closeModal"]').first().click()
      }
      await page.waitForTimeout(800)
    } else {
      console.log('  ⚠️  未找到任务卡片，截取当前视图')
      await capture(page, '04-task-detail.png', 'AI Agent 看板全貌')
    }

    // =============================================
    // 截图 5: Autopilot 执行界面 / 创建任务面板
    // =============================================
    console.log('\n📸 截图 5: Autopilot 任务创建界面')
    const createBtn = page.locator('button:has-text("新建任务"), button.btn-primary').first()
    await createBtn.click()
    await page.waitForSelector('#create-modal.active', { timeout: 5000 })
    await page.waitForTimeout(800)
    await capture(page, '05-autopilot-create-task.png', 'Autopilot 任务创建界面')

    // =============================================
    // 截图 6: 调度器状态 / Agent 统计面板（备选）
    // =============================================
    console.log('\n📸 截图 6: 调度器容量管理面板')
    if (await page.locator('#create-modal.active').isVisible().catch(() => false)) {
      if (await page.locator('#create-modal button[onclick*="closeModal"]').first().isVisible().catch(() => false)) {
        await page.locator('#create-modal button[onclick*="closeModal"]').first().click()
      }
    }
    await page.waitForTimeout(800)
    // 截图调度器区域（右侧统计卡片）
    await capture(page, '06-scheduler-stats.png', '调度器统计与容量管理面板')

  } catch (err) {
    console.error('\n❌ 截图过程中出错:', err.message)
    console.error(err.stack)
  } finally {
    await browser.close()
  }

  // 输出总结
  console.log('\n' + '═'.repeat(60))
  console.log('📁 截图保存目录:', ASSETS_DIR)
  console.log('📊 截图数量:', screenshots.length)
  for (const s of screenshots) {
    const size = fs.existsSync(s.filepath)
      ? (fs.statSync(s.filepath).size / 1024).toFixed(1) + ' KB'
      : '文件不存在'
    console.log(`  • ${s.filename} — ${s.description} (${size})`)
  }
  console.log('═'.repeat(60))

  if (screenshots.length >= 5) {
    console.log('\n✅ 完成！至少 5 张截图已产出。')
    process.exit(0)
  } else {
    console.log('\n⚠️  截图数量不足 5 张，请检查浏览器配置。')
    process.exit(1)
  }
}

main().catch(e => {
  console.error('Fatal error:', e)
  process.exit(1)
})
