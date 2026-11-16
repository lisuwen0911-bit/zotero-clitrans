# 智译 CLI Translate（zotero-clitrans）

Zotero 7 / 8 / 9 / 10 文献翻译插件，**Windows 和 macOS 通用**。

- **划词翻译**：在 PDF 里选中文字即出译文，可一键存入笔记。
- **段落翻译**：按住 Alt 点击任意段落，只翻译这一段。
- **整篇翻译（保留排版）**：生成双语 PDF，作为附件挂在条目下。有四种排版：
  - 逐段对照：每段原文下面紧接译文（推荐）；
  - 左右对照：左原文、右译文；
  - 交替页：一页原文、一页译文；
  - 仅译文。

  公式、图、表都完整保留：译文里的公式用 LaTeX 重新排版，图表中的文字也会翻译。
- **多种引擎**：
  - Google：免费，装好即用；
  - GPT：通过 Codex CLI，用 ChatGPT 订阅额度；
  - Claude：通过 Claude Code，用 Claude 订阅额度；
  - Gemini：通过 Antigravity 或 API Key。

  用 AI 引擎时，复杂公式会"看图识别"，上下标、分式不会乱。
- **术语表**、**翻译缓存**（同一篇换排版不重复消耗额度）、**MCP 接口**（让 Claude / Codex 读取你的文献库）。

---

## 1. 安装插件（1 分钟）

1. 下载最新的 [`clitranslate-x.y.z.xpi`](https://github.com/lisuwen0911-bit/zotero-clitrans)：在仓库文件列表里点开最新版本号的 `.xpi`，再点 **Download raw file**。
2. 打开 Zotero → **工具 → 插件**（Tools → Plugins）→ 右上角齿轮 → **从文件安装插件…**，选中刚下载的 `.xpi`。
3. 装好后：
   - 划词翻译（Google 引擎）立即可用：打开任意 PDF，选中一段英文即可。
   - 以后有新版本，Zotero 会自动更新。

## 2. 整篇翻译：一键配置运行环境（只需一次，5–15 分钟）

整篇翻译需要一个本地 Python 运行环境（PDF 解析、版面识别模型、公式排版、文字识别）。插件可以自动装好：

1. 打开 Zotero **设置**（Windows：编辑 → 设置；macOS：Zotero → 设置）→ 左侧 **智译 CLI**。
2. 在最上面的「快速开始」里：
   - 国内网络保持勾选「使用国内镜像下载」（默认已勾选）；
   - 点 **「一键配置翻译环境」**。
3. 下方会实时显示进度。插件会依次：
   1. 安装 [uv](https://docs.astral.sh/uv/)（Python 包管理器）；
   2. 用 uv 安装 [pdf2zh_next / BabelDOC](https://github.com/PDFMathTranslate/PDFMathTranslate-next)（自带 Python 3.12，不影响你电脑上已有的 Python）；
   3. 安装公式排版（matplotlib）、模糊匹配（rapidfuzz）、文字识别（RapidOCR）；
   4. 下载中文字体（思源宋体）和版面识别模型。
4. 看到「全部完成」就可以用了。中途断网或失败，再点一次即可，已装好的部分会跳过。

用法：在文库里**右键条目 →「智译：整篇翻译（保留排版）」→ 选引擎**。几分钟后双语 PDF 会作为附件出现在条目下并自动打开。排版在右键菜单「智译：排版」或阅读器工具栏的「排版」按钮里切换，换排版不会重新翻译。

## 3. 配置 AI 引擎（可选）

Google 免费引擎不需要任何配置。想要更好的译文和公式效果，可以配置下面任意一个。它们用的是你**本机已登录的命令行工具**，走你自己的订阅额度，不需要 API Key。

装好后，在设置页点 **「检测环境」**。找到的工具会显示 ✓，没找到的会直接给出安装命令。

| 引擎 | Windows | macOS |
|---|---|---|
| **GPT**（Codex CLI） | 先装 [Node.js](https://nodejs.org/)，然后在 PowerShell 运行 `npm install -g @openai/codex`，再运行 `codex login`，用 ChatGPT 账号登录 | 装 ChatGPT 桌面版（自带 Codex），或 `npm install -g @openai/codex` 后 `codex login` |
| **Claude**（Claude Code） | 先装 [Git for Windows](https://git-scm.com/download/win)，然后在 PowerShell 运行 `irm https://claude.ai/install.ps1 \| iex`，再运行 `claude` 登录 | 终端运行 `curl -fsSL https://claude.ai/install.sh \| bash`，再运行 `claude` 登录 |
| **Gemini** | 安装并登录 [Antigravity](https://antigravity.google/)（自带 `agy` 命令行），或在设置页填写 Gemini API Key | 同左 |

- 设置页每个引擎都有「测试」按钮，可以检查是否能正常调用。
- GPT 的模型可以点「读取我的模型」，从你账号可用的模型里选。
- 找不到命令行工具时，可以在设置页手动填写它的完整路径。例如 Windows 下 npm 安装的 Codex 一般在 `C:\Users\你的用户名\AppData\Roaming\npm\codex.cmd`。

## 4. 常见问题

**一键配置失败 / 很慢？**
保持勾选「使用国内镜像下载」后再试。如果卡在第 1 步（安装 uv），可以按 [uv 官方说明](https://docs.astral.sh/uv/getting-started/installation/) 手动安装，再回来点「一键配置」。也可以在终端里手动执行（Windows 用 PowerShell）：

```bash
uv tool install --python 3.12 pdf2zh_next
```

执行完再点一次「一键配置翻译环境」，插件会补齐剩余组件。

**整篇翻译提示"运行环境还没有安装"？**
按第 2 节点「一键配置翻译环境」。如果你用其他方式装了 pdf2zh_next，可以在设置页「Python 路径」里填它的 Python：
- Windows：`…\uv\tools\pdf2zh-next\Scripts\python.exe`
- macOS：`~/.local/share/uv/tools/pdf2zh-next/bin/python`

**翻译会上传我的文献吗？**
只有你选择的引擎会收到要翻译的文字（以及用 AI 引擎时的段落 / 图片截图），这和你平时直接使用这些服务一样。插件本身不收集任何数据。翻译缓存只保存在本机：
- Windows：`%LOCALAPPDATA%\clitrans\Cache`
- macOS：`~/Library/Caches/clitrans`

**图里的文字没翻译 / 编号位置不对？**
图中文字优先从 PDF 里提取。提取不到时用文字识别：macOS 用系统自带 OCR，Windows 用 RapidOCR。用 GPT / Claude / Gemini 引擎时，模型会直接看图读出文字和符号，效果最好。

## 致谢与许可

- 版面识别和 PDF 处理基于 [BabelDOC / pdf2zh_next](https://github.com/PDFMathTranslate/PDFMathTranslate-next)（AGPL-3.0）和 [PyMuPDF](https://pymupdf.readthedocs.io/)（AGPL-3.0）。
- 文字识别用 [RapidOCR](https://github.com/RapidAI/RapidOCR)。

本项目以 **AGPL-3.0** 许可开源，与上述依赖保持一致，详见 [LICENSE](LICENSE)。
