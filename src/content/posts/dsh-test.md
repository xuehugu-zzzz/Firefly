---
title: 测试文章：DSH 编辑流程验证
published: 2026-11-01
description: 这是由 DeepSeek Harness 直接写入并提交的第一篇测试文章
tags: [测试, DSH]
category: 随笔
draft: false
---

这篇文章是用来验证「AI 直接编辑博客仓库 → git 提交 → 推送到 GitHub」这条链路是否跑通的。

## 验证了什么

- 能在 `src/content/posts` 下新建 Markdown 文件
- 能按 Firefly 的 frontmatter schema 填字段（title / published / tags / category / draft）
- 能在本地完成 git commit
- 能推送到 `xuehugu-zzzz/Firefly` 的 master 分支

## 后续

如果这条链路没问题，之后就可以直接在对话里说「帮我写一篇关于 xx 的文章」，
我来生成文件、提交、推送，你只需要在最后确认。

> 这是一篇测试文章，确认无误后可以删除。
