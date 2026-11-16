"""Verso — check (and with --warmup, complete) the environment used by 整篇翻译.

Prints one line: "@@S {json}". Runs on macOS, Windows and Linux with the pdf2zh_next Python.
"""
import importlib
import json
import shutil
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass

FONT = "SourceHanSerifCN-Regular.ttf"
MODEL = "doclayout_yolo_docstructbench_imgsz1024.onnx"


def has(mod):
    try:
        importlib.import_module(mod)
        return True
    except Exception:  # noqa: BLE001
        return False


def main():
    warm = "--warmup" in sys.argv
    out = {"python": sys.executable, "version": sys.version.split()[0], "platform": sys.platform}
    for m in ("pymupdf", "babeldoc", "pdf2zh_next", "matplotlib", "rapidfuzz", "onnxruntime"):
        out[m] = has(m)
    if sys.platform == "darwin" and shutil.which("xcrun"):
        out["ocr"] = "vision"  # macOS Vision via the bundled Swift helper
    elif has("rapidocr_onnxruntime"):
        out["ocr"] = "rapidocr"
    else:
        out["ocr"] = None
    try:
        from babeldoc.const import get_cache_file_path

        font = get_cache_file_path(FONT, "fonts")
        model = get_cache_file_path(MODEL, "models")
        if warm and not font.exists():
            from babeldoc.assets.assets import get_font_and_metadata

            get_font_and_metadata(FONT)
        if warm and not model.exists():
            from babeldoc.assets.assets import get_doclayout_onnx_model_path

            get_doclayout_onnx_model_path()
        out["font"] = font.exists()
        out["model"] = model.exists()
    except Exception as e:  # noqa: BLE001
        out["font"] = out["model"] = False
        out["asset_error"] = str(e)[:300]
    print("@@S " + json.dumps(out, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
