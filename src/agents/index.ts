export { pmAgentConfig, pmAgentPrompt } from './pm/prompt'
export { devAgentConfig, devAgentPrompt } from './dev/prompt'
export { qaAgentConfig, qaAgentPrompt } from './qa/prompt'
export { deployAgentConfig, deployAgentPrompt } from './deploy/prompt'

import { pmAgentConfig } from './pm/prompt'
import { devAgentConfig } from './dev/prompt'
import { qaAgentConfig } from './qa/prompt'
import { deployAgentConfig } from './deploy/prompt'

export const allAgents = [
  pmAgentConfig,
  devAgentConfig,
  qaAgentConfig,
  deployAgentConfig
]
