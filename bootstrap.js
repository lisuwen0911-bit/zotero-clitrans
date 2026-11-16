/* Verso (formerly 智译 CLI Translate) — Zotero 7+ bootstrap */
var CLITrans, popupHandler, toolbarHandler, prefPaneID;
const MENU_IDS = ["clitrans-sep", "clitrans-doc-translate", "clitrans-doc-layout"];

function log(m) { try { Zotero.debug("[CLITrans] " + m); } catch (e) {} }

function install() {}

async function startup({ id, version, rootURI }) {
  await Zotero.initializationPromise;
  const scope = {};
  Services.scriptloader.loadSubScript(rootURI + "content/clitrans.js", scope);
  const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
  const { setTimeout, clearTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
  CLITrans = scope.createCLITrans({ Zotero, Subprocess, setTimeout, clearTimeout, Services, rootURI, pluginID: id, version });
  Zotero.CLITrans = CLITrans;

  CLITrans.ensureTokens();
  try { CLITrans.registerEndpoints(); } catch (e) { log("endpoint register failed: " + e); }

  popupHandler = (event) => {
    try { CLITrans.buildPopup(event); } catch (e) { log("popup error: " + e); }
  };
  Zotero.Reader.registerEventListener("renderTextSelectionPopup", popupHandler, id);
  // toolbar: 排版 button; also hooks "modifier + click = translate this paragraph" into each new reader
  toolbarHandler = (event) => {
    try { CLITrans.buildToolbar(event); } catch (e) { log("toolbar error: " + e); }
  };
  Zotero.Reader.registerEventListener("renderToolbar", toolbarHandler, id);
  CLITrans.attachAllReaders(); // readers that were already open

  prefPaneID = await Zotero.PreferencePanes.register({
    pluginID: id,
    src: rootURI + "content/preferences.xhtml",
    scripts: [rootURI + "content/preferences.js"],
    label: "Verso",
    image: rootURI + "content/icons/icon96.png",
  });

  for (const win of Zotero.getMainWindows()) addToWindow(win);
  log("started " + version);
}

async function forSelected(window, fn) {
  for (const item of window.ZoteroPane.getSelectedItems()) {
    try {
      await fn(item);
    } catch (err) {
      log(err);
      Zotero.alert(window, "Verso", String((err && err.message) || err));
    }
  }
}

function addToWindow(window) {
  const doc = window.document;
  const menu = doc.getElementById("zotero-itemmenu");
  if (!menu || doc.getElementById("clitrans-doc-translate")) return;
  const sep = doc.createXULElement("menuseparator");
  sep.id = "clitrans-sep";

  // ---- 整篇翻译: pick an engine; uses the layout chosen under 「Verso：排版」
  const mi = doc.createXULElement("menu");
  mi.id = "clitrans-doc-translate";
  mi.setAttribute("label", "Verso：整篇翻译（保留排版）");
  const popup = doc.createXULElement("menupopup");
  popup.addEventListener("popupshowing", (ev) => {
    if (ev.target !== popup) return;
    popup.replaceChildren();
    const head = doc.createXULElement("menuitem");
    head.setAttribute("label", "当前排版：" + CLITrans.LAYOUTS[CLITrans.docLayout()].label);
    head.setAttribute("disabled", "true");
    popup.append(head, doc.createXULElement("menuseparator"));
    for (const engine of Object.keys(CLITrans.ENGINES)) {
      const e = CLITrans.ENGINES[engine];
      const it = doc.createXULElement("menuitem");
      it.setAttribute("label", CLITrans.engineLabel(engine) + (e.free ? " · 免费" : e.cli ? " · 用订阅额度" : " · 用 API/CLI 额度"));
      it.addEventListener("command", () => forSelected(window, (item) => CLITrans.translateDocument(item, window, engine)));
      popup.append(it);
    }
  });
  mi.append(popup);

  // ---- 排版: choose the default layout, or rebuild a layout from an existing translation
  const ml = doc.createXULElement("menu");
  ml.id = "clitrans-doc-layout";
  ml.setAttribute("label", "Verso：排版");
  const lpopup = doc.createXULElement("menupopup");
  lpopup.addEventListener("popupshowing", (ev) => {
    if (ev.target !== lpopup) return;
    lpopup.replaceChildren();
    const cur = CLITrans.docLayout();
    for (const [k, l] of Object.entries(CLITrans.LAYOUTS)) {
      const it = doc.createXULElement("menuitem");
      it.setAttribute("type", "radio");
      it.setAttribute("label", l.label);
      if (k === cur) it.setAttribute("checked", "true");
      it.addEventListener("command", () => Zotero.Prefs.set("clitrans.docLayout", k));
      lpopup.append(it);
    }
    lpopup.append(doc.createXULElement("menuseparator"));
    const re = doc.createXULElement("menuitem");
    re.setAttribute("label", "按当前排版重新生成（已译段落不重复翻译）");
    re.addEventListener("command", () => forSelected(window, (item) => CLITrans.relayoutDocument(item, window)));
    lpopup.append(re);
  });
  ml.append(lpopup);

  menu.append(sep, mi, ml);
}

function removeFromWindow(window) {
  for (const id of MENU_IDS) {
    const el = window.document.getElementById(id);
    if (el) el.remove();
  }
}

function onMainWindowLoad({ window }) { addToWindow(window); }
function onMainWindowUnload({ window }) { removeFromWindow(window); }

function shutdown() {
  try { Zotero.Reader.unregisterEventListener("renderTextSelectionPopup", popupHandler); } catch (e) {}
  try { Zotero.Reader.unregisterEventListener("renderToolbar", toolbarHandler); } catch (e) {}
  try { CLITrans && CLITrans.detachAllReaders(); } catch (e) {}
  try { CLITrans && CLITrans.unregisterEndpoints(); } catch (e) {}
  try { if (prefPaneID) Zotero.PreferencePanes.unregister(prefPaneID); } catch (e) {}
  for (const win of Zotero.getMainWindows()) removeFromWindow(win);
  delete Zotero.CLITrans;
  CLITrans = null;
}

function uninstall() {}
