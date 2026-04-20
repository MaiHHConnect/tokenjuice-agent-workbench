---
name: hello-world
description: 一个简单的 Hello World 示例 Skill，用于演示 Skills 系统的基本功能
version: 1.0.0
triggers:
  - /hello
  - 你好
  - hello world
enabled: true
priority: 10
category: examples
selfImproving: true
configVars:
  - key: greeting
    description: 自定义问候语
    default: "你好"
    required: false
---

# Hello World Skill

这是一个示例 Skill，演示如何使用 Skills 自改进系统。

## 使用方法

发送 `/hello` 或包含 "你好"、"hello world" 的消息即可触发。

## 自改进

这个 Skill 启用了自改进功能，会记录使用情况并自动优化。
