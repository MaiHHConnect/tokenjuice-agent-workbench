---
name: code-reviewer
description: 代码审查 Skill，自动审查代码质量、风格和安全问题
version: 1.0.0
triggers:
  - /review
  - 代码审查
  - review
  - 审查代码
patterns:
  - "^审查 (.+\\.\\w+)"
  - "^review (.+\\.\\w+)"
enabled: true
priority: 15
category: development
selfImproving: true
platforms:
  - darwin
  - linux
  - win32
configVars:
  - key: maxIssues
    description: 最大显示问题数量
    default: "10"
    required: false
  - key: severity
    description: 最小严重级别 (info/warning/error)
    default: "warning"
    required: false
metadata:
  author: newai-team
  tags:
    - code-review
    - quality
    - security
---

# Code Reviewer Skill

自动化的代码审查工具，检查代码质量、风格和安全问题。

## 功能

- **代码风格检查** - 格式、命名规范
- **最佳实践检查** - 代码设计模式
- **安全漏洞扫描** - 常见安全问题
- **性能建议** - 性能优化提示

## 触发方式

- 发送 `/review` 获取帮助
- `审查 <文件路径>` - 审查指定文件
- `review <file>` - 英文版本

## 自改进

系统会学习你的代码风格偏好，自动调整审查规则。
