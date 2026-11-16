# 智译 CLI — runs pdf2zh_next in-process and prints machine-readable progress.
# Translate:  <pdf2zh_next's python> p2z_runner.py <same args as pdf2zh_next>
# Re-layout:  <pdf2zh_next's python> p2z_runner.py --relayout <original.pdf> <mono.pdf> <layout> <out.pdf>
import asyncio
import json
import logging
import os
import sys

LAYOUT_SUFFIX = {"side": "side", "stacked": "stacked", "alternate": "alt"}


def patch_translator():
    """pdf2zh_next keeps doing layout; every text segment is sent to Zotero, which translates it
    with the engine the user picked (Google / Codex / Claude / Gemini). Zotero uses the system
    proxy and batches LLM segments, so Python never talks to the internet."""
    import time
    import urllib.error
    import urllib.request

    url = os.environ["CLITRANS_TRANSLATE_URL"]
    token = os.environ.get("CLITRANS_TOKEN", "")
    engine = os.environ.get("CLITRANS_ENGINE", "google")
    cache_key = os.environ.get("CLITRANS_CACHE_KEY", engine)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # localhost: never via proxy
    from pdf2zh_next.translator.translator_impl import google as g

    orig_init = g.GoogleTranslator.__init__

    def __init__(self, *a, **kw):
        orig_init(self, *a, **kw)
        self.add_cache_impact_parameters("clitrans_engine", cache_key)

    def do_translate(self, text, rate_limit_params=None):
        body = json.dumps({"text": text, "tl": self.lang_out, "engine": engine}).encode()
        last = None
        for attempt in range(4):
            try:
                req = urllib.request.Request(url, data=body, headers={
                    "Content-Type": "application/json", "Authorization": "Bearer " + token})
                with opener.open(req, timeout=900) as r:
                    return json.loads(r.read())["translation"]
            except urllib.error.HTTPError as e:
                try:
                    last = json.loads(e.read()).get("error") or e
                except Exception:  # noqa: BLE001
                    last = e
                if e.code == 401:
                    break
            except Exception as e:  # noqa: BLE001
                last = e
            time.sleep(1 + attempt * 2)
        raise RuntimeError("Zotero translate failed (%s): %s" % (engine, last))

    g.GoogleTranslator.__init__ = __init__
    g.GoogleTranslator.do_translate = do_translate


# Must run at import time, not inside main(): pdf2zh_next translates in a *spawned* subprocess,
# which re-imports this file as __mp_main__ and never calls main(). Patching here makes the
# child use the Zotero bridge too; otherwise it silently falls back to the real Google translator.
# (Re-layout mode has no bridge and needs no translator.)
if os.environ.get("CLITRANS_TRANSLATE_URL"):
    patch_translator()


def emit(d):
    sys.stdout.write("@@P " + json.dumps(d, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def compose(orig_path, mono_path, layout, out_path):
    """Bilingual PDF from the original and the translated ("mono") PDF.
    side: original left, translation right · stacked: original on top, translation below ·
    alternate: one original page, then its translation."""
    import pymupdf

    src = pymupdf.open(orig_path)
    tr = pymupdf.open(mono_path)
    doc = pymupdf.open()
    for i in range(min(len(src), len(tr))):
        if layout == "alternate":
            doc.insert_pdf(src, from_page=i, to_page=i)
            doc.insert_pdf(tr, from_page=i, to_page=i)
            continue
        r = src[i].rect
        w, h = r.width, r.height
        grey = (0.6, 0.6, 0.6)
        if layout == "stacked":
            page = doc.new_page(width=w, height=h * 2)
            page.show_pdf_page(pymupdf.Rect(0, 0, w, h), src, i)
            page.show_pdf_page(pymupdf.Rect(0, h, w, h * 2), tr, i)
            page.draw_line((0, h), (w, h), color=grey, width=0.5)
        else:
            page = doc.new_page(width=w * 2, height=h)
            page.show_pdf_page(pymupdf.Rect(0, 0, w, h), src, i)
            page.show_pdf_page(pymupdf.Rect(w, 0, w * 2, h), tr, i)
            page.draw_line((w, 0), (w, h), color=grey, width=0.5)
    doc.save(out_path, garbage=4, deflate=True)
    doc.close()
    src.close()
    tr.close()


def relayout(argv):
    if len(argv) != 4 or argv[2] not in LAYOUT_SUFFIX:
        emit({"error": "usage: --relayout <original.pdf> <mono.pdf> <side|stacked|alternate> <out.pdf>"})
        return 2
    try:
        compose(argv[0], argv[1], argv[2], argv[3])
    except Exception as e:  # noqa: BLE001
        emit({"error": "%s: %s" % (type(e).__name__, e)})
        return 1
    emit({"done": True, "dual": argv[3]})
    return 0


async def main():
    logging.basicConfig(level=logging.WARNING, stream=sys.stderr)
    if len(sys.argv) > 1 and sys.argv[1] == "--relayout":
        return relayout(sys.argv[2:])
    if not os.environ.get("CLITRANS_TRANSLATE_URL"):
        emit({"error": "CLITRANS_TRANSLATE_URL missing"})
        return 2
    sys.argv = ["pdf2zh_next"] + sys.argv[1:]
    from pdf2zh_next.config import ConfigManager
    from pdf2zh_next.high_level import do_translate_async_stream

    layout = os.environ.get("CLITRANS_LAYOUT", "side")
    settings = ConfigManager().initialize_config()
    files = list(settings.basic.input_files)
    settings.basic.input_files = set()
    if not files:
        emit({"error": "no input file"})
        return 2
    for f in files:
        async for ev in do_translate_async_stream(settings, f):
            t = ev.get("type")
            if t in ("progress_start", "progress_update", "progress_end"):
                emit({
                    "p": ev.get("overall_progress"),
                    "stage": ev.get("stage"),
                    "part": ev.get("part_index"),
                    "parts": ev.get("total_parts"),
                    "cur": ev.get("stage_current"),
                    "tot": ev.get("stage_total"),
                })
            elif t == "finish":
                r = ev["translate_result"]
                mono = str(r.mono_pdf_path or "")
                dual = ""
                if mono and layout in LAYOUT_SUFFIX:
                    emit({"p": 99, "stage": "Compose layout"})
                    out = mono[: -len(".mono.pdf")] if mono.lower().endswith(".mono.pdf") else mono[:-4]
                    out += "." + LAYOUT_SUFFIX[layout] + ".pdf"
                    try:
                        compose(str(f), mono, layout, out)
                        dual = out
                    except Exception as e:  # noqa: BLE001
                        emit({"warn": "%s: %s" % (type(e).__name__, e)})
                emit({"done": True, "mono": mono, "dual": dual})
            elif t == "error":
                emit({"error": str(ev.get("error", "")), "details": str(ev.get("details", ""))[-1500:]})
                return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
