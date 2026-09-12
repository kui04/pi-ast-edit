# pi-ast-edit

**[English](README.md)**

一个 [pi](https://github.com/earendil-works/pi) 扩展 扩展,将所有**文件编辑路由到 [ast-grep](https://github.com/ast-grep/ast-grep)** —— 对 28 种语言做 AST 结构化匹配,其余文件回退到精确文本替换。它替换内置的 `edit` 工具,并新增两个辅助工具:`ast_find`(结构化搜索)和 `ast_languages`(支持的文件类型)。

## 为什么

精确文本匹配在模型对空白记忆不准时会失败,还可能命中**错误位置** —— 比如部分 token,或者字符串/注释里的内容。ast-grep 匹配**完整 AST 节点**:忽略空白差异,且每次替换都会校验 —— 会破坏语法的改动**直接拒绝、不落盘**,整个文件在编辑后还会重新解析(出现新语法错误则整体回滚)。有歧义的 pattern 会被拒绝并列出全部匹配;用 `matchIndex` 或 `all: true` 指定,或收窄 pattern。

## 安装

```bash
pi install git:github.com/kui04/pi-ast-edit
# 或先试用不安装:pi -e git:github.com/kui04/pi-ast-edit
```

本地开发:`nix build`(或 `nix develop -c cargo build --release`),然后 `pi -e ./index.ts`。二进制按 `PI_AST_EDIT_BIN` → 本地构建 → postinstall 下载缓存 的顺序查找。缺失时 `edit` 警告一次、回退到 pi 内置编辑器,并在后台重新下载。

## 用法

```jsonc
// 精确模式(与内置工具兼容)
{ "path": "src/main.ts", "edits": [{ "oldText": "const x = 1", "newText": "const y = 2" }] }

// 结构化模式(pattern 语法:$A 一个节点,$$$A 零或多个,$$$ 任意)
{ "path": "src/main.ts", "edits": [
    { "pattern": "foo($A)", "replace": "bar($A)" },
    { "pattern": "foo()", "insertAfter": "baz();" },
    { "pattern": "oldCall();", "delete": true },
    { "pattern": "foo($A)", "replace": "bar($A)", "context": "function main() { $$$ }" },
    { "pattern": "foo($A)", "replace": "bar($A)", "matchIndex": 1 },
    { "pattern": "foo($A)", "replace": "bar($A)", "all": true }
] }
```

编辑前用 `ast_find` 定位代码:

```
ast_find { "path": "src/main.ts", "pattern": "foo($A)" }
ast_find { "path": "src/main.ts", "kind": "function_declaration" }
ast_find { "path": "src/main.ts", "position": "12:5" }
```

## 开发

开发环境为 nix flake —— 所有命令都通过 `nix develop` 运行:

```bash
nix develop -c npm install   # 开发依赖(一次即可)
nix develop -c cargo test
nix develop -c cargo clippy --all-targets -- -D warnings
nix develop -c cargo fmt --check
nix develop -c npx tsc --noEmit
nix develop -c npx @biomejs/biome ci --error-on-warnings .
nix develop -c node scripts/test-downloader.mjs
nix build                     # 二进制 → result/bin/pi-ast-edit
```

E2E(较慢,需要真实模型):`cp scripts/.env.example scripts/.env`,设置 `PI_E2E_MODEL`,然后 `nix develop -c node scripts/test-e2e.mjs`。提交请在 shell 内进行 —— `nix develop -c git commit`(pre-commit 钩子依赖 shell 的工具链;不要用 `--no-verify`)。

## 遥测与反思(telemetry & reflection)

**反思默认开启,且不需要日志**:输入就是当前会话分支上失败的 `edit` 工具结果。当自上次结论以来新失败累积到 `reflectAfterErrors` 条(默认 3)时,回合结束后会发起一次干净的、与会话无关的模型请求(不含对话、工具或提示词,只有失败行)做一次反思,并把结论作为一条自定义消息(`ast-edit.reflection`)写入对话记录、排给下一轮——不会额外触发一轮 agent;已反思过的失败不会重复反思(marker 随结论消息一起保存)。一切都从会话本身推导,重启与压缩都不会打乱。

**遥测是开发者日志,默认关闭**:开启 `traceEnabled` 后,每次 `edit` 调用追加一行 JSON 到 `~/.pi/agent/ast-edit.log.jsonl`,方便用 `jq`/`grep` 分析。

两项均在 `~/.pi/agent/settings.json` 中配置:

```jsonc
{
  "ast-edit": {
    "traceEnabled": true,  // 可选;默认关闭 — 记录每次 edit 调用的开发者日志
    "tracePath": "…",      // 可选覆盖;默认 `~/.pi/agent/ast-edit.log.jsonl`
    "autoReflect": false,  // 可选;默认开启 — 有新失败时回合后自动反思
    "reflectModel": "provider/modelId", // 可选;默认与主模型一致
    "reflectAfterErrors": 5 // 可选;新失败累积到多少条才反思(默认 3)
  }
}
```

完全被动——没有需要手动执行的命令。