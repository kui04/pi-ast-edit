# pi-ast-edit

**[English](README.md)**

一个 [pi](https://github.com/earendil-works/pi) 扩展，将所有**文件编辑路由到
[ast-grep](https://github.com/ast-grep/ast-grep)** —— 对 28 种语言做 AST 结构化匹配，
其余文件回退到精确文本替换。它替换内置的 `edit` 工具，并新增两个辅助工具：
`ast_find`（结构化搜索）和 `ast_languages`（支持的文件类型）。

## 你会得到什么

- **`edit` 被替换**：编辑走 Rust 二进制，而不是文本搜索。agent 可以直接给出 ast-grep
  pattern，匹配的是**完整 AST 节点** —— 空白与格式差异不再让改动失败，字符串或注释里的
  片段也不会再被误伤。
- **`ast_find` / `ast_languages`**：编辑前先定位代码 —— 按 pattern、按节点类型、或按
  `line:col`；并可列出支持的文件类型（28 种语言、71 个扩展名）。
- **不安全就不落盘**：结构化替换先独立解析；编辑后**整个文件重新解析**，只要文件仍有
  语法错误就拒绝写入（本来就有语法错误的文件，必须由同一次编辑修好）。有歧义的匹配会被
  拒绝（绝不“命中第一个就改”），并把全部匹配交给 agent 自己挑。

## 安装

```bash
pi install git:github.com/kui04/pi-ast-edit            # 跟随默认分支
pi install git:github.com/kui04/pi-ast-edit@v0.2.3     # 或锁定某个发布版本
pi -e git:github.com/kui04/pi-ast-edit                 # 不安装，先试用
```

Rust 二进制来自 release 页：预编译 Linux x64/arm64、macOS x64/arm64、Windows x64。其他
平台或者想用本地构建，执行 `nix build`（或 `nix develop -c cargo build --release`），
然后 `pi -e ./index.ts`。二进制的查找顺序是 `PI_AST_EDIT_BIN` → 本地构建 → 下载缓存；
缺失时 `edit` 只会警告一次，对 `oldText`/`newText` 这类纯文本编辑回退到 pi 内置编辑器
（结构化编辑则会明确报错说明未执行，而不是被悄悄跳过），同时在后台重试下载。

## 配置

两项都可选，写在 `~/.pi/agent/settings.json` 的 `ast-edit` 键下（支持
`$PI_CODING_AGENT_DIR`）：

```jsonc
{
  "ast-edit": {
    "autoReflect": false,    // 反思：默认开启（见下）
    "reflectAfterErrors": 3, // 失败累积到多少条触发反思（默认 3）
    "reflectModel": {        // 反思请求使用的模型；默认与主模型一致
      "providerId": "openrouter",
      "modelId": "nvidia/nemotron",
      "thinkingLevel": "high" // off|minimal|low|medium|high|xhigh|max
    },
    "traceEnabled": false,   // 开发者日志：默认关闭
    "tracePath": "…"         // 默认 `~/.pi/agent/ast-edit.log.jsonl`
  }
}
```

### 反思（reflection，默认开启）

输入是当前会话里本扩展失败的 `edit` 调用 —— 不涉及任何日志文件。当某一回合结束时，自上次
结论以来未反思的失败数达到 `reflectAfterErrors`，就发起一次干净的、与会话无关的请求
（只有失败行：不含对话、工具与提示词），结论作为一条 `ast-edit.reflection` 消息排进对话
记录、交给下一回合。**每次触发会多花一次模型请求** —— 上面三个配置正是为此：少反思几次、
换更便宜或更深的模型，或者直接关掉。

### 日志（trace，默认关闭）

开启 `traceEnabled` 后，每次 `edit` 调用会往 `~/.pi/agent/ast-edit.log.jsonl` 追加一行
JSON（工具调用 id、会话、模型、路径、模式、结果、耗时、错误）—— 一次调用一行，可直接
`grep` / `jq`。

## 能力边界

- 结构化模式需要 ast-grep 支持的语言（`ast_languages` 列出的 28 种）；其他文件 ——
  `.toml`、`.sql`、`.vue`、无扩展名脚本等 —— 回退为纯精确文本替换，没有 AST 匹配与校验。
- 精确模式是**字节级精确**：空白或换行有一点不同就等于“找不到”。它也不接受结构化参数
  （`insertBefore` / `insertAfter` / `delete` 会被拒绝，并提示改用 pattern 形式）。
- 一次调用只改已存在的文件：文件必须存在、可写、UTF-8（BOM 与 CRLF 会保留）。不能新建或
  删除文件；同一次调用里的多条编辑也相互看不到对方的改动。
- pattern 必须是该语言里合法且可解析的代码，而各语法支持的范围不同：某些表达式级形态
  （Dart 就是其中之一）根本解析不成 pattern。

## 开发

开发环境是 nix flake —— 所有命令都通过 `nix develop` 运行：

```bash
nix develop -c npm install   # 开发依赖（一次即可）
nix develop -c cargo test
nix develop -c cargo clippy --all-targets -- -D warnings
nix develop -c cargo fmt --check
nix develop -c npx tsc --noEmit
nix develop -c npx @biomejs/biome ci --error-on-warnings .
nix develop -c npm run test:ts   # TS 单测 + 集成 + 二进制下载器
nix build                        # 二进制 → result/bin/pi-ast-edit
```

提交请在 shell 内进行 —— `nix develop -c git commit`（pre-commit 钩子依赖 shell 的
工具链；不要用 `--no-verify`）。同样的清单与约定、发布步骤都在 [AGENTS.md](AGENTS.md)。
