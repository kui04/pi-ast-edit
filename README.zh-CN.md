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

## 遥测(telemetry)

可选:把每次 `edit` 调用记录为 session 条目,用会话模型分析失败模式。在 `~/.pi/agent/settings.json` 中启用:

```jsonc
{ "piAstEdit": { "traceEnabled": true, "insightsLines": 300 } }
```

然后运行 `/ast-edit-insights`(可带数量参数或 `all`)—— 模型会归纳失败模式,并为工具的提示词规则提出具体改进。