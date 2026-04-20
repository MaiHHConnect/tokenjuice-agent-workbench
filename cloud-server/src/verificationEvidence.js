import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { pathToFileURL } from 'url'

const PAGE_EXTENSIONS = new Set(['.html', '.htm'])
const SQLITE_EXTENSIONS = new Set(['.db', '.sqlite', '.sqlite3'])
const DATA_EXTENSIONS = new Set(['.json', '.sql', '.db', '.sqlite', '.sqlite3'])
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '0.0.0.0'])
const MAX_URL_TARGETS = 4
const MAX_FILE_TARGETS = 4

function uniqueValues(values = []) {
  const seen = new Set()
  const result = []

  for (const value of values) {
    const normalized = String(value || '').trim()
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }

  return result
}

function trimSnippet(value, maxLength = 500) {
  const text = String(value || '')
    .replace(/\r/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (!text) return ''
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text
}

function slugify(value) {
  const safe = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return safe || 'evidence'
}

function resolveExistingPath(rawValue, workspacePath) {
  const candidate = String(rawValue || '').trim()
  if (!candidate) return null

  const absolutePath = path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(workspacePath, candidate)

  return fs.existsSync(absolutePath) ? absolutePath : null
}

function extractTaskText(task) {
  const parts = [
    task?.title,
    task?.description,
    task?.currentOutput,
    ...(Array.isArray(task?.outputLines) ? task.outputLines.map(item => item?.content) : []),
    ...(Array.isArray(task?.messages) ? task.messages.map(item => item?.content) : [])
  ]

  return parts
    .map(item => String(item || '').trim())
    .filter(Boolean)
    .join('\n')
}

function extractUrls(text) {
  const matches = String(text || '').match(/https?:\/\/[^\s"'`<>]+/g) || []
  return uniqueValues(matches)
}

function isLocalHttpUrl(value) {
  try {
    const target = new URL(value)
    if (!['http:', 'https:'].includes(target.protocol)) return false
    const host = target.hostname.toLowerCase()
    return (
      LOCAL_HOSTS.has(host) ||
      host.endsWith('.local') ||
      host.startsWith('10.') ||
      host.startsWith('192.168.') ||
      host.startsWith('172.16.') ||
      host.startsWith('172.17.') ||
      host.startsWith('172.18.') ||
      host.startsWith('172.19.') ||
      host.startsWith('172.2')
    )
  } catch (error) {
    return false
  }
}

function looksLikeApiUrl(value) {
  try {
    const target = new URL(value)
    return /\/api(\/|$)/i.test(target.pathname) || /\.(json|txt)$/i.test(target.pathname)
  } catch (error) {
    return false
  }
}

function isPageFile(filePath) {
  return PAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

function isDataFile(filePath) {
  return DATA_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

function collectArtifactFiles(task, workspacePath, artifactManifest = []) {
  const candidates = []

  for (const item of artifactManifest) {
    if (!item) continue
    if (item.exists && item.absolutePath) {
      candidates.push(path.resolve(item.absolutePath))
      continue
    }
    if (item.path) {
      const resolved = resolveExistingPath(item.path, workspacePath)
      if (resolved) candidates.push(resolved)
    }
  }

  for (const item of Array.isArray(task?.handoffArtifacts) ? task.handoffArtifacts : []) {
    const resolved = resolveExistingPath(item, workspacePath)
    if (resolved) candidates.push(resolved)
  }

  return uniqueValues(candidates).slice(0, 20)
}

function extractHtmlTitle(content) {
  const match = String(content || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  return trimSnippet(match?.[1] || '', 120)
}

function stripHtml(content) {
  return String(content || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
}

function summarizeJsonValue(value) {
  if (Array.isArray(value)) {
    const first = value[0]
    const firstType = first === null ? 'null' : Array.isArray(first) ? 'array' : typeof first
    return `数组，长度 ${value.length}${value.length > 0 ? `，首项类型 ${firstType}` : ''}`
  }

  if (value && typeof value === 'object') {
    const keys = Object.keys(value)
    return `对象，字段 ${keys.slice(0, 12).join(', ') || '无'}${keys.length > 12 ? ' ...' : ''}`
  }

  return `标量值 (${typeof value})`
}

async function fetchUrlEvidence(url) {
  const response = await fetch(url, {
    method: 'GET',
    redirect: 'follow',
    signal: AbortSignal.timeout(10000)
  })

  const contentType = response.headers.get('content-type') || ''
  const rawBody = await response.text()
  let jsonSummary = ''

  if (contentType.includes('json') || /^[\[{]/.test(rawBody.trim())) {
    try {
      const parsed = JSON.parse(rawBody)
      jsonSummary = summarizeJsonValue(parsed)
    } catch (error) {}
  }

  return {
    url,
    ok: response.ok,
    status: response.status,
    contentType,
    bodyLength: rawBody.length,
    bodySnippet: trimSnippet(rawBody, 700),
    jsonSummary
  }
}

function inspectSqliteFile(filePath) {
  const tablesResult = spawnSync('sqlite3', [filePath, '.tables'], {
    encoding: 'utf-8',
    timeout: 10000
  })

  if (tablesResult.error) {
    return {
      filePath,
      type: 'sqlite',
      ok: false,
      error: tablesResult.error.message
    }
  }

  if (tablesResult.status !== 0) {
    return {
      filePath,
      type: 'sqlite',
      ok: false,
      error: trimSnippet(tablesResult.stderr || `sqlite3 exited with ${tablesResult.status}`, 300)
    }
  }

  const tables = tablesResult.stdout
    .split(/\s+/)
    .map(item => item.trim())
    .filter(Boolean)

  return {
    filePath,
    type: 'sqlite',
    ok: true,
    tableCount: tables.length,
    tables: tables.slice(0, 20)
  }
}

function inspectDataFile(filePath) {
  const ext = path.extname(filePath).toLowerCase()

  if (SQLITE_EXTENSIONS.has(ext)) {
    return inspectSqliteFile(filePath)
  }

  const rawContent = fs.readFileSync(filePath, 'utf-8')

  if (ext === '.json') {
    try {
      const parsed = JSON.parse(rawContent)
      return {
        filePath,
        type: 'json',
        ok: true,
        summary: summarizeJsonValue(parsed),
        snippet: trimSnippet(rawContent, 700)
      }
    } catch (error) {
      return {
        filePath,
        type: 'json',
        ok: false,
        error: error.message,
        snippet: trimSnippet(rawContent, 700)
      }
    }
  }

  return {
    filePath,
    type: ext.replace('.', '') || 'text',
    ok: true,
    lineCount: rawContent.split('\n').length,
    snippet: trimSnippet(rawContent, 700)
  }
}

async function openPageWithPlaywright(browser, target, reportDir) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const targetUrl = target.type === 'file'
    ? pathToFileURL(target.path).href
    : target.url
  const screenshotPath = path.join(reportDir, `${slugify(path.basename(target.path || targetUrl)) || 'page'}.png`)

  try {
    const response = await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    })
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})

    const title = await page.title().catch(() => '')
    const bodyText = await page.locator('body').innerText().catch(() => '')
    await page.screenshot({
      path: screenshotPath,
      fullPage: true
    })

    return {
      ok: true,
      method: 'playwright',
      url: targetUrl,
      status: response?.status?.() || null,
      title: trimSnippet(title, 120),
      bodyTextLength: bodyText.length,
      bodyTextSnippet: trimSnippet(bodyText, 700),
      screenshotPath
    }
  } finally {
    await page.close().catch(() => {})
  }
}

async function capturePageEvidence(target, reportDir, browser, browserError) {
  if (browser) {
    try {
      return await openPageWithPlaywright(browser, target, reportDir)
    } catch (error) {
      browserError = error.message
    }
  }

  if (target.type === 'file') {
    const rawContent = fs.readFileSync(target.path, 'utf-8')
    return {
      ok: false,
      method: 'file-read',
      url: pathToFileURL(target.path).href,
      title: extractHtmlTitle(rawContent),
      bodyTextLength: stripHtml(rawContent).length,
      bodyTextSnippet: trimSnippet(stripHtml(rawContent), 700),
      error: browserError || 'Playwright 不可用，已降级为静态 HTML 检查'
    }
  }

  try {
    const fetched = await fetchUrlEvidence(target.url)
    return {
      ok: fetched.ok,
      method: 'fetch',
      url: target.url,
      status: fetched.status,
      title: '',
      bodyTextLength: fetched.bodyLength,
      bodyTextSnippet: fetched.bodySnippet,
      error: browserError || null
    }
  } catch (error) {
    return {
      ok: false,
      method: 'fetch',
      url: target.url,
      error: browserError || error.message
    }
  }
}

function buildEvidenceSummary(report) {
  const lines = ['【系统预采集证据】']

  if (report.pages.length > 0) {
    lines.push('页面证据:')
    report.pages.forEach((item, index) => {
      const parts = [
        `${index + 1}. ${item.url}`,
        item.status ? `状态 ${item.status}` : '',
        item.title ? `标题 ${item.title}` : '',
        item.screenshotPath ? `截图 ${item.screenshotPath}` : '',
        item.error ? `备注 ${item.error}` : ''
      ].filter(Boolean)
      lines.push(parts.join(' | '))
    })
  }

  if (report.apis.length > 0) {
    lines.push('API 证据:')
    report.apis.forEach((item, index) => {
      const parts = [
        `${index + 1}. ${item.url}`,
        `状态 ${item.status}`,
        item.contentType || '',
        item.jsonSummary || item.bodySnippet || ''
      ].filter(Boolean)
      lines.push(parts.join(' | '))
    })
  }

  if (report.databases.length > 0) {
    lines.push('数据库/数据证据:')
    report.databases.forEach((item, index) => {
      const details = item.type === 'sqlite'
        ? (item.ok ? `表 ${item.tables?.join(', ') || '无'}` : `错误 ${item.error}`)
        : (item.summary || item.snippet || item.error || '')
      lines.push(`${index + 1}. ${item.filePath} | ${details}`)
    })
  }

  if (report.pages.length === 0 && report.apis.length === 0 && report.databases.length === 0) {
    lines.push('未识别到可自动取证的页面/API/数据库目标。')
  }

  lines.push(`证据报告: ${report.reportPath}`)
  const text = lines.join('\n').replace(/\r/g, '').trim()
  return text.length > 4000 ? `${text.slice(0, 4000)}...` : text
}

export async function collectVerificationEvidence(task, workspacePath, options = {}) {
  const artifactManifest = Array.isArray(options.artifactManifest) ? options.artifactManifest : []
  const reportDir = path.join(workspacePath, '.omc', 'qa')
  fs.mkdirSync(reportDir, { recursive: true })

  const text = extractTaskText(task)
  const artifactFiles = collectArtifactFiles(task, workspacePath, artifactManifest)
  const urls = extractUrls(text).filter(isLocalHttpUrl)

  const pageTargets = [
    ...urls.filter(url => !looksLikeApiUrl(url)).slice(0, MAX_URL_TARGETS).map(url => ({ type: 'url', url })),
    ...artifactFiles.filter(isPageFile).slice(0, MAX_FILE_TARGETS).map(filePath => ({ type: 'file', path: filePath }))
  ].slice(0, MAX_URL_TARGETS + MAX_FILE_TARGETS)

  const apiTargets = urls
    .filter(url => looksLikeApiUrl(url))
    .slice(0, MAX_URL_TARGETS)

  const databaseTargets = artifactFiles
    .filter(isDataFile)
    .slice(0, MAX_FILE_TARGETS)

  let browser = null
  let browserError = ''
  if (pageTargets.length > 0) {
    try {
      const { chromium } = await import('playwright')
      browser = await chromium.launch({
        headless: true
      })
    } catch (error) {
      browserError = error.message
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    workspacePath,
    pages: [],
    apis: [],
    databases: [],
    reportPath: path.join(reportDir, 'verification-evidence.json')
  }

  try {
    for (const target of pageTargets) {
      report.pages.push(await capturePageEvidence(target, reportDir, browser, browserError))
    }
  } finally {
    if (browser) {
      await browser.close().catch(() => {})
    }
  }

  for (const target of apiTargets) {
    try {
      report.apis.push(await fetchUrlEvidence(target))
    } catch (error) {
      report.apis.push({
        url: target,
        ok: false,
        status: null,
        contentType: '',
        bodyLength: 0,
        bodySnippet: '',
        error: error.message
      })
    }
  }

  for (const filePath of databaseTargets) {
    try {
      report.databases.push(inspectDataFile(filePath))
    } catch (error) {
      report.databases.push({
        filePath,
        type: path.extname(filePath).replace('.', '') || 'file',
        ok: false,
        error: error.message
      })
    }
  }

  fs.writeFileSync(report.reportPath, JSON.stringify(report, null, 2), 'utf-8')

  return {
    reportPath: report.reportPath,
    summary: buildEvidenceSummary(report),
    report
  }
}

export default {
  collectVerificationEvidence
}
