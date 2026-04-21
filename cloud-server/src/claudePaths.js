import fs from 'fs'
import os from 'os'
import path from 'path'

function uniquePaths(values = []) {
  const seen = new Set()
  const result = []

  for (const value of values) {
    if (!value) continue
    const resolved = path.resolve(String(value))
    if (seen.has(resolved)) continue
    seen.add(resolved)
    result.push(resolved)
  }

  return result
}

function collectNamedUserHomes() {
  const names = [process.env.SUDO_USER, process.env.LOGNAME, process.env.USER]
    .map(value => String(value || '').trim())
    .filter(Boolean)

  const homes = []
  for (const name of names) {
    const macHome = path.join('/Users', name)
    const linuxHome = path.join('/home', name)
    if (fs.existsSync(macHome)) homes.push(macHome)
    if (fs.existsSync(linuxHome)) homes.push(linuxHome)
  }

  return homes
}

function collectExistingUserClaudeDirs() {
  const roots = ['/Users', '/home']
  const results = []

  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const candidate = path.join(root, entry.name, '.claude')
      if (fs.existsSync(candidate)) {
        results.push(candidate)
      }
    }
  }

  return results
}

export function getClaudeConfigDirCandidates() {
  const explicitConfigDir = process.env.CLAUDE_CONFIG_DIR
  const explicitSkillsDir = process.env.CLAUDE_SKILLS_DIR
    ? path.dirname(path.resolve(process.env.CLAUDE_SKILLS_DIR))
    : null

  const homeCandidates = [
    process.env.HOME,
    os.homedir(),
    ...collectNamedUserHomes()
  ]
    .filter(Boolean)
    .map(home => path.join(home, '.claude'))

  return uniquePaths([
    explicitConfigDir,
    explicitSkillsDir,
    ...homeCandidates,
    ...collectExistingUserClaudeDirs()
  ])
}

export function resolvePreferredClaudeConfigDir() {
  const candidates = getClaudeConfigDirCandidates()
  return candidates.find(dir => fs.existsSync(dir)) || candidates[0] || path.join(os.homedir(), '.claude')
}

export function getClaudeSkillsDirCandidates() {
  return uniquePaths([
    process.env.CLAUDE_SKILLS_DIR,
    ...getClaudeConfigDirCandidates().map(dir => path.join(dir, 'skills'))
  ])
}

export function resolvePreferredClaudeSkillsDir() {
  const candidates = getClaudeSkillsDirCandidates()
  return candidates.find(dir => fs.existsSync(dir)) || candidates[0] || path.join(resolvePreferredClaudeConfigDir(), 'skills')
}

export function getClaudeAgentsDirCandidates() {
  return uniquePaths(getClaudeConfigDirCandidates().map(dir => path.join(dir, 'agents')))
}

export function resolvePreferredClaudeAgentsDir() {
  const candidates = getClaudeAgentsDirCandidates()
  return candidates.find(dir => fs.existsSync(dir)) || candidates[0] || path.join(resolvePreferredClaudeConfigDir(), 'agents')
}

export function buildClaudeAgentDirSources(projectAgentsDir) {
  const preferredAgentsDir = resolvePreferredClaudeAgentsDir()
  const userDirs = getClaudeAgentsDirCandidates().map(dir => ({
    dir,
    scope: 'claude-user',
    label: dir === preferredAgentsDir ? 'Claude Code 用户配置' : 'Claude Code 候选用户配置',
    writable: dir === preferredAgentsDir
  }))

  const sources = [
    ...userDirs,
    projectAgentsDir
      ? {
          dir: path.resolve(projectAgentsDir),
          scope: 'claude-project',
          label: 'Claude Code 项目配置',
          writable: true
        }
      : null
  ].filter(Boolean)

  return uniquePaths(sources.map(source => source.dir)).map(dir => sources.find(source => path.resolve(source.dir) === dir))
}

export function getClaudeCliLaunchSpec() {
  const explicitCommand = String(process.env.CLAUDE_BIN || process.env.CLAUDE_CMD || '').trim()
  const explicitCliPath = String(process.env.CLAUDE_CLI_PATH || '').trim()
  const candidates = [
    explicitCommand ? { kind: 'binary', path: explicitCommand } : null,
    { kind: 'binary', path: '/opt/homebrew/bin/claude' },
    { kind: 'binary', path: '/usr/local/bin/claude' },
    explicitCliPath ? { kind: 'entry', path: explicitCliPath } : null,
    { kind: 'entry', path: '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js' },
    { kind: 'entry', path: '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js' },
    { kind: 'binary', path: '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe' }
  ].filter(Boolean)

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate.path)) continue

    if (candidate.kind === 'entry') {
      return {
        command: 'node',
        prefixArgs: [candidate.path],
        displayCommand: `node ${candidate.path}`
      }
    }

    return {
      command: candidate.path,
      prefixArgs: [],
      displayCommand: candidate.path
    }
  }

  return {
    command: 'claude',
    prefixArgs: [],
    displayCommand: 'claude'
  }
}
