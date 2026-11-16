/* 智译 CLI Translate — core module.
 * Loaded by bootstrap.js via Services.scriptloader.loadSubScript into a scope
 * object; exposes createCLITrans(env). Everything that touches Zotero / the OS
 * goes through `env`, so the pure logic can be unit-tested outside Zotero.
 */
/* eslint-disable no-unused-vars */
function createCLITrans(env) {
  "use strict";
  const { Zotero } = env;
  const PREF = "clitrans.";
  const LOG = (...a) => {
    try { Zotero.debug("[CLITrans] " + a.map(String).join(" ")); } catch (e) {}
  };

  // ---------------------------------------------------------------- prefs
  function pref(name) { return Zotero.Prefs.get(PREF + name); }
  function setPref(name, v) { return Zotero.Prefs.set(PREF + name, v); }

  function randomToken() {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    let s = "zt-";
    for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }
  function ensureTokens() {
    if (!pref("bridgeToken")) setPref("bridgeToken", randomToken());
  }

  // ------------------------------------------------------------ glossary
  /** "source = target" per line; also accepts tab, "→", "," as separators. */
  function parseGlossary(text) {
    const out = [];
    for (let line of String(text || "").split(/\r?\n/)) {
      line = line.trim();
      if (!line || line.startsWith("#")) continue;
      // explicit separators win; a comma only separates when none of them is present,
      // so "trade credit, bank credit = …" keeps its comma in the source term
      const m = line.match(/^(.+?)\s*(?:=|→|->|\t)\s*(.+)$/) || line.match(/^(.+?)\s*(?:,|，)\s*(.+)$/);
      if (m && m[1].trim() && m[2].trim()) out.push([m[1].trim(), m[2].trim()]);
    }
    return out;
  }
  function glossaryForText(entries, text) {
    if (!text) return entries;
    const low = String(text).toLowerCase();
    return entries.filter(([s]) => low.includes(s.toLowerCase()));
  }
  function csvCell(s) {
    s = String(s);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function glossaryToCSV(entries, tgtLang) {
    const rows = ["source,target,tgt_lng"];
    for (const [s, t] of entries) rows.push([s, t, tgtLang].map(csvCell).join(","));
    return rows.join("\n") + "\n";
  }

  // ------------------------------------------------------------- prompts
  function translatorSystemPrompt(langName, glossary) {
    let p =
      "You are a professional academic translator. Translate the text the user gives you into " +
      langName +
      ". Keep the meaning exact and natural for academic readers; keep numbers, citations, " +
      "variable names and math unchanged. Output ONLY the translation — no explanations, " +
      "no quotation marks, no preface, no notes.";
    if (glossary && glossary.length) {
      p += "\nUse this glossary strictly (source → target):\n" +
        glossary.map(([s, t]) => "- " + s + " → " + t).join("\n");
    }
    return p;
  }
  function cleanSelection(text) {
    // join hyphenated line breaks and single newlines from PDF extraction
    return String(text || "")
      .replace(/-\n(?=[a-z])/g, "")
      .replace(/\s*\n\s*/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  // -------------------------------------------------------------- google
  function parseGoogleResponse(json) {
    if (!Array.isArray(json) || !Array.isArray(json[0])) throw new Error("Google 返回格式无法识别");
    return json[0].map((seg) => (Array.isArray(seg) && typeof seg[0] === "string" ? seg[0] : "")).join("");
  }
  function chunkText(text, max) {
    const chunks = [];
    let rest = String(text);
    while (rest.length > max) {
      let cut = Math.max(rest.lastIndexOf(". ", max), rest.lastIndexOf("。", max), rest.lastIndexOf("\n", max));
      if (cut < max * 0.5) cut = rest.lastIndexOf(" ", max);
      if (cut <= 0) cut = max;
      chunks.push(rest.slice(0, cut + 1));
      rest = rest.slice(cut + 1);
    }
    if (rest) chunks.push(rest);
    return chunks;
  }
  async function translateGoogle(text, tl) {
    const parts = [];
    for (const chunk of chunkText(text, 4000)) {
      const url = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=" +
        encodeURIComponent(tl) + "&dt=t";
      const xhr = await Zotero.HTTP.request("POST", url, {
        body: "q=" + encodeURIComponent(chunk),
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        responseType: "json",
        timeout: 30000,
      });
      let data = xhr.response;
      if (typeof data === "string") data = JSON.parse(data);
      parts.push(parseGoogleResponse(data));
    }
    return parts.join("");
  }

  // --------------------------------------------------------------- gemini
  // Two channels: a Google AI Studio API key (fast, no CLI start-up), or a local Gemini CLI.
  function sleep(ms) { return new Promise((r) => env.setTimeout(r, ms)); }
  function geminiModel() { return (pref("geminiModel") || "gemini-3.5-flash-lite").trim(); }
  function parseGeminiResponse(d) {
    if (typeof d === "string") d = JSON.parse(d);
    const cand = d && Array.isArray(d.candidates) ? d.candidates[0] : null;
    const parts = cand && cand.content && Array.isArray(cand.content.parts) ? cand.content.parts : [];
    const text = parts.map((p) => (p && typeof p.text === "string" ? p.text : "")).join("").trim();
    if (text) return text;
    const why = (cand && cand.finishReason) || (d && d.promptFeedback && d.promptFeedback.blockReason) || "";
    throw new Error("Gemini 没有返回内容" + (why ? "（" + why + "）" : ""));
  }
  let geminiActive = 0;
  async function callGeminiAPI(system, user, images) {
    const key = (pref("geminiApiKey") || "").trim();
    const url = "https://generativelanguage.googleapis.com/v1beta/models/" +
      encodeURIComponent(geminiModel()) + ":generateContent";
    const parts = [];
    for (const img of images || []) parts.push({ inlineData: { mimeType: "image/png", data: await fileBase64(img) } });
    parts.push({ text: user });
    const body = { contents: [{ role: "user", parts }], generationConfig: { temperature: 0.2 } };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    while (geminiActive >= 4) await sleep(50);
    geminiActive++;
    try {
      let lastErr;
      for (let attempt = 0; attempt < 4; attempt++) {
        let x;
        try {
          x = await Zotero.HTTP.request("POST", url, {
            body: JSON.stringify(body),
            headers: { "Content-Type": "application/json", "x-goog-api-key": key },
            responseType: "json", timeout: 120000,
          });
        } catch (e) {
          lastErr = e;
          const status = e && e.status;
          if (status === 429 || status >= 500) { await sleep(1500 * 2 ** attempt); continue; }
          let detail = "";
          try { const r = e.xmlhttp && e.xmlhttp.response; detail = (r && r.error && r.error.message) || ""; } catch (e2) {}
          throw new Error("Gemini 调用失败" + (status ? "（" + status + "）" : "") + "：" +
            (detail || (e && e.message) || e).toString().slice(0, 300));
        }
        return parseGeminiResponse(x.response);
      }
      throw new Error("Gemini 暂时不可用（限流或服务端错误）：" + ((lastErr && (lastErr.status || lastErr.message)) || lastErr));
    } finally { geminiActive--; }
  }
  function buildGeminiArgs(dropped) {
    const a = [];
    const model = geminiModel();
    if (model) a.push("-m", model);
    if (!dropped.has("-o")) a.push("-o", "text");
    // -p forces non-interactive mode; its text is appended to what we pipe on stdin
    a.push("-p", "Follow the instructions above exactly and output only the result.");
    return a;
  }
  async function callGeminiCLI(system, user) {
    const bin = resolveTool("gemini");
    if (!bin) throw new Error("Gemini 未配置：请登录 Antigravity（自带 agy 命令行），或在设置里填写 Gemini API Key");
    return withCliSlot(async () => {
      const stdin = (system ? system + "\n\n----- INPUT -----\n" : "") + user + "\n";
      const r = await runWithFlagFallback(
        bin, (d) => buildGeminiArgs(d), ["-o"],
        { stdin, workdir: tmpDir(), timeoutMs: (Number(pref("cliTimeoutSec")) || 180) * 1000 },
      );
      if (r.exitCode !== 0) throw new Error("Gemini CLI 调用失败：" + errText(r));
      return r.stdout.trim();
    });
  }
  // Antigravity CLI ("agy"): Google's CLI for personal accounts (Gemini CLI's free tier moved there).
  function agyModel() { return (pref("agyModel") || "gemini-3.8-flash-low").trim(); }
  function buildAgyArgs(prompt) {
    const a = ["-p=" + prompt, "--disable-slash-commands", "--sandbox", "--output-format", "text"];
    const model = agyModel();
    if (model) a.push("--model", model);
    const t = Number(pref("cliTimeoutSec")) || 180;
    a.push("--print-timeout", t + "s");
    return a;
  }
  async function callAgy(system, user, images) {
    const bin = resolveTool("agy");
    if (!bin) throw new Error("找不到 Antigravity CLI（agy）");
    return withCliSlot(async () => {
      let pics = "";
      const dirs = new Set();
      if (images && images.length) {
        // agy's print mode takes no inline images: its agent opens the PNG files itself
        pics = "\n\nThe images, in order (open EVERY one with your file viewing tool before answering; " +
          "do not guess from the extracted text):\n" + images.map((p, i) => "[" + (i + 1) + "] " + p).join("\n");
        for (const p of images) dirs.add(String(p).replace(/\/[^/]*$/, ""));
      }
      const prompt = (system ? system + pics + "\n\n----- INPUT -----\n" : pics) + user;
      const args = buildAgyArgs(prompt);
      for (const d of dirs) args.push("--add-dir", d);
      const r = await runProcess(bin, args, {
        workdir: tmpDir(), timeoutMs: ((Number(pref("cliTimeoutSec")) || 180) + 15) * 1000,
      });
      const out = String(r.stdout || "").trim();
      if (r.exitCode !== 0 || !out) throw new Error("Gemini（agy）调用失败：" + errText(r));
      return out;
    });
  }
  /** Which Gemini channel is in use: API key > Antigravity CLI > Gemini CLI. */
  function geminiChannel() {
    if ((pref("geminiApiKey") || "").trim()) return "api";
    if (resolveTool("agy")) return "agy";
    if (resolveTool("gemini")) return "cli";
    return null;
  }
  function callGemini(system, user, images) {
    const ch = geminiChannel();
    if (ch === "api") return callGeminiAPI(system, user, images);
    if (ch === "agy") return callAgy(system, user, images);
    if (images && images.length) throw new Error("Gemini CLI 渠道不支持看图，请改用 Antigravity（agy）或 API Key");
    return callGeminiCLI(system, user);
  }
  /** PNG bytes → base64 (for Claude / Gemini image input). */
  async function fileBase64(path) {
    const bytes = await IOUtils.read(path);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    const b64 = typeof btoa === "function" ? btoa : Zotero.getMainWindow().btoa.bind(Zotero.getMainWindow());
    return b64(bin);
  }

  // --------------------------------------------------------- subprocess
  function homeDir() {
    try { return env.Services.dirsvc.get("Home", Components.interfaces.nsIFile).path; } catch (e) { return ""; }
  }
  function joinPath(...p) {
    try { if (typeof PathUtils !== "undefined") return PathUtils.join(...p); } catch (e) {}
    return p.join("/").replace(/\/+/g, "/");
  }
  function fileExists(p) {
    try { return !!p && Zotero.File.pathToFile(p).exists(); } catch (e) { return false; }
  }
  function searchPATH() {
    const h = homeDir();
    return [
      "/opt/homebrew/bin", "/usr/local/bin", h + "/.local/bin", h + "/.npm-global/bin",
      h + "/.bun/bin", h + "/.volta/bin", h + "/.cargo/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin",
    ].join(":");
  }
  const CANDIDATES = {
    codex: () => [
      "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
      "/Applications/Codex.app/Contents/Resources/codex",
      "/opt/homebrew/bin/codex", "/usr/local/bin/codex", homeDir() + "/.local/bin/codex",
      homeDir() + "/.npm-global/bin/codex",
    ],
    claude: () => [
      "/opt/homebrew/bin/claude", "/usr/local/bin/claude", homeDir() + "/.local/bin/claude",
      homeDir() + "/.claude/local/claude", homeDir() + "/.npm-global/bin/claude",
    ],
    agy: () => [
      homeDir() + "/.local/bin/agy", "/opt/homebrew/bin/agy", "/usr/local/bin/agy", homeDir() + "/.antigravity/bin/agy",
    ],
    gemini: () => [
      "/opt/homebrew/bin/gemini", "/usr/local/bin/gemini", homeDir() + "/.local/bin/gemini",
      homeDir() + "/.npm-global/bin/gemini", homeDir() + "/.bun/bin/gemini",
    ],
    pdf2zh: () => [
      homeDir() + "/.local/bin/pdf2zh_next", "/opt/homebrew/bin/pdf2zh_next", "/usr/local/bin/pdf2zh_next",
      homeDir() + "/.local/bin/pdf2zh",
    ],
  };
  function resolveTool(kind) {
    const prefName = { codex: "codexPath", claude: "claudePath", gemini: "geminiPath", agy: "agyPath", pdf2zh: "pdf2zhPath" }[kind];
    const configured = (pref(prefName) || "").trim();
    if (configured) return fileExists(configured) ? configured : null;
    for (const c of CANDIDATES[kind]()) if (fileExists(c)) return c;
    return null;
  }

  async function runProcess(command, args, opts = {}) {
    const { Subprocess, setTimeout, clearTimeout } = env;
    const proc = await Subprocess.call({
      command,
      arguments: args,
      environment: Object.assign({ PATH: searchPATH(), NO_COLOR: "1" }, opts.env || {}),
      environmentAppend: true,
      workdir: opts.workdir || undefined,
      stderr: "pipe",
    });
    if (opts.onStart) opts.onStart(proc);
    // the CLI may exit early (e.g. rejecting a flag) before reading stdin
    try { if (opts.stdin != null) await proc.stdin.write(opts.stdin); } catch (e) { LOG("stdin write failed", e); }
    try { await proc.stdin.close(); } catch (e) {}
    let stdout = "", stderr = "", killed = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => { killed = true; try { proc.kill(); } catch (e) {} }, opts.timeoutMs)
      : null;
    const pump = async (pipe, sink) => {
      let s;
      while ((s = await pipe.readString())) sink(s);
    };
    await Promise.all([
      pump(proc.stdout, (s) => { stdout += s; if (opts.onOutput) opts.onOutput(s); }),
      pump(proc.stderr, (s) => { stderr += s; if (opts.onOutput) opts.onOutput(s); }),
    ]);
    const { exitCode } = await proc.wait();
    if (timer) clearTimeout(timer);
    return { exitCode, stdout, stderr, killed };
  }

  /** Run a CLI; if it rejects an optional flag (older version), drop it and retry. */
  async function runWithFlagFallback(command, buildArgs, optionalFlags, opts) {
    let dropped = new Set();
    for (let attempt = 0; attempt < 30; attempt++) {
      const args = buildArgs(dropped);
      const r = await runProcess(command, args, opts);
      if (r.exitCode === 0) return r;
      const text = r.stderr + "\n" + r.stdout;
      const fm = text.match(/Unknown feature flag:\s*([\w-]+)/i);
      if (fm && !dropped.has("feature:" + fm[1])) { dropped.add("feature:" + fm[1]); continue; }
      const m = text.match(/(?:unexpected argument|unknown option)\s+'([^']+)'/i);
      const bad = m && optionalFlags.find((f) => m[1] === f || m[1].startsWith(f));
      if (bad && !dropped.has(bad)) { LOG("drop unsupported flag", bad); dropped.add(bad); continue; }
      return r;
    }
    throw new Error("CLI 参数重试次数过多");
  }

  // simple semaphore so we never run too many CLI agents at once
  let active = 0;
  const waiters = [];
  async function withCliSlot(fn) {
    const max = Math.max(1, Number(pref("maxParallelCli")) || 2);
    if (active >= max) await new Promise((r) => waiters.push(r));
    active++;
    try { return await fn(); } finally {
      active--;
      const next = waiters.shift();
      if (next) next();
    }
  }

  function tmpDir() { return Zotero.getTempDirectory().path; }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function errText(r) {
    const t = (r.stderr || r.stdout || "").trim().split("\n").filter(Boolean).slice(-6).join("\n");
    return (r.killed ? "超时被终止。" : "退出码 " + r.exitCode + "。") + (t ? "\n" + t : "");
  }

  // Features that only add tool/skill/agent definitions to every request; translation needs none.
  const CODEX_DISABLE = [
    "multi_agent", "apps", "browser_use", "computer_use", "code_mode_host", "plugins", "skill_search",
    "shell_tool", "unified_exec", "image_generation", "view_image", "goals", "tool_suggest",
    "in_app_browser", "sleep_tool", "mentions_v2", "worktrees", "hooks",
  ];
  function buildCodexArgs(outFile, workdir, dropped, instructionsFile, modelOverride, images) {
    const a = ["exec"];
    for (const img of images || []) a.push("-i", img); // before any other flag: -i takes several values
    a.push("--skip-git-repo-check", "--sandbox", "read-only", "-C", workdir, "-o", outFile);
    const opt = (flag, ...rest) => { if (!dropped.has(flag)) a.push(flag, ...rest); };
    opt("--ephemeral");
    opt("--color", "never");
    if (pref("codexLite")) opt("--ignore-user-config");
    for (const f of CODEX_DISABLE) if (!dropped.has("feature:" + f)) a.push("--disable", f);
    if (instructionsFile) a.push("-c", "model_instructions_file=" + JSON.stringify(instructionsFile));
    const model = (modelOverride || pref("codexModel") || "").trim();
    if (model) a.push("-m", model);
    const effort = (pref("codexEffort") || "").trim();
    if (effort) a.push("-c", 'model_reasoning_effort="' + effort + '"');
    a.push("-");
    return a;
  }
  async function callCodex(system, user, images) {
    const codex = resolveTool("codex");
    if (!codex) throw new Error("找不到 Codex CLI，请在设置中填写路径");
    return withCliSlot(async () => {
      const work = tmpDir();
      const id = uid();
      const outFile = joinPath(work, "clitrans-codex-" + id + ".txt");
      const insFile = joinPath(work, "clitrans-codex-" + id + ".md");
      await Zotero.File.putContentsAsync(insFile, system || "You are a helpful assistant.");
      let r;
      try {
        r = await runWithFlagFallback(
          codex, (d) => buildCodexArgs(outFile, work, d, insFile, null, images),
          ["--ephemeral", "--color", "--ignore-user-config"],
          { stdin: user, workdir: work, timeoutMs: (Number(pref("cliTimeoutSec")) || 180) * 1000 },
        );
      } finally { try { await IOUtils.remove(insFile); } catch (e) {} }
      let text = "";
      try { text = await Zotero.File.getContentsAsync(outFile); } catch (e) {}
      try { await IOUtils.remove(outFile); } catch (e) {}
      if (r.exitCode !== 0 && !text.trim()) throw new Error("Codex 调用失败：" + errText(r));
      return String(text || r.stdout).trim();
    });
  }
  /** Models the user's Codex account can use, from `codex debug models`. */
  async function listCodexModels() {
    const codex = resolveTool("codex");
    if (!codex) throw new Error("找不到 Codex CLI");
    const r = await runProcess(codex, ["debug", "models"], { workdir: tmpDir(), timeoutMs: 60000 });
    const d = JSON.parse(r.stdout);
    return (d.models || []).filter((m) => m.visibility !== "hide")
      .map((m) => ({ id: m.slug, name: m.display_name || m.slug, description: m.description || "" }));
  }

  function buildClaudeArgs(system, dropped) {
    const a = ["-p", "--output-format", "text"];
    const opt = (flag, ...rest) => { if (!dropped.has(flag)) a.push(flag, ...rest); };
    opt("--tools", "");
    opt("--no-session-persistence");
    opt("--strict-mcp-config");
    opt("--setting-sources", "project");
    opt("--disable-slash-commands");
    if (system) a.push("--system-prompt", system);
    const model = (pref("claudeModel") || "").trim();
    if (model) a.push("--model", model);
    return a;
  }
  async function callClaude(system, user) {
    const claude = resolveTool("claude");
    if (!claude) throw new Error("找不到 Claude Code CLI，请在设置中填写路径");
    return withCliSlot(async () => {
      const r = await runWithFlagFallback(
        claude, (d) => buildClaudeArgs(system, d),
        ["--tools", "--no-session-persistence", "--strict-mcp-config", "--setting-sources", "--disable-slash-commands"],
        { stdin: user, workdir: tmpDir(), timeoutMs: (Number(pref("cliTimeoutSec")) || 180) * 1000 },
      );
      if (r.exitCode !== 0) throw new Error("Claude Code 调用失败：" + errText(r));
      return r.stdout.trim();
    });
  }

  async function callClaudeVision(system, user, images) {
    const claude = resolveTool("claude");
    if (!claude) throw new Error("找不到 Claude Code CLI，请在设置中填写路径");
    const content = [];
    for (const img of images) content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: await fileBase64(img) } });
    content.push({ type: "text", text: user });
    const stdin = JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n";
    return withCliSlot(async () => {
      const r = await runWithFlagFallback(
        claude, (d) => {
          const a = buildClaudeArgs(system, d);
          a.splice(a.indexOf("--output-format"), 2, "--input-format", "stream-json", "--output-format", "stream-json", "--verbose");
          return a;
        },
        ["--tools", "--no-session-persistence", "--strict-mcp-config", "--setting-sources", "--disable-slash-commands"],
        { stdin, workdir: tmpDir(), timeoutMs: (Number(pref("cliTimeoutSec")) || 180) * 1000 },
      );
      let res = null;
      for (const line of String(r.stdout || "").split("\n")) {
        try { const d = JSON.parse(line); if (d && d.type === "result") res = d; } catch (e) {}
      }
      if (!res || res.is_error || !res.result) throw new Error("Claude Code 看图调用失败：" + ((res && res.result) || errText(r)));
      return String(res.result).trim();
    });
  }
  /** Engines that can read a picture (formulas, figures). */
  function visionCapable(engine) {
    if (engine === "codex" || engine === "claude") return true;
    if (engine === "gemini") { const ch = geminiChannel(); return ch === "api" || ch === "agy"; }
    return false;
  }
  function callVision(engine, system, user, images) {
    if (engine === "claude") return callClaudeVision(system, user, images);
    if (engine === "gemini") return callGemini(system, user, images);
    return callCodex(system, user, images);
  }

  const ENGINES = {
    google: { label: "Google", free: true, llm: false },
    codex: { label: "GPT", free: false, llm: true, cli: true },
    claude: { label: "Claude", free: false, llm: true, cli: true },
    gemini: { label: "Gemini", free: false, llm: true },
  };
  function engineLabel(engine) {
    const e = ENGINES[engine];
    if (!e) return engine;
    if (engine === "codex") return e.label + "（" + (pref("codexModel") || "默认") + "）";
    if (engine === "claude") return e.label + "（" + (pref("claudeModel") || "默认") + "）";
    if (engine === "gemini") return e.label + "（" + (geminiChannel() === "agy" ? agyModel() : geminiModel()) + "）";
    return e.label;
  }
  /** Engines removed in 0.3.0 (microsoft, siliconflow) may still be stored in prefs. */
  function defaultEngine() {
    const e = pref("defaultEngine");
    return ENGINES[e] ? e : "google";
  }
  async function callLLM(engine, system, user) {
    if (engine === "codex") return callCodex(system, user);
    if (engine === "claude") return callClaude(system, user);
    if (engine === "gemini") return callGemini(system, user);
    throw new Error("未知引擎：" + engine);
  }

  async function translate(text, engine, { raw } = {}) {
    text = raw ? String(text || "") : cleanSelection(text);
    if (!text.trim()) return text;
    engine = engine || defaultEngine();
    const tl = pref("targetLang") || "zh-CN";
    if (engine === "google") return translateGoogle(text, tl);
    if (!ENGINES[engine]) throw new Error("未知引擎：" + engine);
    const gl = glossaryForText(parseGlossary(pref("glossary")), text);
    return callLLM(engine, translatorSystemPrompt(pref("targetLangName") || "简体中文", gl), text);
  }

  // ------------------------------------------- batched LLM translation (whole documents)
  function batchSystemPrompt(langName, glossary) {
    return translatorSystemPrompt(langName, glossary) +
      "\n\nThe input is a JSON object mapping ids to text segments from one academic paper. " +
      "Translate every segment independently and return ONLY a JSON object with exactly the same ids " +
      "mapping to the translations — no code fences, no comments. Copy placeholders and markup such as " +
      "{v1}, {{1}}, <b>…</b>, <style id='1'>…</style> unchanged: each one of a segment must appear in its " +
      "translation exactly once, at the place the formula or styled word belongs. " +
      "If a segment needs no translation (formula, code, name, reference), return it unchanged.";
  }
  function parseBatchResult(text) {
    let t = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    const a = t.indexOf("{"), b = t.lastIndexOf("}");
    if (a < 0 || b <= a) throw new Error("模型没有返回 JSON");
    const obj = JSON.parse(t.slice(a, b + 1));
    const out = {};
    for (const [k, v] of Object.entries(obj)) if (typeof v === "string") out[String(k)] = v;
    return out;
  }
  const BATCH_LIMITS = {
    codex: { items: 40, chars: 9000 },
    claude: { items: 40, chars: 9000 },
    gemini: { items: 40, chars: 9000 },
  };
  const queues = {};
  function enqueueBatch(engine, text) {
    const q = queues[engine] || (queues[engine] = { items: [], chars: 0, timer: null });
    return new Promise((resolve, reject) => {
      q.items.push({ text, resolve, reject });
      q.chars += text.length;
      const lim = BATCH_LIMITS[engine];
      if (q.items.length >= lim.items || q.chars >= lim.chars) flushBatch(engine);
      else if (!q.timer) q.timer = env.setTimeout(() => flushBatch(engine), 600);
    });
  }
  function flushBatch(engine) {
    const q = queues[engine];
    if (!q) return;
    if (q.timer) { env.clearTimeout(q.timer); q.timer = null; }
    const items = q.items.splice(0);
    q.chars = 0;
    if (items.length) runBatch(engine, items).catch((e) => LOG("batch error", e));
  }
  async function runBatch(engine, items, depth = 0) {
    const langName = pref("targetLangName") || "简体中文";
    const all = items.map((i) => i.text).join("\n");
    const sys = batchSystemPrompt(langName, glossaryForText(parseGlossary(pref("glossary")), all));
    const input = {};
    items.forEach((it, i) => (input[String(i + 1)] = it.text));
    let result = {};
    try {
      result = parseBatchResult(await callLLM(engine, sys, JSON.stringify(input, null, 1)));
    } catch (e) {
      if (items.length > 1 && depth < 2) {
        const mid = Math.ceil(items.length / 2);
        await Promise.all([runBatch(engine, items.slice(0, mid), depth + 1), runBatch(engine, items.slice(mid), depth + 1)]);
        return;
      }
      items.forEach((it) => it.reject(e));
      return;
    }
    const missing = [];
    items.forEach((it, i) => {
      const v = result[String(i + 1)];
      if (typeof v === "string" && v.trim()) it.resolve(v);
      else missing.push(it);
    });
    if (missing.length) {
      if (depth < 2) await runBatch(engine, missing, depth + 1);
      else missing.forEach((it) => it.resolve(it.text));
    }
  }
  // ---------------------------------------- segment guards (whole-document translation)
  // pdf2zh_next keeps a paragraph's original typesetting when the "translation" equals the source.
  // So for segments that cannot survive translation (formula-heavy proofs, merged reference lists,
  // broken fragments, or output whose placeholders got damaged) we hand the source text back.
  const PH_RE = /\{\s*v\s*\d+\s*\}|<\s*style\s+id\s*=\s*'\s*\d+\s*'\s*>|<\s*\/\s*style\s*>/g;
  const NON_LATIN_RE = /[Ѐ-ӿ぀-ヿ㐀-鿿가-힯]/;
  function normalizePlaceholders(t) {
    return String(t == null ? "" : t)
      .replace(/[｛{]\s*[vV]\s*(\d+)\s*[｝}]/g, "{v$1}")
      .replace(/<\s*style\s+id\s*=\s*["'‘’“”]\s*(\d+)\s*["'‘’“”]\s*>/gi, "<style id='$1'>")
      .replace(/<\s*\/\s*style\s*>/gi, "</style>");
  }
  function placeholderList(text) {
    return (String(text).match(PH_RE) || []).map((p) => p.replace(/\s+/g, "")).sort();
  }
  function placeholdersIntact(src, out) {
    const a = placeholderList(src), b = placeholderList(out);
    return a.length === b.length && a.every((p, i) => p === b[i]);
  }
  function proseWords(text) {
    return String(text).replace(PH_RE, " ").match(/[A-Za-z]{3,}/g) || [];
  }
  /** A proof or derivation: more formulas than words, or sub/superscripts that the PDF parser split off
   *  as loose letters right after a formula ("{v5}t , {v6}b"). Re-typesetting such a paragraph scrambles
   *  the math, so it is better left exactly as printed. */
  function isFormulaDense(text) {
    if (NON_LATIN_RE.test(text)) return false;
    const t = String(text);
    const n = (t.match(/\{\s*v\s*\d+\s*\}/g) || []).length;
    if (n >= 6 && proseWords(t).length < n) return true;
    return (t.match(/\{\s*v\s*\d+\s*\}[b-z] /g) || []).length >= 2;
  }
  /** One bibliography entry, or several merged into one block by the layout parser. */
  function isReferenceLike(text) {
    const t = String(text).trim();
    const years = (t.match(/\((?:19|20)\d{2}[a-z]?\)/g) || []).length +
      (t.match(/,\s*(?:19|20)\d{2}[a-z]?\./g) || []).length;
    const vols = (t.match(/\b\d+\s*\(\d+(?:[\/–-]\d+)?\)\s*[,:]\s*\d+/g) || []).length;
    const marks = (t.match(/\b(?:Working paper|Ph\.D\. thesis|eds?\.|doi\.org|https?:\/\/)/gi) || []).length;
    if (years >= 3 && vols >= 2) return true;
    const startsLikeEntry = /^(?:\[\d+\]\s*)?[A-Z][A-Za-z'’\-]+,?\s+(?:[A-Z]{1,3}\b|[A-Z]\.)/.test(t);
    return startsLikeEntry && t.length < 700 && years >= 1 && (vols >= 1 || marks >= 1);
  }
  /** A stray piece of a line ("ycara", "{v1}S", "(C.1)") — nothing meaningful to translate. */
  function isFragment(text) {
    const t = String(text).replace(PH_RE, "").trim();
    if (NON_LATIN_RE.test(t) || t.length >= 30) return false;
    if (!/[A-Za-z]/.test(t)) return true;                 // "(C.1)", "37(4)"
    if (/^[a-z][^\s]{0,6}$/.test(t)) return true;         // "etail.", "ycara": the tail of a split word
    return !/[A-Za-z]{4,}/.test(t);                       // "{v1}S", "K (2009) Sh"
  }
  /** U+FFFD / private-use glyphs: the PDF has no Unicode mapping for them (often math minus/relations).
   *  Re-typesetting such a paragraph prints "�", so the in-place layouts keep it as printed. */
  const GARBLED_RE = /[\uFFFD\uE000-\uF8FF]/;
  function segmentGuard(text) {
    if (GARBLED_RE.test(String(text).replace(PH_RE, ""))) return "garbled";
    if (isFragment(text)) return "fragment";
    if (pref("skipReferences") !== false && isReferenceLike(text)) return "refs";
    if (pref("keepFormulaDense") !== false && isFormulaDense(text)) return "formula";
    return null;
  }
  function strictPlaceholderPrompt(langName, glossary) {
    return translatorSystemPrompt(langName, glossary) +
      "\nThe text contains placeholders: {v1}, {v2}… stand for formulas and <style id='1'>…</style> wraps " +
      "formatted words. Every placeholder of the input must appear in your output exactly once and " +
      "unchanged — never add, drop, renumber, merge or translate one. Put each where the formula belongs " +
      "in the translated sentence.";
  }

  const docStats = { total: 0, formula: 0, refs: 0, fragment: 0, broken: 0, garbled: 0 };
  function resetDocStats() { for (const k of Object.keys(docStats)) docStats[k] = 0; }
  function keptSummary() {
    const kept = docStats.formula + docStats.refs + docStats.fragment + docStats.broken + docStats.garbled;
    if (!kept) return "";
    const parts = [];
    if (docStats.formula) parts.push("公式密集 " + docStats.formula);
    if (docStats.refs) parts.push("参考文献 " + docStats.refs);
    if (docStats.broken) parts.push("占位符损坏 " + docStats.broken);
    if (docStats.garbled) parts.push("含无法识别字符 " + docStats.garbled);
    if (docStats.fragment) parts.push("碎片 " + docStats.fragment);
    return "保留原文 " + kept + " 段（" + parts.join("、") + "）";
  }

  const freeLimits = { google: 6 };
  const freeActive = {};
  async function translateSegmentRaw(text, engine) {
    if (engine === "google") {
      const max = freeLimits[engine];
      while ((freeActive[engine] || 0) >= max) await sleep(50);
      freeActive[engine] = (freeActive[engine] || 0) + 1;
      try {
        for (let attempt = 0; ; attempt++) {
          try { return await translate(text, engine, { raw: true }); }
          catch (e) {
            if (attempt >= 2) throw e;
            await sleep(1000 * 2 ** attempt);
          }
        }
      } finally { freeActive[engine]--; }
    }
    if (!BATCH_LIMITS[engine]) throw new Error("未知引擎：" + engine);
    return enqueueBatch(engine, text);
  }
  // ------------------------- vision: paragraph images → translation with LaTeX formulas (GPT / Claude / Gemini)
  // Rebuilding fractions and scripts from PDF glyph positions is guesswork; a multimodal model reads
  // the formula from the picture of the paragraph and writes it as LaTeX, which interleave.py typesets.
  function visionPrompt(langName, glossary) {
    let p =
      "You are a professional academic translator. You are given images of paragraphs from one academic " +
      "paper, labelled [1], [2], … in the order the images are attached. Translate each paragraph into " +
      langName + ". Rules:\n" +
      "- Write EVERY mathematical expression (variables, sub/superscripts, fractions, equations, sets) in LaTeX " +
      "inside $...$, exactly as printed in the image, e.g. $V_i^{FG}=\\frac{\\beta_i}{16}\\left(\\alpha-\\frac{c}{\\beta_i}\\right)^2$. " +
      "A displayed equation on its own line goes inside $$...$$.\n" +
      "- Use only standard math LaTeX (\\frac, ^, _, \\left( \\right), Greek letters, \\max, \\arg\\max, \\overset, \\mathbb, \\mathrm). No \\begin environments.\n" +
      "- Keep citations, numbers and labels such as (i), (ii), Lemma 2 unchanged. Translate only what is in the image.\n" +
      "- Plain text only: no Markdown (no *, **, #, bullet lists), no notes or explanations.\n" +
      "- Output format, nothing else: for each paragraph a line \"@@@ N\" (N = its label number) followed by its translation.";
    if (glossary && glossary.length) {
      p += "\nUse this glossary strictly (source → target):\n" + glossary.map(([a, b]) => "- " + a + " → " + b).join("\n");
    }
    return p;
  }
  function figurePrompt(langName, glossary) {
    let p =
      "You are given the image of a figure from an academic paper. List every distinct piece of text in it " +
      "that a reader needs: panel titles, axis titles, legend entries, labels and annotations. Skip pure numbers " +
      "(axis ticks) and list text that repeats only once. For each, output exactly one line:\n" +
      "<text as printed> => <translation into " + langName + ">\n" +
      "Write every mathematical symbol or expression in LaTeX inside $...$ on BOTH sides, exactly as printed " +
      "(e.g. $K/\\alpha_t$, $\\Gamma_b^*$, $d_t^*$). Output nothing else.";
    if (glossary && glossary.length) {
      p += "\nUse this glossary strictly (source → target):\n" + glossary.map(([a, b]) => "- " + a + " → " + b).join("\n");
    }
    return p;
  }
  function parseVisionResult(text) {
    const out = {};
    const parts = String(text || "").split(/^\s*@@@\s*(\d+)\s*$/m);
    for (let i = 1; i + 1 < parts.length; i += 2) {
      const v = parts[i + 1].trim();
      if (v) out[parts[i]] = v;
    }
    return out;
  }
  const visionQueues = {};  // engine -> { items, timer }
  function enqueueVision(image, text, engine) {
    engine = engine || "codex";
    const q = visionQueues[engine] || (visionQueues[engine] = { items: [], timer: null });
    return new Promise((resolve, reject) => {
      q.items.push({ image, text, resolve, reject });
      if (q.items.length >= 4) flushVision(engine);
      else if (!q.timer) q.timer = env.setTimeout(() => flushVision(engine), 800);
    });
  }
  function flushVision(engine) {
    const q = visionQueues[engine];
    if (!q) return;
    if (q.timer) { env.clearTimeout(q.timer); q.timer = null; }
    const items = q.items.splice(0);
    if (items.length) runVisionBatch(items, 0, engine).catch((e) => LOG("vision batch error", e));
  }
  async function runVisionBatch(items, depth = 0, engine = "codex") {
    const all = items.map((i) => i.text).join("\n");
    const sys = visionPrompt(pref("targetLangName") || "简体中文", glossaryForText(parseGlossary(pref("glossary")), all));
    const user = items.map((it, i) => "[" + (i + 1) + "] (text extracted from the PDF, formulas may be garbled — trust the image): " +
      String(it.text || "").slice(0, 3000)).join("\n\n");
    let result;
    try {
      result = parseVisionResult(await callVision(engine, sys, user, items.map((i) => i.image)));
    } catch (e) {
      if (items.length > 1 && depth < 1) {
        await Promise.all(items.map((it) => runVisionBatch([it], depth + 1, engine)));
        return;
      }
      items.forEach((it) => it.reject(e));
      return;
    }
    const missing = [];
    items.forEach((it, i) => {
      const v = result[String(i + 1)];
      if (v) it.resolve(v);
      else missing.push(it);
    });
    if (missing.length && depth < 1) await Promise.all(missing.map((it) => runVisionBatch([it], depth + 1, engine)));
    else missing.forEach((it) => it.reject(new Error("模型没有返回这一段")));
  }

  /** Translation entry point used by pdf2zh_next and the 逐段对照 builder (one segment per HTTP request).
   *  mode "interleave": the original stays visible above the translation, so formula-heavy text is
   *  translated too and a translation with imperfect placeholders is still better than none. */
  async function translateSegment(text, engine, mode) {
    if (!text || !text.trim()) return text;
    const inter = mode === "interleave";
    if (!inter) docStats.total++;
    const why = inter
      ? (isFragment(text) ? "fragment" : pref("skipReferences") !== false && isReferenceLike(text) ? "refs" : null)
      : segmentGuard(text);
    if (why) { if (!inter) docStats[why]++; return text; }
    let out = normalizePlaceholders(await translateSegmentRaw(text, engine));
    if (placeholdersIntact(text, out)) return out;
    if (ENGINES[engine] && ENGINES[engine].llm) {
      try {
        const gl = glossaryForText(parseGlossary(pref("glossary")), text);
        out = normalizePlaceholders(await callLLM(engine, strictPlaceholderPrompt(pref("targetLangName") || "简体中文", gl), text));
        if (placeholdersIntact(text, out)) return out;
      } catch (e) { LOG("placeholder retry failed", e); }
    }
    if (inter) return out;
    docStats.broken++;
    return text;
  }

  // ---------------------------------------------------------------- notes
  function escapeHTML(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }
  function noteBlockHTML({ source, translation, engineLabel, pageLabel }) {
    const meta = [engineLabel, pageLabel ? "p. " + pageLabel : ""].filter(Boolean).join(" · ");
    return "<blockquote><p>" + escapeHTML(source) + "</p></blockquote>" +
      "<p>" + escapeHTML(translation).replace(/\n/g, "<br/>") + "</p>" +
      (meta ? '<p><span style="color:#888">— ' + escapeHTML(meta) + "</span></p>" : "") + "<hr/>";
  }
  async function saveToNote({ attachmentID, source, translation, engine, pageLabel }) {
    const att = Zotero.Items.get(attachmentID);
    const parent = att && att.parentItem;
    const title = pref("noteTitle") || "划词翻译笔记";
    const block = noteBlockHTML({ source, translation, engineLabel: engineLabel(engine), pageLabel });
    let note = null;
    if (parent) {
      for (const id of parent.getNotes()) {
        const n = Zotero.Items.get(id);
        if (n && n.getNoteTitle() === title) { note = n; break; }
      }
    }
    if (note) {
      const html = note.getNote();
      const merged = html.includes("</div>")
        ? html.replace(/<\/div>\s*$/, block + "</div>")
        : html + block;
      note.setNote(merged);
    } else {
      note = new Zotero.Item("note");
      note.libraryID = att ? att.libraryID : Zotero.Libraries.userLibraryID;
      if (parent) note.parentID = parent.id;
      note.setNote('<div data-schema-version="9"><h1>' + escapeHTML(title) + "</h1>" + block + "</div>");
    }
    await note.saveTx();
    return note;
  }

  // ------------------------------------------------- translate panel (shared UI)
  function mkButton(doc, label, onClick) {
    const b = doc.createElement("button");
    b.textContent = label;
    b.style.cssText =
      "font-size:12px;padding:2px 8px;border-radius:5px;border:1px solid rgba(128,128,128,.45);" +
      "background:transparent;color:inherit;cursor:pointer;";
    b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); onClick(b); });
    b.addEventListener("mousedown", (e) => e.stopPropagation());
    return b;
  }
  /** Engine buttons + result + copy / save-to-note. Used by the selection popup and the paragraph box. */
  function buildTranslatePanel(doc, { source, attachmentID, pageLabel, engine, auto, extraButtons }) {
    const root = doc.createElement("div");
    root.style.cssText = "font-size:13px;line-height:1.5;color:inherit;";
    const bar = doc.createElement("div");
    bar.style.cssText = "display:flex;gap:4px;flex-wrap:wrap;align-items:center;margin-bottom:4px;";
    const result = doc.createElement("div");
    result.style.cssText =
      "max-height:260px;overflow:auto;white-space:pre-wrap;word-break:break-word;user-select:text;" +
      "min-height:1.5em;";
    const status = doc.createElement("div");
    status.style.cssText = "font-size:11px;opacity:.65;margin-top:3px;";
    const actions = doc.createElement("div");
    actions.style.cssText = "display:flex;gap:4px;margin-top:4px;";

    let current = { engine: null, text: "" };
    let runSeq = 0; // only the latest click may update the panel
    const engineBtns = {};
    const run = async (eng) => {
      const seq = ++runSeq;
      for (const [k, b] of Object.entries(engineBtns)) b.style.fontWeight = k === eng ? "700" : "400";
      result.textContent = "";
      status.textContent = engineLabel(eng) + " 翻译中…" + (ENGINES[eng].cli ? "（CLI 启动需几秒）" : "");
      const t0 = Date.now();
      try {
        const text = await translate(source, eng);
        if (seq !== runSeq) return;
        const clean = String(text).replace(/<\/?(?:sup|sub|b|i|em|strong|span|p|br)\b[^>]*>/gi, "");
        current = { engine: eng, text: clean };
        result.textContent = clean;
        status.textContent = engineLabel(eng) + " · " + ((Date.now() - t0) / 1000).toFixed(1) + "s";
      } catch (e) {
        if (seq !== runSeq) { LOG(e); return; }
        status.textContent = "";
        result.textContent = "⚠️ " + (e && e.message ? e.message : e);
        LOG(e);
      }
    };

    for (const k of Object.keys(ENGINES)) {
      engineBtns[k] = mkButton(doc, ENGINES[k].label, () => run(k));
      bar.appendChild(engineBtns[k]);
    }
    actions.appendChild(mkButton(doc, "复制", (b) => {
      if (!current.text) return;
      try { Zotero.Utilities.Internal.copyTextToClipboard(current.text); b.textContent = "已复制"; } catch (e) {}
    }));
    actions.appendChild(mkButton(doc, "存入笔记", async (b) => {
      if (!current.text) return;
      try {
        await saveToNote({ attachmentID, source: cleanSelection(source), translation: current.text, engine: current.engine, pageLabel });
        b.textContent = "已存入 ✓";
      } catch (e) { b.textContent = "失败"; LOG(e); }
    }));
    for (const [label, fn] of extraButtons || []) actions.appendChild(mkButton(doc, label, fn));

    root.append(bar, result, status, actions);
    if (auto) run(ENGINES[engine] ? engine : defaultEngine());
    return { root, run };
  }

  // ------------------------------------------------------- reader popup
  function buildPopup(event) {
    const { reader, doc, params, append } = event;
    const source = params && params.annotation && params.annotation.text;
    if (!source || !source.trim()) return;
    const panel = buildTranslatePanel(doc, {
      source, attachmentID: reader.itemID, pageLabel: params.annotation.pageLabel,
      engine: defaultEngine(), auto: !!pref("autoTranslate"),
    });
    panel.root.style.cssText +=
      "box-sizing:border-box;width:340px;max-width:340px;padding:6px 8px;margin-top:4px;" +
      "border-top:1px solid rgba(128,128,128,.35);";
    append(panel.root);
  }

  // ------------------------------------- paragraph translation (modifier key + click)
  /** Pure: the paragraph around a PDF point, from Zotero's per-page char list. */
  function findParagraph(chars, x, y) {
    if (!Array.isArray(chars) || !chars.length) return null;
    let hit = -1, best = Infinity;
    for (let i = 0; i < chars.length; i++) {
      const r = chars[i].rect;
      if (!r) continue;
      const dx = x < r[0] ? r[0] - x : x > r[2] ? x - r[2] : 0;
      const dy = y < r[1] ? r[1] - y : y > r[3] ? y - r[3] : 0;
      const d = dx * dx + dy * dy;
      if (d < best) { best = d; hit = i; if (!d) break; }
    }
    if (hit < 0 || best > 30 * 30) return null;
    // Zotero's paragraphBreakAfter misses breaks between justified paragraphs, so rebuild lines and
    // also break at indents, short last lines and large vertical gaps (PDF space: y grows upward).
    const lines = [];
    let cur = null;
    for (let i = 0; i < chars.length; i++) {
      const r = chars[i].rect;
      if (!cur) cur = { a: i, b: i, r: r ? r.slice() : [Infinity, Infinity, -Infinity, -Infinity] };
      cur.b = i;
      if (r) {
        cur.r[0] = Math.min(cur.r[0], r[0]); cur.r[1] = Math.min(cur.r[1], r[1]);
        cur.r[2] = Math.max(cur.r[2], r[2]); cur.r[3] = Math.max(cur.r[3], r[3]);
      }
      if (chars[i].lineBreakAfter || chars[i].paragraphBreakAfter || i === chars.length - 1) {
        cur.pb = !!chars[i].paragraphBreakAfter;
        lines.push(cur);
        cur = null;
      }
    }
    const L = lines.findIndex((l) => hit >= l.a && hit <= l.b);
    const h = Math.max(4, lines[L].r[3] - lines[L].r[1]);
    const near = (up, down) => {
      const ov = Math.min(up.r[2], down.r[2]) - Math.max(up.r[0], down.r[0]);
      const gap = up.r[1] - down.r[3];
      return ov > 0.4 * Math.min(up.r[2] - up.r[0], down.r[2] - down.r[0]) && gap < 0.9 * h && gap > -0.6 * h;
    };
    let lo = L, hi = L;
    while (lo > 0 && near(lines[lo - 1], lines[lo])) lo--;
    while (hi < lines.length - 1 && near(lines[hi], lines[hi + 1])) hi++;
    let left = Infinity, right = -Infinity;
    for (let k = lo; k <= hi; k++) { left = Math.min(left, lines[k].r[0]); right = Math.max(right, lines[k].r[2]); }
    const breaksBetween = (up, down) =>
      up.pb || down.r[0] - left > 0.8 * h || right - up.r[2] > 2.2 * h;
    let a = L, b = L;
    while (a > lo && !breaksBetween(lines[a - 1], lines[a])) a--;
    while (b < hi && !breaksBetween(lines[b], lines[b + 1])) b++;
    a = lines[a].a;
    b = lines[b].b;
    let text = "";
    const rect = [Infinity, Infinity, -Infinity, -Infinity];
    for (let i = a; i <= b; i++) {
      const c = chars[i];
      text += c.c == null ? "" : c.c;
      if (c.lineBreakAfter) text += "\n";
      else if (c.spaceAfter) text += " ";
      const r = c.rect;
      if (r) {
        rect[0] = Math.min(rect[0], r[0]); rect[1] = Math.min(rect[1], r[1]);
        rect[2] = Math.max(rect[2], r[2]); rect[3] = Math.max(rect[3], r[3]);
      }
    }
    return { text, rect, start: a, end: b };
  }
  const MODIFIERS = { alt: "altKey", ctrl: "ctrlKey", meta: "metaKey", shift: "shiftKey" };
  function modifierDown(ev) {
    const key = MODIFIERS[pref("paraModifier") || "alt"];
    return !!key && !!ev[key];
  }
  function pageOf(ev) {
    const t = ev.target;
    if (!t || !t.closest || t.closest(".clitrans-para-box")) return null;
    return t.closest(".page[data-page-number]");
  }
  function paraEngine() {
    const e = pref("paraEngine");
    return ENGINES[e] ? e : defaultEngine();
  }
  async function paragraphClick(ev, reader, pv, w) {
    const pageEl = pageOf(ev);
    if (!pageEl) return;
    const idx = Number(pageEl.dataset.pageNumber) - 1;
    const view = w.PDFViewerApplication.pdfViewer.getPageView(idx);
    if (!view || !view.viewport || !view.div) return;
    const host = view.div;
    const hr = host.getBoundingClientRect();
    // pdf.js lives in a content compartment: passing our arrays into its helpers throws
    // "Permission denied", so apply the viewport transform here.
    const [a, b, c, d, e, f] = Array.from(view.viewport.transform, Number);
    const det = a * d - b * c || 1;
    const toPdf = (vx, vy) => [(d * (vx - e) - c * (vy - f)) / det, (a * (vy - f) - b * (vx - e)) / det];
    const toView = (x, y) => [a * x + c * y + e, b * x + d * y + f];
    const [px, py] = toPdf(ev.clientX - hr.left - host.clientLeft, ev.clientY - hr.top - host.clientTop);
    const page = pv._pdfPages && pv._pdfPages[idx];
    const para = findParagraph(page && page.chars, px, py);
    if (!para || !cleanSelection(para.text)) return;
    const doc = w.document;
    const id = "clitrans-para-" + idx + "-" + para.start;
    const old = doc.getElementById(id);
    if (old && old._clitransClose) { old._clitransClose(); return; } // click again to close

    const p1 = toView(para.rect[0], para.rect[1]), p2 = toView(para.rect[2], para.rect[3]);
    const left = Math.min(p1[0], p2[0]), right = Math.max(p1[0], p2[0]);
    const top = Math.min(p1[1], p2[1]), bottom = Math.max(p1[1], p2[1]);
    const mark = doc.createElement("div");
    mark.className = "clitrans-para-mark";
    mark.style.cssText = "position:absolute;pointer-events:none;z-index:9998;border-radius:3px;" +
      "background:rgba(255,196,0,.18);left:" + left + "px;top:" + top + "px;width:" + (right - left) +
      "px;height:" + (bottom - top) + "px;";
    const width = Math.max(right - left, 300);
    const box = doc.createElement("div");
    box.id = id;
    box.className = "clitrans-para-box";
    box.style.cssText =
      "position:absolute;z-index:9999;box-sizing:border-box;padding:6px 8px;border-radius:8px;" +
      "background:Canvas;color:CanvasText;border:1px solid rgba(128,128,128,.5);" +
      "box-shadow:0 4px 16px rgba(0,0,0,.25);font-family:system-ui,sans-serif;text-align:left;" +
      "left:" + Math.max(4, Math.min(left, host.clientWidth - width - 4)) + "px;top:" + (bottom + 4) +
      "px;width:" + width + "px;";
    const close = () => { mark.remove(); box.remove(); };
    box._clitransClose = close;
    for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "wheel"]) {
      box.addEventListener(type, (e) => e.stopPropagation());
    }
    const panel = buildTranslatePanel(doc, {
      source: para.text, attachmentID: reader.itemID, pageLabel: view.pageLabel || String(idx + 1),
      engine: paraEngine(), auto: true, extraButtons: [["关闭", close]],
    });
    box.append(panel.root);
    host.append(mark, box);
  }
  const attachedWins = new Map(); // PDF iframe window -> listeners
  async function attachReader(reader) {
    try {
      if (!reader || (reader._type && reader._type !== "pdf")) return;
      let pv = null, w = null;
      for (let i = 0; i < 160; i++) {
        pv = reader._internalReader && reader._internalReader._primaryView;
        const cand = pv && pv._iframeWindow;
        if (cand && cand.PDFViewerApplication && cand.PDFViewerApplication.pdfViewer && pv._pdfPages) { w = cand; break; }
        await sleep(250);
      }
      if (!w || attachedWins.has(w)) return;
      // swallow the whole press so the reader does not start a text selection under the modifier
      const onDown = (ev) => {
        if (ev.button === 0 && modifierDown(ev) && pageOf(ev)) { ev.preventDefault(); ev.stopImmediatePropagation(); }
      };
      const onClick = (ev) => {
        if (ev.button !== 0 || !modifierDown(ev) || !pageOf(ev)) return;
        ev.preventDefault();
        ev.stopPropagation();
        paragraphClick(ev, reader, pv, w).catch((e) => LOG("paragraph click failed", e));
        // the reader's own capture listeners run before ours and may have started a selection
        env.setTimeout(() => {
          try { w.getSelection().removeAllRanges(); } catch (e) {}
          try { pv._setSelectionRanges(); if (pv._render) pv._render(); } catch (e) {}
        }, 0);
      };
      for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup", "dblclick"]) w.addEventListener(t, onDown, true);
      w.addEventListener("click", onClick, true);
      attachedWins.set(w, { onDown, onClick });
    } catch (e) { LOG("attachReader failed", e); }
  }
  function attachAllReaders() {
    try { for (const r of Zotero.Reader._readers || []) attachReader(r); } catch (e) { LOG(e); }
  }
  function detachAllReaders() {
    for (const [w, h] of attachedWins) {
      try {
        for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup", "dblclick"]) w.removeEventListener(t, h.onDown, true);
        w.removeEventListener("click", h.onClick, true);
        for (const el of w.document.querySelectorAll(".clitrans-para-box,.clitrans-para-mark")) el.remove();
      } catch (e) {}
    }
    attachedWins.clear();
  }

  // ------------------------------------------------ reader toolbar: layout button
  function buildToolbar(event) {
    const { reader, doc, append } = event;
    attachReader(reader);
    const btn = doc.createElement("button");
    btn.className = "toolbar-button clitrans-layout-button";
    btn.textContent = "排版";
    btn.title = "智译：切换双语排版方式";
    btn.style.cssText = "width:auto;padding:0 8px;font-size:12px;white-space:nowrap;";
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleLayoutMenu(doc, btn, reader);
    });
    append(btn);
  }
  function toggleLayoutMenu(doc, btn, reader) {
    const existing = doc.getElementById("clitrans-layout-menu");
    if (existing) { existing.remove(); return; }
    const menu = doc.createElement("div");
    menu.id = "clitrans-layout-menu";
    const r = btn.getBoundingClientRect();
    const view = doc.defaultView;
    menu.style.cssText =
      "position:fixed;z-index:99999;min-width:250px;padding:4px;border-radius:8px;background:Canvas;" +
      "color:CanvasText;border:1px solid rgba(128,128,128,.5);box-shadow:0 4px 16px rgba(0,0,0,.25);" +
      "font:13px/1.5 system-ui,sans-serif;top:" + (r.bottom + 4) + "px;right:" +
      Math.max(4, view.innerWidth - r.right) + "px;";
    const close = () => { menu.remove(); doc.removeEventListener("pointerdown", onOutside, true); };
    const onOutside = (e) => { if (!menu.contains(e.target) && e.target !== btn) close(); };
    const cur = docLayout();
    for (const [k, l] of Object.entries(LAYOUTS)) {
      const it = doc.createElement("div");
      it.textContent = (k === cur ? "✓ " : "　 ") + l.label;
      it.style.cssText = "padding:4px 10px;border-radius:5px;cursor:pointer;";
      it.addEventListener("mouseenter", () => { it.style.background = "rgba(128,128,128,.2)"; });
      it.addEventListener("mouseleave", () => { it.style.background = ""; });
      it.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        close();
        setPref("docLayout", k);
        const win = Zotero.getMainWindow();
        try {
          await relayoutDocument(Zotero.Items.get(reader.itemID), win, k);
        } catch (err) {
          LOG(err);
          Zotero.alert(win, "智译 CLI", String((err && err.message) || err));
        }
      });
      menu.append(it);
    }
    const hint = doc.createElement("div");
    hint.textContent = "选中后为这篇文献生成该排版并打开。已经翻译过的段落直接复用，不会重复消耗额度；没翻译过的会用上次的引擎翻译。";
    hint.style.cssText = "padding:4px 10px;font-size:11px;opacity:.65;max-width:260px;";
    menu.append(hint);
    doc.body.append(menu);
    doc.addEventListener("pointerdown", onOutside, true);
  }

  // ------------------------------------------- local OpenAI-compatible bridge
  function headerValue(headers, name) {
    if (!headers) return "";
    if (typeof headers.get === "function") return headers.get(name) || "";
    const k = Object.keys(headers).find((h) => h.toLowerCase() === name.toLowerCase());
    return k ? String(headers[k]) : "";
  }
  function contentToText(c) {
    if (typeof c === "string") return c;
    if (Array.isArray(c)) return c.map((p) => (p && (p.text || (typeof p === "string" ? p : ""))) || "").join("");
    return "";
  }
  function splitMessages(messages) {
    const sys = [], conv = [];
    for (const m of messages || []) {
      const t = contentToText(m.content);
      if (!t) continue;
      if (m.role === "system" || m.role === "developer") sys.push(t);
      else conv.push(m.role === "assistant" ? "[assistant]\n" + t : t);
    }
    return { system: sys.join("\n\n"), user: conv.join("\n\n") };
  }
  function pickEngineFromModel(model) {
    const m = String(model || "").toLowerCase();
    if (m.includes("claude")) return "claude";
    if (m.includes("gemini")) return "gemini";
    if (m.includes("codex") || m.includes("gpt")) return "codex";
    return null;
  }
  function chatCompletion(model, content) {
    return {
      id: "chatcmpl-" + uid(), object: "chat.completion", created: Math.floor(Date.now() / 1000), model,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  }
  async function handleChatRequest(req) {
    const token = pref("bridgeToken");
    const auth = headerValue(req.headers, "Authorization");
    if (!token || auth !== "Bearer " + token) {
      return [401, "application/json", JSON.stringify({ error: { message: "invalid api key" } })];
    }
    let body = req.data;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
    if (!body || !Array.isArray(body.messages)) {
      return [400, "application/json", JSON.stringify({ error: { message: "messages required" } })];
    }
    const engine = pickEngineFromModel(body.model);
    if (!engine) return [400, "application/json", JSON.stringify({ error: { message: "model must be codex, claude or gemini" } })];
    const { system, user } = splitMessages(body.messages);
    try {
      const text = await callLLM(engine, system, user);
      return [200, "application/json", JSON.stringify(chatCompletion(body.model, text))];
    } catch (e) {
      return [500, "application/json", JSON.stringify({ error: { message: String(e && e.message || e) } })];
    }
  }

  // ------------------------------------------------------------ MCP server
  const MCP_TOOLS = [
    {
      name: "search_library",
      description: "Search the user's Zotero library (title, creators, year, tags, full text). Returns item keys.",
      inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] },
    },
    {
      name: "get_item",
      description: "Get metadata (title, authors, year, venue, DOI, abstract, tags, attachments) of a Zotero item by key.",
      inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
    },
    {
      name: "get_fulltext",
      description: "Get the extracted full text of the item's PDF. Use offset/max_chars to page through long papers.",
      inputSchema: { type: "object", properties: { key: { type: "string" }, offset: { type: "number" }, max_chars: { type: "number" } }, required: ["key"] },
    },
    {
      name: "get_notes_and_annotations",
      description: "Get the user's notes and PDF annotations (highlights + comments) for an item.",
      inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
    },
    {
      name: "translate_text",
      description: "Translate text with the plugin's engines (google is free and fast; codex/claude use local CLIs; gemini uses an API key or CLI).",
      inputSchema: { type: "object", properties: { text: { type: "string" }, engine: { type: "string", enum: ["google", "codex", "claude", "gemini"] } }, required: ["text"] },
    },
  ];

  async function itemByKey(key) {
    const item = await Zotero.Items.getByLibraryAndKeyAsync(Zotero.Libraries.userLibraryID, String(key || "").trim());
    if (!item) throw new Error("找不到条目 " + key);
    return item.isAttachment() && item.parentItem ? item.parentItem : item;
  }
  function itemSummary(item) {
    return {
      key: item.key,
      title: item.getField("title"),
      creators: item.getCreators().map((c) => [c.firstName, c.lastName].filter(Boolean).join(" ")).join("; "),
      year: (item.getField("date", true, true) || "").slice(0, 4),
      type: item.itemType,
    };
  }
  async function bestPDF(item) {
    if (item.isAttachment()) return item;
    const att = await item.getBestAttachment();
    return att || null;
  }
  async function mcpCallTool(name, args) {
    args = args || {};
    if (name === "search_library") {
      const s = new Zotero.Search();
      s.libraryID = Zotero.Libraries.userLibraryID;
      s.addCondition("quicksearch-everything", "contains", String(args.query || ""));
      const ids = await s.search();
      const items = Zotero.Items.get(ids)
        .map((it) => (it.isRegularItem() ? it : it.parentItem))
        .filter((it) => it && it.isRegularItem());
      const seen = new Set(), out = [];
      for (const it of items) {
        if (seen.has(it.id)) continue;
        seen.add(it.id);
        out.push(itemSummary(it));
        if (out.length >= Math.min(Number(args.limit) || 10, 50)) break;
      }
      return out;
    }
    if (name === "get_item") {
      const it = await itemByKey(args.key);
      const fields = {};
      for (const f of ["title", "abstractNote", "date", "publicationTitle", "volume", "issue", "pages", "DOI", "url"]) {
        try { const v = it.getField(f); if (v) fields[f] = v; } catch (e) {}
      }
      return {
        ...itemSummary(it), ...fields,
        tags: it.getTags().map((t) => t.tag),
        attachments: it.getAttachments().map((id) => Zotero.Items.get(id)).filter(Boolean)
          .map((a) => ({ key: a.key, title: a.getField("title"), contentType: a.attachmentContentType })),
      };
    }
    if (name === "get_fulltext") {
      const it = await itemByKey(args.key);
      const att = await bestPDF(it);
      if (!att) throw new Error("该条目没有 PDF 附件");
      const text = (await att.attachmentText) || "";
      const offset = Math.max(0, Number(args.offset) || 0);
      const max = Math.min(Number(args.max_chars) || 40000, 120000);
      return { key: it.key, total_chars: text.length, offset, text: text.slice(offset, offset + max) };
    }
    if (name === "get_notes_and_annotations") {
      const it = await itemByKey(args.key);
      const notes = it.isRegularItem()
        ? it.getNotes().map((id) => Zotero.Items.get(id)).filter(Boolean)
          .map((n) => Zotero.Utilities.unescapeHTML(n.getNote().replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim())
        : [];
      const annotations = [];
      for (const id of it.isRegularItem() ? it.getAttachments() : [it.id]) {
        const a = Zotero.Items.get(id);
        if (!a || !a.isAttachment() || !a.getAnnotations) continue;
        for (const an of a.getAnnotations()) {
          annotations.push({ type: an.annotationType, page: an.annotationPageLabel, text: an.annotationText || "", comment: an.annotationComment || "" });
        }
      }
      return { key: it.key, notes, annotations };
    }
    if (name === "translate_text") {
      return { translation: await translate(String(args.text || ""), args.engine || "google") };
    }
    throw new Error("未知工具 " + name);
  }

  async function mcpDispatch(msg) {
    const id = msg && msg.id;
    const isNotification = id === undefined || id === null;
    const ok = (result) => ({ jsonrpc: "2.0", id, result });
    const fail = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
    if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return isNotification ? null : fail(-32600, "Invalid Request");
    if (isNotification) return null;
    switch (msg.method) {
      case "initialize":
        return ok({
          protocolVersion: (msg.params && msg.params.protocolVersion) || "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "zotero-clitrans", version: env.version || "0.1.0" },
          instructions: "Read-only access to the user's Zotero library: search, metadata, full text, notes and annotations; plus translation.",
        });
      case "ping": return ok({});
      case "tools/list": return ok({ tools: MCP_TOOLS });
      case "tools/call": {
        const p = msg.params || {};
        try {
          const r = await mcpCallTool(p.name, p.arguments);
          return ok({ content: [{ type: "text", text: JSON.stringify(r, null, 2) }], isError: false });
        } catch (e) {
          return ok({ content: [{ type: "text", text: "Error: " + (e && e.message || e) }], isError: true });
        }
      }
      default: return fail(-32601, "Method not found: " + msg.method);
    }
  }
  async function handleMcpRequest(req) {
    if (!pref("mcpEnabled")) return [404, "text/plain", "MCP disabled"];
    const token = (pref("mcpToken") || "").trim();
    if (token && headerValue(req.headers, "Authorization") !== "Bearer " + token) {
      return [401, "application/json", JSON.stringify({ error: "unauthorized" })];
    }
    if (req.method === "GET") return [405, "text/plain", "SSE stream not supported"];
    let body = req.data;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { return [400, "application/json", JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })]; } }
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map(mcpDispatch))).filter(Boolean);
      return out.length ? [200, "application/json", JSON.stringify(out)] : [202, "text/plain", ""];
    }
    const res = await mcpDispatch(body);
    return res ? [200, "application/json", JSON.stringify(res)] : [202, "text/plain", ""];
  }

  async function handleTranslateRequest(req) {
    if (headerValue(req.headers, "Authorization") !== "Bearer " + pref("bridgeToken")) {
      return [401, "application/json", JSON.stringify({ error: "invalid token" })];
    }
    let body = req.data;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
    if (!body || typeof body.text !== "string") return [400, "application/json", JSON.stringify({ error: "text required" })];
    try {
      if (body.mode === "figure") {
        if (!visionCapable(body.engine || "")) throw new Error("该引擎不支持看图翻译");
        if (typeof body.image !== "string" || !/\.png$/i.test(body.image) || !fileExists(body.image)) throw new Error("image not found");
        const gl = glossaryForText(parseGlossary(pref("glossary")), body.text);
        const out = await callVision(body.engine, figurePrompt(pref("targetLangName") || "简体中文", gl),
          "Text extracted from the PDF (symbols may be garbled — trust the image): " + String(body.text || "").slice(0, 2500),
          [body.image]);
        return [200, "application/json", JSON.stringify({ translation: out })];
      }
      if (body.mode === "vision") {
        if (!visionCapable(body.engine || "")) throw new Error("该引擎不支持看图翻译");
        if (typeof body.image !== "string" || !/\.png$/i.test(body.image) || !fileExists(body.image)) throw new Error("image not found");
        return [200, "application/json", JSON.stringify({ translation: await enqueueVision(body.image, body.text, body.engine) })];
      }
      const translation = await translateSegment(body.text, body.engine || "google", body.mode);
      return [200, "application/json", JSON.stringify({ translation })];
    } catch (e) {
      return [502, "application/json", JSON.stringify({ error: String(e && e.message || e) })];
    }
  }

  const PATHS = {
    translate: "/clitrans/v1/translate",
    chat: "/clitrans/v1/chat/completions",
    models: "/clitrans/v1/models",
    mcp: "/clitrans/mcp",
  };
  function serverPort() {
    try { return Zotero.Prefs.get("httpServer.port") || 23119; } catch (e) { return 23119; }
  }
  function bridgeBaseURL() { return "http://127.0.0.1:" + serverPort() + "/clitrans/v1"; }
  function mcpURL() { return "http://127.0.0.1:" + serverPort() + PATHS.mcp; }

  function makeEndpoint(methods, handler) {
    const E = function () {};
    E.prototype = {
      supportedMethods: methods,
      supportedDataTypes: ["application/json", "text/plain"],
      permitBookmarklet: false,
      init: async function (req) {
        try { return await handler(req); } catch (e) {
          LOG("endpoint error", e);
          return [500, "application/json", JSON.stringify({ error: { message: String(e && e.message || e) } })];
        }
      },
    };
    return E;
  }
  function registerEndpoints() {
    const E = Zotero.Server.Endpoints;
    E[PATHS.chat] = makeEndpoint(["POST"], handleChatRequest);
    E[PATHS.translate] = makeEndpoint(["POST"], handleTranslateRequest);
    E[PATHS.models] = makeEndpoint(["GET"], async () => [200, "application/json", JSON.stringify({
      object: "list", data: ["codex", "claude", "gemini"].map((id) => ({ id, object: "model", owned_by: "local-cli" })),
    })]);
    E[PATHS.mcp] = makeEndpoint(["POST", "GET"], handleMcpRequest);
  }
  function unregisterEndpoints() {
    for (const p of Object.values(PATHS)) delete Zotero.Server.Endpoints[p];
  }

  // ------------------------------------------------ whole-document translation
  // 逐段对照 is built by interleave.py straight from the original PDF (originals are cropped, never
  // re-typeset). The other layouts use pdf2zh_next's in-place translated ("mono") PDF, composed with
  // the original by p2z_runner.py, so switching between them does not re-translate.
  const LAYOUTS = {
    interleave: { label: "逐段对照（每段原文下方紧接译文，推荐）", title: "逐段对照", suffix: "interleave" },
    side: { label: "左右对照（左原文·右译文）", title: "双语对照（左右）", suffix: "side" },
    alternate: { label: "交替页（一页原文·一页译文）", title: "双语对照（交替页）", suffix: "alt" },
    mono: { label: "仅译文", title: "译文", suffix: "mono" },
  };
  function docLayout(l) {
    l = l || pref("docLayout");
    if (l === "stacked") l = "interleave"; // 0.3.0's page-level "上下对照" was replaced by 逐段对照
    return LAYOUTS[l] ? l : "interleave";
  }
  const TRANSLATED_NAME = /\.(?:mono|dual|side|stacked|alt|interleave)\.pdf$/i; // .mono: 仅译文
  function isTranslationTitle(title, filename) {
    return /^(?:译文|双语对照|逐段对照|翻译)(?:\s*[·（(]|$)/.test(String(title || "")) || TRANSLATED_NAME.test(String(filename || ""));
  }
  function isTranslationAttachment(att) {
    try {
      return !!att && att.isAttachment() && isTranslationTitle(att.getField("title"), att.attachmentFilename);
    } catch (e) { return false; }
  }
  function isPDF(att) { return !!att && att.isAttachment() && att.attachmentContentType === "application/pdf"; }
  function pdfSiblings(item) {
    const parent = item.isAttachment() ? item.parentItem : item;
    if (!parent) return isPDF(item) ? [item] : [];
    return parent.getAttachments().map((id) => Zotero.Items.get(id)).filter(isPDF);
  }
  const byDateAdded = (a, b) => String(a.dateAdded).localeCompare(String(b.dateAdded));
  /** The source PDF of an item — never one of our own translated attachments. */
  async function originalPDF(item) {
    if (isPDF(item) && !isTranslationAttachment(item)) return item;
    const originals = pdfSiblings(item).filter((a) => !isTranslationAttachment(a)).sort(byDateAdded);
    if (originals.length) return originals[0];
    return item.isAttachment() ? null : bestPDF(item);
  }
  function latestMono(item) {
    const monos = pdfSiblings(item).filter((a) =>
      /\.mono\.pdf$/i.test(a.attachmentFilename || "") || /^译文(?:\s*·|$)/.test(a.getField("title") || ""));
    return monos.sort(byDateAdded).pop() || null;
  }

  /** Engine id of the most recent translation attached to an item ("译文 · GPT（…）" → "codex"). */
  function lastEngine(item) {
    const tr = pdfSiblings(item).filter(isTranslationAttachment).sort(byDateAdded).pop();
    const lbl = tr ? engineFromTitle(tr.getField("title")) : "";
    if (/^GPT/i.test(lbl)) return "codex";
    if (/^Claude/i.test(lbl)) return "claude";
    if (/^Gemini/i.test(lbl)) return "gemini";
    if (/^Google/i.test(lbl)) return "google";
    return ENGINES[pref("docEngine")] ? pref("docEngine") : "google";
  }

  async function listPDFs(dir) {
    const out = [];
    await Zotero.File.iterateDirectory(dir, async (entry) => {
      if (!entry.isDir && /\.pdf$/i.test(entry.name)) out.push(entry);
    });
    return out;
  }
  function pdf2zhArgs({ input, outDir, engine, pages }) {
    const lang = pref("targetLang") || "zh-CN";
    // Concurrency: many in-flight segments let the plugin batch them into few LLM calls.
    const workers = ENGINES[engine] && ENGINES[engine].llm ? 120 : 12;
    const a = [input, "--output", outDir, "--lang-out", lang, "--watermark-output-mode", "no_watermark",
      "--google", "--qps", String(workers), "--pool-max-workers", String(workers), "--no-dual"];
    if (pref("translateTables") !== false) a.push("--translate-table-text");
    if (pages) a.push("--pages", String(pages));
    return a;
  }
  const STAGE_ZH = {
    "DetectScannedFile": "检测扫描件",
    "Parse PDF and Create Intermediate Representation": "解析 PDF",
    "Parse Page Layout": "识别版面",
    "Parse Paragraphs": "识别段落",
    "Parse Formulas and Styles": "识别公式与样式",
    "Parse Table": "识别表格",
    "Translate table text (experimental)": "翻译表格",
    "Automatic Term Extraction": "提取术语",
    "Translate Paragraphs": "翻译段落",
    "Typesetting": "排版",
    "Add Fonts": "嵌入字体",
    "Subset font": "精简字体",
    "Generate drawing instructions": "生成页面",
    "Save PDF": "保存 PDF",
    "Compose layout": "生成双语排版",
    "Analyze layout": "识别版面",
    "OCR figures": "识别图中文字",
    "Read formulas": "看图识别公式",
    "Prepare OCR": "准备文字识别（仅首次，约 30 秒）",
  };
  function friendlyError(msg) {
    msg = String(msg || "");
    if (/SSLError|CERTIFICATE|ConnectError|ProxyError/i.test(msg)) return "网络连接失败（" + msg.slice(0, 160) + "）。请确认代理/TUN 已开启。";
    if (/401|invalid token/i.test(msg)) return "插件内部令牌不匹配，请重启 Zotero 后重试。";
    return msg.slice(-800);
  }
  function fmtDuration(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(s / 60);
    return m ? m + "分" + String(s % 60).padStart(2, "0") + "秒" : s + "秒";
  }
  function formatProgress({ pct, stage, part, parts, cur, tot, elapsedMs }) {
    const parts_ = [Math.floor(pct) + "%"];
    if (stage) {
      let st = STAGE_ZH[stage] || stage;
      if (tot && cur != null && tot > 1) st += " " + cur + "/" + tot;
      if (parts > 1) st += "（第 " + part + "/" + parts + " 部分）";
      parts_.push(st);
    }
    parts_.push("已用 " + fmtDuration(elapsedMs));
    if (pct >= 3 && pct < 99) parts_.push("约剩 " + fmtDuration(elapsedMs * (100 - pct) / pct));
    return parts_.join(" · ");
  }
  /** pdf2zh_next is a uv/pip entry script; its shebang points at the venv's python. */
  async function pdf2zhPython(scriptPath) {
    for (const c of [
      homeDir() + "/.local/share/uv/tools/pdf2zh-next/bin/python",
      homeDir() + "/.local/share/uv/tools/pdf2zh_next/bin/python",
    ]) if (fileExists(c)) return c;
    try {
      const head = (await Zotero.File.getContentsAsync(scriptPath, null, 400)) || "";
      const m = String(head).match(/^#!\s*(\S+python[\d.]*)\s*$/m);
      if (m && fileExists(m[1])) return m[1];
    } catch (e) {}
    return null;
  }
  /** Read a text file shipped inside the plugin. Zotero 10's Zotero.HTTP rejects jar: URLs
   *  (the installed .xpi), so use the main window's fetch first and keep the old call as fallback. */
  async function readPackaged(rel) {
    const url = env.rootURI + rel;
    try {
      const win = Zotero.getMainWindow();
      const res = await win.fetch(url);
      const text = await res.text();
      if (text) return text;
    } catch (e) { LOG("fetch of packaged file failed, trying Zotero.File", e); }
    return Zotero.File.getContentsFromURLAsync(url);
  }
  async function writeRunner(dir) {
    try {
      for (const f of ["p2z_runner.py", "interleave.py", "ocr.swift"]) {
        const src = await readPackaged("content/" + f);
        if (!src) throw new Error("empty " + f);
        await Zotero.File.putContentsAsync(joinPath(dir, f), src);
      }
      return joinPath(dir, "p2z_runner.py");
    } catch (e) { LOG("runner write failed", e); return null; }
  }
  /** Python + runner script for a job directory, or a user-facing error. */
  async function prepareRunner(outDir) {
    const pdf2zh = resolveTool("pdf2zh");
    if (!pdf2zh) throw new Error("找不到 pdf2zh_next，请先安装（见设置页说明）并填写路径");
    const python = await pdf2zhPython(pdf2zh);
    if (!python) throw new Error("找不到 pdf2zh_next 自带的 Python。请重新安装：uv tool install --python 3.12 pdf2zh_next");
    const runner = await writeRunner(outDir);
    if (!runner) throw new Error("无法从插件包中读取翻译脚本 p2z_runner.py（插件 " + (env.version || "") + "）。请重新安装智译插件后重试。");
    return { python, runner, interleave: joinPath(outDir, "interleave.py") };
  }
  /** Run the runner, feeding its "@@P {json}" lines to onEvent. */
  function runRunner(python, args, opts, onEvent) {
    let buf = "";
    return runProcess(python, args, Object.assign({}, opts, {
      onOutput: (s) => {
        buf += s;
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const l = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (l.startsWith("@@P ")) { try { onEvent(JSON.parse(l.slice(4))); } catch (e) {} }
        }
      },
    }));
  }
  function engineFromTitle(title) {
    const m = String(title || "").match(/·\s*(.+)$/);
    return m ? m[1].trim() : "";
  }

  async function translateDocument(item, window, engineArg, opts = {}) {
    const att = await originalPDF(item);
    if (!isPDF(att)) throw new Error("没找到 PDF 附件");
    const input = await att.getFilePathAsync();
    if (!input) throw new Error("PDF 文件不在本地（可能只在云端）");
    const engine = engineArg || pref("docEngine") || "google";
    if (!ENGINES[engine]) throw new Error("未知引擎：" + engine);
    const layout = docLayout(opts.layout);
    ensureTokens();

    const outDir = joinPath(tmpDir(), "clitrans-doc-" + uid());
    await Zotero.File.createDirectoryIfMissingAsync(outDir);
    const title = att.getField("title") || "PDF";
    const shortTitle = title.length > 40 ? title.slice(0, 38) + "…" : title;
    const pw = new Zotero.ProgressWindow({ closeOnClick: false });
    pw.changeHeadline("整篇翻译 · " + engineLabel(engine) + " · " + LAYOUTS[layout].title);
    const line = new pw.ItemProgress(null, shortTitle);
    line.setText("启动 pdf2zh_next…（首次加载模型约 10–30 秒）");
    pw.show();
    const fail = (closeMs) => { line.setError(); pw.startCloseTimer(closeMs); };

    let python, runner, interleave;
    try { ({ python, runner, interleave } = await prepareRunner(outDir)); } catch (e) { fail(6000); throw e; }

    const t0 = Date.now();
    let pct = 0, lastUI = 0, lastError = "", warn = "";
    const update = (ev) => {
      if (ev.p != null) pct = Math.max(pct, Math.min(99, Number(ev.p) || 0));
      const now = Date.now();
      if (now - lastUI < 400) return;
      lastUI = now;
      line.setProgress(pct);
      line.setText(formatProgress({ pct, stage: ev.stage, part: ev.part, parts: ev.parts, cur: ev.cur, tot: ev.tot, elapsedMs: now - t0 }));
    };
    resetDocStats();
    const model = engine === "codex" ? pref("codexModel") : engine === "claude" ? pref("claudeModel") : engine === "gemini" ? (geminiChannel() || "") + "/" + (geminiChannel() === "agy" ? agyModel() : geminiModel()) : "";
    // every layout is built by interleave.py: the original is never re-typeset (no garbled formulas),
    // translated formulas are typeset, figure/table text is translated. pdf2zh_next's in-place mode
    // remains below only as a fallback (pref "inPlaceLayout").
    if (!pref("inPlaceLayout")) {
      line.setText("启动…（加载版面识别模型约 5 秒）");
      const stem = String(att.attachmentFilename || "document.pdf").replace(/\.pdf$/i, "");
      const out = joinPath(outDir, stem + "." + (pref("targetLang") || "zh-CN") + "." + LAYOUTS[layout].suffix + ".pdf");
      let done = null;
      const ri = await runRunner(python, [interleave, input, out, "--layout", layout].concat(opts.pages ? ["--pages", String(opts.pages)] : []), {
        workdir: outDir,
        timeoutMs: 3 * 60 * 60 * 1000,
        env: {
          CLITRANS_TRANSLATE_URL: bridgeBaseURL() + "/translate", CLITRANS_TOKEN: pref("bridgeToken"),
          CLITRANS_ENGINE: engine,
          CLITRANS_VISION: visionCapable(engine) && pref("visionFormulas") !== false ? "1" : "",
          CLITRANS_CACHE_KEY: [engine, model, pref("glossary") || "", pref("targetLang") || "zh-CN", "i1",
            pref("skipReferences") !== false ? 1 : 0].join(":"),
        },
      }, (ev) => {
        if (ev.error) { lastError = ev.error; LOG("interleave error", ev.error); }
        else if (ev.done) done = ev;
        else update(ev);
      });
      if (ri.exitCode !== 0 || !done || !fileExists(out)) {
        line.setText("失败");
        fail(8000);
        throw new Error(LAYOUTS[layout].title + "生成失败（" + engineLabel(engine) + "，插件 " + (env.version || "") + "）：\n" + friendlyError(lastError || errText(ri)));
      }
      const added = await Zotero.Attachments.importFromFile({
        file: out, parentItemID: att.parentItemID || null, libraryID: att.libraryID,
        title: LAYOUTS[layout].title + " · " + engineLabel(engine),
      });
      line.setProgress(100);
      line.setText("完成 · 用时 " + fmtDuration(Date.now() - t0) + " · 已翻译 " + done.translated + " 段" +
        (done.errors ? " · " + done.errors + " 段翻译失败（保留原文）" : ""));
      pw.startCloseTimer(done.errors ? 9000 : 4000);
      if (pref("openDualAfter")) { try { await Zotero.Reader.open(added.id); } catch (e) {} }
      return added;
    }
    const r = await runRunner(python, [runner, ...pdf2zhArgs({ input, outDir, engine, pages: opts.pages })], {
      workdir: outDir,
      timeoutMs: 3 * 60 * 60 * 1000,
      env: {
        CLITRANS_TRANSLATE_URL: bridgeBaseURL() + "/translate", CLITRANS_TOKEN: pref("bridgeToken"),
        CLITRANS_ENGINE: engine, CLITRANS_LAYOUT: layout,
        // translations are cached per text + this key; "g3" = guard rules version
        CLITRANS_CACHE_KEY: [engine, model, (pref("glossary") || "").length, "g3",
          pref("keepFormulaDense") !== false ? 1 : 0, pref("skipReferences") !== false ? 1 : 0].join(":"),
      },
    }, (ev) => {
      if (ev.error) { lastError = ev.error; LOG("pdf2zh error", ev.error, ev.details); }
      else if (ev.warn) { warn = ev.warn; LOG("runner warning", ev.warn); }
      else update(ev);
    });
    const pdfs = (await listPDFs(outDir)).filter((e) => e.path !== input);
    const mono = pdfs.find((e) => /\.mono\.pdf$/i.test(e.name));
    if (r.exitCode !== 0 || !mono) {
      line.setText("失败");
      fail(8000);
      throw new Error("整篇翻译失败（" + engineLabel(engine) + "，插件 " + (env.version || "") + "）：\n" + friendlyError(lastError || errText(r)));
    }
    const composed = layout === "mono" ? null
      : pdfs.find((e) => e.name.toLowerCase().endsWith("." + LAYOUTS[layout].suffix + ".pdf"));
    const parentItemID = att.parentItemID || null;
    const lbl = engineLabel(engine);
    let shown = null;
    if (composed) {
      shown = await Zotero.Attachments.importFromFile({
        file: composed.path, parentItemID, libraryID: att.libraryID, title: LAYOUTS[layout].title + " · " + lbl,
      });
    }
    const monoAtt = await Zotero.Attachments.importFromFile({
      file: mono.path, parentItemID, libraryID: att.libraryID, title: "译文 · " + lbl,
    });
    shown = shown || monoAtt;
    line.setProgress(100);
    const kept = keptSummary();
    line.setText("完成 · 用时 " + fmtDuration(Date.now() - t0) + (kept ? " · " + kept : "") +
      (layout !== "mono" && !composed ? " · 双语排版生成失败，仅附加译文" + (warn ? "（" + warn.slice(0, 80) + "）" : "") : ""));
    pw.startCloseTimer(kept ? 9000 : 4000);
    if (shown && pref("openDualAfter")) { try { await Zotero.Reader.open(shown.id); } catch (e) {} }
    return shown;
  }

  /** Build another bilingual layout from the original PDF + an existing translated PDF. No translation. */
  async function relayoutDocument(item, window, layoutArg) {
    if (!item) throw new Error("没找到条目");
    const layout = docLayout(layoutArg);
    // every layout is rebuilt from the original; translated paragraphs come from the local cache
    if (!pref("inPlaceLayout")) return translateDocument(item, window, lastEngine(item), { layout });
    const mono = latestMono(item);
    if (!mono) return translateDocument(item, window, lastEngine(item), { layout });
    if (layout === "mono") { await Zotero.Reader.open(mono.id); return mono; }
    const orig = await originalPDF(item);
    if (!isPDF(orig)) throw new Error("没找到原文 PDF");
    const origPath = await orig.getFilePathAsync();
    const monoPath = await mono.getFilePathAsync();
    if (!origPath || !monoPath) throw new Error("原文或译文 PDF 不在本地（可能只在云端）");

    const outDir = joinPath(tmpDir(), "clitrans-doc-" + uid());
    await Zotero.File.createDirectoryIfMissingAsync(outDir);
    const { python, runner } = await prepareRunner(outDir);
    const stem = String(orig.attachmentFilename || "document.pdf").replace(/\.pdf$/i, "");
    const out = joinPath(outDir, stem + "." + (pref("targetLang") || "zh-CN") + "." + LAYOUTS[layout].suffix + ".pdf");
    const pw = new Zotero.ProgressWindow({ closeOnClick: true });
    pw.changeHeadline("重新排版 · " + LAYOUTS[layout].title);
    const line = new pw.ItemProgress(null, "用已有译文生成，不重新翻译…");
    pw.show();
    let lastError = "";
    const r = await runRunner(python, [runner, "--relayout", origPath, monoPath, layout, out],
      { workdir: outDir, timeoutMs: 10 * 60 * 1000 }, (ev) => { if (ev.error) lastError = ev.error; });
    if (r.exitCode !== 0 || !fileExists(out)) {
      line.setError();
      pw.startCloseTimer(6000);
      throw new Error("重新排版失败：" + (lastError || errText(r)).slice(-500));
    }
    const lbl = engineFromTitle(mono.getField("title"));
    const added = await Zotero.Attachments.importFromFile({
      file: out, parentItemID: orig.parentItemID || null, libraryID: orig.libraryID,
      title: LAYOUTS[layout].title + (lbl ? " · " + lbl : ""),
    });
    line.setProgress(100);
    line.setText("完成 · 已附加到条目");
    pw.startCloseTimer(3000);
    if (pref("openDualAfter")) { try { await Zotero.Reader.open(added.id); } catch (e) {} }
    return added;
  }

  // ------------------------------------------------------------ test helper
  async function selfTest(engine) {
    const t0 = Date.now();
    const out = await translate("Supply chain finance improves working capital efficiency.", engine);
    return engineLabel(engine) + " ✓ " + ((Date.now() - t0) / 1000).toFixed(1) + "s → " + out;
  }
  function describeSetup() {
    ensureTokens();
    const mcp = mcpURL();
    const tok = (pref("mcpToken") || "").trim();
    const hdr = tok ? ' --header "Authorization: Bearer ' + tok + '"' : "";
    return {
      codex: resolveTool("codex"), claude: resolveTool("claude"), pdf2zh: resolveTool("pdf2zh"),
      gemini: geminiChannel() === "api" ? "API Key（" + geminiModel() + "）"
        : geminiChannel() === "agy" ? "Antigravity CLI " + resolveTool("agy") + "（" + agyModel() + "）"
          : resolveTool("gemini"),
      bridge: bridgeBaseURL(), mcp,
      claudeMcpCmd: "claude mcp add --scope user --transport http zotero-library " + mcp + hdr,
      codexMcpCmd: "codex mcp add zotero-library --url " + mcp,
    };
  }

  return {
    // runtime
    ensureTokens, registerEndpoints, unregisterEndpoints, buildPopup, buildToolbar, attachAllReaders,
    detachAllReaders, translate, translateDocument, relayoutDocument, saveToNote, selfTest, describeSetup,
    resolveTool, ENGINES, LAYOUTS, engineLabel, docLayout, listCodexModels,
    // exported for tests
    _t: {
      parseGlossary, glossaryForText, glossaryToCSV, translatorSystemPrompt, cleanSelection,
      parseGoogleResponse, chunkText, buildCodexArgs, buildClaudeArgs, buildGeminiArgs, parseGeminiResponse,
      splitMessages, pickEngineFromModel, handleChatRequest, handleTranslateRequest, handleMcpRequest,
      parseBatchResult, batchSystemPrompt, parseVisionResult, visionPrompt, translateSegment, runBatch, mcpDispatch, pdf2zhArgs,
      noteBlockHTML, runWithFlagFallback, headerValue, formatProgress, fmtDuration,
      normalizePlaceholders, placeholdersIntact, isFormulaDense, isReferenceLike, isFragment, segmentGuard,
      findParagraph, isTranslationTitle, engineFromTitle, docStats, docLayout,
      attached: () => [...attachedWins.keys()].map((w) => { try { return w.location.href.slice(0, 80); } catch (e) { return "?"; } }),
      isAttached: (w) => attachedWins.has(w),
    },
  };
}
