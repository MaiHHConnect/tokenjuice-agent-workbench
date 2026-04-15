# TokenJuice Workbench

*榨干每一单位 token 效率的多 Agent 白板工作台*

![TokenJuice Workbench: AI Agent Dashboard with task pipeline, system metrics, Wiki knowledge base and Skill management](assets/preview.jpg)

TokenJuice Workbench is an open-source control center for Claude Code / AI Agent workflows — combining task decomposition, sequential/parallel scheduling, execution, automatic QA, fix loops, Wiki knowledge沉淀, and Skill self-evolution on a single visual board. It's not just another TODO kanban; it's an agent workbench where "planner, executor, and evaluator" continuously collaborate.

**SEO Title:** TokenJuice Workbench - Claude Code Multi-Agent Whiteboard Workstation & AI Automation Kanban

**SEO Description:** TokenJuice Workbench is an open-source AI Agent workstation supporting Claude Code multi-agent scheduling, task decomposition, automatic QA, Wiki knowledge capture, Skill auto-generation and token efficiency optimization.

**SEO Keywords:** Claude Code, AI Agent, Multi-Agent, Agent Workbench, AI Kanban, automated development, multi-agent scheduling, Wiki knowledge base, Skill self-evolution, Token Efficiency, Whiteboard Workstation

## Why TokenJuice

Long-running AI coding hits three common walls: context drift, over-generous self-assessment, and chaotic parallelism on complex tasks. TokenJuice makes these bottlenecks explicit and product-driven:

- **Planner expands specs first**: Turn a one-line request into a product goal with subtasks, acceptance criteria, dependencies, and handoff artifacts.
- **Executor delivers by contract**: Every task has a "sprint contract" — must produce real files, verification commands, and a handoff summary.
- **Evaluator independently pokes holes**: QA doesn't rely on the executor's self-praise; it scores functional completeness, real artifacts, usability, visual design, and code quality.
- **Dependency-aware scheduling**: Child tasks under the same parent follow `dependsOn` order; independent tasks still run in parallel to fill capacity.
- **Automatic fix loop on failure**: Test failures automatically enter fix mode — no human "approve/reject" button needed.
- **Knowledge capture loop**: Completed tasks沉淀 into Wiki; reusable patterns become Skills — the system gets smarter with every run.

## Core Features

- **Multi-Agent Kanban**: `Backlog → Analyzing → InDev → ReadyForTest → InFix → Done/Blocked`
- **Automatic task decomposition**: Parent/child tasks, dependency DAGs, parallel groups, acceptance criteria, and QA Rubrics.
- **Automatic QA scheduling**: Tasks auto-trigger QA agent verification when reaching "Ready for Test"; failures auto-loop to fix.
- **Transient error retry**: Automatic retry on 429/529/overloaded errors — avoids false business bugs.
- **Wiki + Skill沉淀**: Task completion triggers knowledge cards and reusable `.skill.md` generation.
- **Claude agents packaged**: Repository includes `agents/claude/` role templates for planning, execution, testing, security review, etc.
- **Web UI**: Local browser whiteboard with real-time view of tasks, agents, Wiki, Skills, and scheduling status.
- **DingTalk integration**: Optional Webhook / Stream notifications and interactive commands.

## What the Preview Shows

The preview captures the TokenJuice main workstation: top bar shows system connection status, scheduler state, agent capacity and task stats; center displays the full pipeline from Backlog, Analyzing, InDev, ReadyForTest, InFix to Done; sidebar covers Wiki knowledge base, Skill management, and real-time task details. This interface is designed for observing multi-agent collaboration — not waiting for a black-box run to finish before knowing success or failure.

## Quick Start

```bash
npm install
cp .env.example .env
npm start
```

Open your browser at `http://localhost:18789` (or the port shown in terminal).

## Architecture

TokenJuice uses a Planner → Executor → Evaluator → Wiki/Skill loop:

```
Planner: Spec → Tasks → Dependencies → QA Rubrics
Scheduler: Assigns tasks based on capacity + DAG
Executor: Produces artifacts + verification commands + handoff summary
QA: Independent skeptical verification → bug report → auto-fix
Wiki/Skill:沉淀 completed work → reusable knowledge
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for full design notes.

## Project Structure

```
tokenjuice-agent-workbench/
├── agents/          # Claude agent role templates
├── assets/          # Preview images
├── data/            # Runtime data (scheduler state)
├── docs/            # Architecture, SEO, Skills & Agents docs
├── public/         # Static web assets
├── scripts/        # Utility scripts (secret scan, etc.)
├── skills/         # Auto-generated + manual Skills
├── src/            # Core application (Koa + WebSocket server)
├── test/           # Test files
├── WORKFLOW.md     # Development workflow guide
├── README.md       # Chinese README (中文说明)
└── README_EN.md    # This file (English)
```

## License

MIT License — see [LICENSE](LICENSE)

---

*TokenJuice Workbench — Every token counts.*
