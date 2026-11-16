/* 智译 CLI — preference pane script (runs in the settings window) */
(function () {
  let tries = 0;
  function init() {
    const out = document.getElementById("clitrans-test-out");
    const gl = document.getElementById("clitrans-glossary");
    if (!out || !gl) {
      if (tries++ < 50) setTimeout(init, 100);
      return;
    }
    if (gl.dataset.clitransReady) return;
    gl.dataset.clitransReady = "1";
    const api = Zotero.CLITrans;
    if (!api) { out.textContent = "插件尚未加载完成，请重新打开设置。"; return; }

    // glossary textarea is bound manually
    gl.value = Zotero.Prefs.get("clitrans.glossary") || "";
    gl.addEventListener("input", () => Zotero.Prefs.set("clitrans.glossary", gl.value));

    const showSetup = () => {
      const s = api.describeSetup();
      document.getElementById("clitrans-mcp-cmds").textContent =
        "# Claude Code\n" + s.claudeMcpCmd + "\n\n# Codex\n" + s.codexMcpCmd + "\n\nMCP 地址：" + s.mcp;
      return s;
    };
    showSetup();

    const test = (engine) => async () => {
      out.textContent = api.ENGINES[engine].label + " 测试中…";
      try { out.textContent = await api.selfTest(engine); }
      catch (e) { out.textContent = "⚠️ " + ((e && e.message) || e); }
    };
    document.getElementById("clitrans-test-google").addEventListener("command", test("google"));
    document.getElementById("clitrans-test-codex").addEventListener("command", test("codex"));
    document.getElementById("clitrans-test-claude").addEventListener("command", test("claude"));
    document.getElementById("clitrans-test-gemini").addEventListener("command", test("gemini"));
    document.getElementById("clitrans-codex-models").addEventListener("command", async () => {
      out.textContent = "读取 Codex 模型列表…";
      try {
        const models = await api.listCodexModels();
        const ml = document.getElementById("clitrans-codex-model");
        const popup = document.getElementById("clitrans-codex-model-popup");
        const keep = ml.value;
        popup.replaceChildren();
        for (const m of models) {
          const it = document.createXULElement("menuitem");
          it.setAttribute("label", m.id);
          it.setAttribute("value", m.id);
          it.setAttribute("description", m.description);
          popup.append(it);
        }
        ml.value = keep;
        out.textContent = "你的 Codex 可用模型：\n" + models.map((m) => "• " + m.id + " — " + m.description).join("\n");
      } catch (e) { out.textContent = "⚠️ " + ((e && e.message) || e); }
    });
    const envOut = document.getElementById("clitrans-env-out");
    let busy = false;
    document.getElementById("clitrans-env-check").addEventListener("command", async () => {
      if (busy) return;
      envOut.textContent = "检测中…";
      try { envOut.textContent = await api.checkEnvironment(); }
      catch (e) { envOut.textContent = "⚠️ " + ((e && e.message) || e); }
    });
    document.getElementById("clitrans-env-setup").addEventListener("command", async () => {
      if (busy) return;
      busy = true;
      const btn = document.getElementById("clitrans-env-setup");
      btn.disabled = true;
      let text = "";
      const log = (s) => {
        text = (text + "\n" + s).slice(-8000);
        envOut.textContent = text.trim();
        envOut.scrollTop = envOut.scrollHeight;
      };
      try {
        await api.setupEnvironment(log);
        log("\n" + await api.checkEnvironment());
      } catch (e) {
        log("\n⚠️ 配置中断：" + ((e && e.message) || e) +
          "\n可以再点一次「一键配置翻译环境」继续（已装好的部分会跳过）。网络慢时勾选「使用国内镜像」。");
      } finally { busy = false; btn.disabled = false; }
    });
    document.getElementById("clitrans-detect").addEventListener("command", () => {
      const s = showSetup();
      out.textContent =
        "Codex：" + (s.codex || "未找到") + "\nClaude Code：" + (s.claude || "未找到") +
        "\nGemini：" + (s.gemini || "未配置（填 API Key 或安装 Gemini CLI）") +
        "\npdf2zh_next：" + (s.pdf2zh || "未找到") + "\n本地接口：" + s.bridge;
    });
  }
  init();
})();
