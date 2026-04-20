// Run verify-capture.mjs and capture output to file
import { spawn } from 'child_process'
import { writeFileSync } from 'fs'

const proc = spawn('node', ['verify-capture.mjs'], {
  cwd: '/Users/linhao/Downloads/claude-code/cloud-server',
  stdio: ['ignore', 'pipe', 'pipe']
})

let stdout = ''
let stderr = ''

proc.stdout.on('data', (chunk) => {
  const text = chunk.toString()
  stdout += text
  process.stdout.write(text)
})

proc.stderr.on('data', (chunk) => {
  const text = chunk.toString()
  stderr += text
  process.stderr.write(text)
})

proc.on('close', (code) => {
  writeFileSync('/tmp/capture-test-result.txt', stdout)
  writeFileSync('/tmp/capture-test-stderr.txt', stderr)
  console.log(`\n[Exit code: ${code}]`)
  process.exit(code || 0)
})
