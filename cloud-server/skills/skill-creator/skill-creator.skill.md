---
name: skill-creator
description: 自动创建新的 Skill，根据自然语言描述生成 SKILL.md 文件
version: 1.0.0
triggers:
  - /create-skill
  - 创建skill
  - 创建技能
  - new skill
  - 写一个skill
patterns:
  - "^创建.*skill"
  - "^做一个.*技能"
  - "^写.*skill.*帮我"
enabled: true
priority: 30
category: productivity
selfImproving: true
platforms:
  - darwin
  - linux
  - win32
configVars:
  - key: defaultDir
    description: Skill 默认保存目录
    default: "./skills"
    required: false
  - key: autoEnable
    description: 创建后自动启用
    default: "true"
    required: false
metadata:
  author: newai
  tags:
    - automation
    - skill-creation
---

# Skill Creator

自动根据描述创建新的 Skill。

## 使用方法

```
/create-skill <描述>
创建 skill <描述>
```

## 示例

```
/create-skill 一个天气查询技能，支持查询今天和明天的天气
创建一个 skill 用于管理书签，包括添加、删除、列表功能
```

## 创建流程

1. 解析用户描述
2. 生成 Skill 名称和描述
3. 确定触发词和模式
4. 生成 SKILL.md 文件
5. 可选：自动启用

## 输出格式

生成符合规范的 SKILL.md 文件：

```markdown
---
name: skill-name
description: 描述
version: 1.0.0
triggers:
  - /command
  - 关键词
enabled: true
priority: 10
category: general
---

# Skill Name

详细描述...
```
