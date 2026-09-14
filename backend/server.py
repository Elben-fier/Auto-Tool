"""短剧审核自动识别勾选工具 — 本地 HTTP 后端服务"""

import logging
import traceback
import time
import os
import base64

import cv2
import numpy as np

from flask import Flask, request, jsonify, make_response

from task_queue import TaskQueue
from detector import FaceDetector, image_similarity

app = Flask(__name__)

@app.after_request
def add_cors_headers(resp):
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Methods"] = "GET,POST,OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return resp

task_queue = TaskQueue(rate_limit=4.5, max_pending=100)
face_detector = FaceDetector()

logging.basicConfig(level=logging.INFO, format="[%(levelname)s] %(asctime)s %(message)s")
logger = logging.getLogger("review-server")


# ---------------------------------------------------------------------------
# 调试工具：保存检测失败的截图（最多保留 10 张）
# ---------------------------------------------------------------------------
_debug_fail_count = 0
_debug_max_count = 10

def _save_debug_screenshot(left, top, width, height, tag):
    global _debug_fail_count
    _debug_fail_count += 1
    if _debug_fail_count > _debug_max_count:
        return
    try:
        import mss as mss_lib
        import numpy as np
        from PIL import Image
        abs_left = int(left)
        abs_top = int(top)
        abs_width = max(1, int(width))
        abs_height = max(1, int(height))
        with mss_lib.mss() as sct:
            monitor = {
                "left": abs_left,
                "top": abs_top,
                "width": abs_width,
                "height": abs_height,
            }
            screenshot = sct.grab(monitor)
            img = np.array(screenshot, dtype=np.uint8)
            pil_img = Image.fromarray(img)
        save_dir = os.path.dirname(os.path.abspath(__file__))
        ts = int(time.time() * 1000)
        save_path = os.path.join(save_dir, f"debug_{tag}_{ts}.png")
        pil_img.save(save_path)
        logger.info("调试截图已保存: %s (%dx%d)", save_path, abs_width, abs_height)
    except Exception:
        logger.error("保存调试截图失败:\n%s", traceback.format_exc())


# ---------------------------------------------------------------------------
# 路由
# ---------------------------------------------------------------------------

@app.route("/health", methods=["GET", "POST", "OPTIONS"])
def health():
    if request.method == "OPTIONS":
        return make_response("", 204)
    return jsonify({"status": "ok"})


@app.route("/detect", methods=["POST", "OPTIONS"])
def detect_face():
    if request.method == "OPTIONS":
        return make_response("", 204)

    if task_queue.is_full:
        logger.warning("任务队列已满，返回 429")
        return jsonify({"error": "队列已满"}), 429

    data = request.get_json(silent=True)
    if not data:
        return jsonify({"error": "请求体为空"}), 400

    left = data.get("left")
    top = data.get("top")
    width = data.get("width")
    height = data.get("height")

    if any(v is None for v in [left, top, width, height]):
        return jsonify({"error": "缺少必要参数"}), 400

    if width <= 0 or height <= 0:
        return jsonify({"hasFace": False})

    if not task_queue.acquire():
        return jsonify({"error": "队列已满"}), 429

    try:
        has_face = face_detector.detect(left, top, width, height)
        logger.info("人脸检测: (%d,%d %dx%d) → %s", left, top, width, height, has_face)
        if not has_face:
            _save_debug_screenshot(left, top, width, height, "fail")
        return jsonify({"hasFace": has_face})
    except Exception:
        logger.error("人脸检测异常:\n%s", traceback.format_exc())
        return jsonify({"hasFace": False})
    finally:
        task_queue.release()


@app.route("/detect_batch", methods=["POST", "OPTIONS"])
def detect_batch():
    if request.method == "OPTIONS":
        return make_response("", 204)

    if task_queue.is_full:
        logger.warning("任务队列已满，返回 429")
        return jsonify({"error": "队列已满"}), 429

    data = request.get_json(silent=True)
    if not data:
        return jsonify({"error": "请求体为空"}), 400

    images = data.get("images")
    if not isinstance(images, list) or len(images) == 0:
        return jsonify({"error": "缺少 images 参数"}), 400

    # 说明：限速按「图片张数」计数（4 张/秒），而不是按请求计数，
    # 否则一批 3 张只花 1 个名额，实际速度会失控/或反而被批次延迟拖慢。
    results = []
    for b64 in images:
        if not task_queue.acquire():
            results.append(False)
            continue
        try:
            if not b64:
                results.append(False)
                continue
            img_bytes = base64.b64decode(b64)
            nparr = np.frombuffer(img_bytes, np.uint8)
            img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
            if img is None:
                results.append(False)
            else:
                results.append(face_detector.detect_image(img))
        except Exception:
            logger.error("单张检测异常:\n%s", traceback.format_exc())
            results.append(False)
        finally:
            task_queue.release()

    logger.info("批量人脸检测: %d 张 → 命中 %d", len(images), sum(1 for r in results if r))
    return jsonify({"results": results})


@app.route("/detect_batch_detail", methods=["POST", "OPTIONS"])
def detect_batch_detail():
    """
    明细版批量检测（供"勾选版"脚本使用，/detect_batch 行为保持不变）：
      请求: {"images": [base64, ...], "person_conf": 0.35, "object_conf": 0.55}
            （person_conf / object_conf 可选，前端面板可调阈值；不传则用后端默认）
      响应: {"results": [{"person":bool,"face":bool,"phone":bool,"screen":bool,"ok":bool,"conf":{...}}, ...]}
        ok = 有人 且 未检出手机 且 未检出屏幕  → 该样本判为"正确"
    """
    if request.method == "OPTIONS":
        return make_response("", 204)

    if task_queue.is_full:
        logger.warning("任务队列已满，返回 429")
        return jsonify({"error": "队列已满"}), 429

    data = request.get_json(silent=True)
    if not data:
        return jsonify({"error": "请求体为空"}), 400

    images = data.get("images")
    if not isinstance(images, list) or len(images) == 0:
        return jsonify({"error": "缺少 images 参数"}), 400

    def _opt_float(key):
        v = data.get(key)
        try:
            return float(v) if v is not None else None
        except (TypeError, ValueError):
            return None

    person_conf = _opt_float("person_conf")
    object_conf = _opt_float("object_conf")

    results = []
    for b64 in images:
        if not task_queue.acquire():
            results.append({"person": False, "face": False, "phone": False,
                            "screen": False, "ok": False,
                            "conf": {"person": 0.0, "phone": 0.0, "screen": 0.0}})
            continue
        try:
            if not b64:
                results.append({"person": False, "face": False, "phone": False,
                                "screen": False, "ok": False,
                                "conf": {"person": 0.0, "phone": 0.0, "screen": 0.0}})
                continue
            img_bytes = base64.b64decode(b64)
            nparr = np.frombuffer(img_bytes, np.uint8)
            img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
            if img is None:
                results.append({"person": False, "face": False, "phone": False,
                                "screen": False, "ok": False,
                                "conf": {"person": 0.0, "phone": 0.0, "screen": 0.0}})
            else:
                results.append(face_detector.detect_detail(img, person_conf=person_conf, object_conf=object_conf))
        except Exception:
            logger.error("单张明细检测异常:\n%s", traceback.format_exc())
            results.append({"person": False, "face": False, "phone": False,
                            "screen": False, "ok": False,
                            "conf": {"person": 0.0, "phone": 0.0, "screen": 0.0}})
        finally:
            task_queue.release()

    n_ok = sum(1 for r in results if r.get("ok"))
    n_phone = sum(1 for r in results if r.get("phone"))
    n_screen = sum(1 for r in results if r.get("screen"))
    n_person = sum(1 for r in results if r.get("person"))
    logger.info("批量明细检测: %d 张 (person_conf=%s, object_conf=%s) → 合格 %d / 有人 %d / 手机 %d / 屏幕 %d",
                len(images),
                "默认" if person_conf is None else person_conf,
                "默认" if object_conf is None else object_conf,
                n_ok, n_person, n_phone, n_screen)
    return jsonify({"results": results})


@app.route("/compare", methods=["POST", "OPTIONS"])
def compare_images():
    """
    两两图片相似度（第5列 vs 第6列）：
      请求: {"pairs": [{"a": base64, "b": base64}, ...]}
      响应: {"results": [{"ok":bool,"sim":0~1,"hash":..,"hist":..,"aspect":..}, ...]}
    """
    if request.method == "OPTIONS":
        return make_response("", 204)

    if task_queue.is_full:
        logger.warning("任务队列已满，返回 429")
        return jsonify({"error": "队列已满"}), 429

    data = request.get_json(silent=True)
    if not data:
        return jsonify({"error": "请求体为空"}), 400

    pairs = data.get("pairs")
    if not isinstance(pairs, list) or len(pairs) == 0:
        return jsonify({"error": "缺少 pairs 参数"}), 400

    def _decode(b64):
        if not b64:
            return None
        try:
            img_bytes = base64.b64decode(b64)
            nparr = np.frombuffer(img_bytes, np.uint8)
            return cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        except Exception:
            return None

    results = []
    for pair in pairs:
        if not task_queue.acquire():
            results.append({"ok": False, "sim": 0.0, "hash": 0.0, "hist": 0.0, "aspect": 0.0})
            continue
        try:
            a = _decode(pair.get("a") if isinstance(pair, dict) else None)
            b = _decode(pair.get("b") if isinstance(pair, dict) else None)
            results.append(image_similarity(a, b))
        except Exception:
            logger.error("相似度计算异常:\n%s", traceback.format_exc())
            results.append({"ok": False, "sim": 0.0, "hash": 0.0, "hist": 0.0, "aspect": 0.0})
        finally:
            task_queue.release()

    ok_sims = [r["sim"] for r in results if r.get("ok")]
    if ok_sims:
        logger.info("相似度比对: %d 对 → 最低 %.3f / 平均 %.3f / 最高 %.3f",
                    len(ok_sims), min(ok_sims), sum(ok_sims) / len(ok_sims), max(ok_sims))
    else:
        logger.info("相似度比对: %d 对 → 全部解码失败", len(pairs))
    return jsonify({"results": results})


@app.route("/debug_screenshot", methods=["POST", "OPTIONS"])
def debug_screenshot():
    if request.method == "OPTIONS":
        return make_response("", 204)

    data = request.get_json(silent=True)
    if not data:
        return jsonify({"error": "请求体为空"}), 400

    left = data.get("left")
    top = data.get("top")
    width = data.get("width")
    height = data.get("height")

    if any(v is None for v in [left, top, width, height]):
        return jsonify({"error": "缺少必要参数"}), 400

    if not task_queue.acquire():
        return jsonify({"error": "队列已满"}), 429

    try:
        import mss as mss_lib
        import numpy as np
        from PIL import Image

        abs_left = int(left)
        abs_top = int(top)
        abs_width = max(1, int(width))
        abs_height = max(1, int(height))

        with mss_lib.mss() as sct:
            monitor = {
                "left": abs_left,
                "top": abs_top,
                "width": abs_width,
                "height": abs_height,
            }
            screenshot = sct.grab(monitor)
            img = np.array(screenshot, dtype=np.uint8)
            pil_img = Image.fromarray(img)

        save_dir = os.path.dirname(os.path.abspath(__file__))
        ts = int(time.time() * 1000)
        save_path = os.path.join(save_dir, f"debug_screenshot_{ts}.png")
        pil_img.save(save_path)

        logger.info("调试截图已保存: %s", save_path)
        return jsonify({"saved": save_path, "size": [abs_width, abs_height]})
    except Exception as e:
        logger.error("调试截图异常: %s", traceback.format_exc())
        return jsonify({"error": str(e)}), 500
    finally:
        task_queue.release()


# ---------------------------------------------------------------------------
if __name__ == "__main__":
    print("=" * 60)
    print("  短剧审核自动识别勾选工具 — 后端服务")
    print("  监听地址: http://127.0.0.1:5002")
    print("  速率限制: 4.5 张/秒（按图片张数计数，非按请求）")
    print("  检测模型: YOLOv8n(person) + YuNet(人脸兜底)  [离线]")
    print("=" * 60)
    app.run(host="127.0.0.1", port=5002, threaded=False)
