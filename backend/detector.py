import ctypes
import sys
import os

import cv2
import numpy as np
import win32gui
import mss
import onnxruntime


# 设置 DPI 感知，确保坐标映射准确
if sys.platform == "win32":
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)  # PROCESS_PER_MONITOR_DPI_AWARE
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass

MODEL_DIR = os.path.dirname(os.path.abspath(__file__))
YOLO_ONNX_PATH = os.path.join(MODEL_DIR, "yolov8n.onnx")
YUNET_ONNX_PATH = os.path.join(MODEL_DIR, "face_detection_yunet_2023mar.onnx")

# ---- 判定阈值（可按实际图片情况调整）----
PERSON_CONF = 0.35   # YOLO person 类(人/背影/侧身)置信度默认阈值（前端可通过 person_conf 覆盖）
FACE_CONF = 0.55     # YuNet 人脸(正脸/侧脸/眼部特写)置信度阈值
YOLO_IMGSZ = 640     # YOLO 输入尺寸
# 手机/屏幕类：后端只做"候选上报"（默认阈值较松 0.25），
# 真正判定阈值由前端传 object_conf 决定（脚本面板默认 0.55，避免"疑似手机屏幕"被误判）
OBJECT_CONF = 0.25
PHONE_CLASS = 67     # COCO 类别：cell phone（手机）
SCREEN_CLASSES = (62, 63)  # COCO 类别：tv（电视/显示器屏幕）、laptop（笔记本屏幕）

# ---- 图片相似度权重（第5列 vs 第6列）----
# 实测：同图变体(缩放/压缩/亮度/轻裁剪) ≥0.83；完全不同两张图 ≤0.33 → 阈值 0.60 可干净区分
SIM_W_SSIM = 0.50    # SSIM 结构相似度权重（对内容差异最灵敏）
SIM_W_HASH16 = 0.25  # 16x16 dHash 权重
SIM_W_HASH8 = 0.15   # 8x8 dHash 权重
SIM_W_HIST = 0.05    # HSV 颜色直方图权重
SIM_W_ASPECT = 0.05  # 宽高比一致性权重


def _dhash(gray, hash_size=8):
    """差值哈希：返回布尔数组（长度 hash_size*hash_size）"""
    resized = cv2.resize(gray, (hash_size + 1, hash_size), interpolation=cv2.INTER_AREA)
    diff = resized[:, 1:] > resized[:, :-1]
    return diff.flatten()


def _hsv_hist(img_bgr):
    """H-S 二维直方图（已归一化）"""
    hsv = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2HSV)
    hist = cv2.calcHist([hsv], [0, 1], None, [32, 32], [0, 180, 0, 256])
    cv2.normalize(hist, hist)
    return hist


def _ssim(gray_a, gray_b, size=(64, 64)):
    """SSIM 结构相似度（纯 opencv/numpy 实现，无需 scikit-image）"""
    a = cv2.resize(gray_a, size, interpolation=cv2.INTER_AREA).astype(np.float64)
    b = cv2.resize(gray_b, size, interpolation=cv2.INTER_AREA).astype(np.float64)
    c1, c2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    k, sig = (11, 11), 1.5
    mu_a, mu_b = cv2.GaussianBlur(a, k, sig), cv2.GaussianBlur(b, k, sig)
    mu_a2, mu_b2, mu_ab = mu_a * mu_a, mu_b * mu_b, mu_a * mu_b
    sig_a2 = cv2.GaussianBlur(a * a, k, sig) - mu_a2
    sig_b2 = cv2.GaussianBlur(b * b, k, sig) - mu_b2
    sig_ab = cv2.GaussianBlur(a * b, k, sig) - mu_ab
    m = ((2 * mu_ab + c1) * (2 * sig_ab + c2)) / ((mu_a2 + mu_b2 + c1) * (sig_a2 + sig_b2 + c2))
    return float(m.mean())


def image_similarity(img_a, img_b):
    """
    两张图片的相似度（0~1，越大越像）：
      ssim   = SSIM 结构相似度（对内容差异最灵敏）
      hash16 = 16x16 dHash 一致率
      hash8  = 8x8 dHash 一致率
      hist   = HSV H-S 直方图相关性
      aspect = 宽高比一致性
      sim    = 0.50*ssim + 0.25*hash16 + 0.15*hash8 + 0.05*hist + 0.05*aspect
    返回 {ok, sim, ssim, hash8, hash16, hist, aspect}
    """
    empty = {"ok": False, "sim": 0.0, "ssim": 0.0, "hash8": 0.0, "hash16": 0.0,
             "hist": 0.0, "aspect": 0.0}
    if img_a is None or img_b is None or img_a.size == 0 or img_b.size == 0:
        return empty
    try:
        ga = cv2.cvtColor(img_a, cv2.COLOR_BGR2GRAY)
        gb = cv2.cvtColor(img_b, cv2.COLOR_BGR2GRAY)

        h8 = 1.0 - float(np.count_nonzero(_dhash(ga, 8) != _dhash(gb, 8))) / 64.0
        h16 = 1.0 - float(np.count_nonzero(_dhash(ga, 16) != _dhash(gb, 16))) / 256.0

        hist = float(cv2.compareHist(_hsv_hist(img_a), _hsv_hist(img_b), cv2.HISTCMP_CORREL))
        hist = max(0.0, min(1.0, (hist + 1.0) / 2.0))

        ra = img_a.shape[1] / max(1, img_a.shape[0])
        rb = img_b.shape[1] / max(1, img_b.shape[0])
        aspect = min(ra, rb) / max(ra, rb)

        s = _ssim(ga, gb)

        sim = (SIM_W_SSIM * s + SIM_W_HASH16 * h16 + SIM_W_HASH8 * h8 +
               SIM_W_HIST * hist + SIM_W_ASPECT * aspect)
        return {
            "ok": True,
            "sim": round(float(sim), 4),
            "ssim": round(float(s), 4),
            "hash8": round(float(h8), 4),
            "hash16": round(float(h16), 4),
            "hist": round(float(hist), 4),
            "aspect": round(float(aspect), 4),
        }
    except Exception:
        return empty


def _letterbox(img, size):
    """等比缩放 + 灰边填充到 size×size，返回 (blob图, ratio)"""
    h, w = img.shape[:2]
    r = min(size / w, size / h)
    nw, nh = int(round(w * r)), int(round(h * r))
    resized = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_LINEAR)
    canvas = np.full((size, size, 3), 114, dtype=np.uint8)
    dx, dy = (size - nw) // 2, (size - nh) // 2
    canvas[dy:dy + nh, dx:dx + nw] = resized
    return canvas, r


class FaceDetector:
    """
    人像内容检测器（v2.1，YOLO(可选) + HOG兜底 + YuNet 三级判定）：
      图片中出现以下任一情况 → 视为"有人/正确数据"：
        1) person 检测命中（覆盖：全身/背影/侧身/大半身人物）
        2) YuNet 检测到人脸（覆盖：正面/侧脸/脸部特写/眼部为主的画面；加水平翻转兜底）
      其余（手机、风景、纯文字、空画面等）→ "无人/错误数据"。

    person 检测自动降级：
      - 目录下有 yolov8n.onnx（COCO 预训练 YOLOv8n）→ 用 YOLO，精度最高；
      - 没有该文件 → 自动退回 OpenCV HOG 行人检测（opencv 内置，无需模型文件）。
    语义说明：判定 True = 画面含真人相关内容；运行完全离线。
    """

    def __init__(self):
        # ---------- person 检测：优先 YOLOv8n(onnx)，否则 HOG ----------
        self._yolo = None
        self._hog = None
        if os.path.exists(YOLO_ONNX_PATH):
            try:
                self._yolo = onnxruntime.InferenceSession(
                    YOLO_ONNX_PATH, providers=["CPUExecutionProvider"])
                self._inp_name = self._yolo.get_inputs()[0].name
                self._out_name = self._yolo.get_outputs()[0].name
                in_shape = self._yolo.get_inputs()[0].shape
                size = int(in_shape[-1]) if in_shape and in_shape[-1] else YOLO_IMGSZ
                self._size = size
                print("[detector] YOLOv8n.onnx 加载成功（YOLO 模式）")
            except Exception as e:
                print("[detector] YOLO 加载失败，退回 HOG:", e)
                self._yolo = None
        if self._yolo is None:
            self._hog = cv2.HOGDescriptor()
            self._hog.setSVMDetector(cv2.HOGDescriptor_getDefaultPeopleDetector())
            print("[detector] 未找到 yolov8n.onnx，使用 HOG 行人检测（放入该文件可自动切换 YOLO）")

        # ---------- YuNet 人脸 (OpenCV DNN) ----------
        if not os.path.exists(YUNET_ONNX_PATH):
            raise FileNotFoundError(
                "未找到 YuNet 模型: %s\n请将 face_detection_yunet_2023mar.onnx 放到后端目录"
                % YUNET_ONNX_PATH)
        self._yunet = cv2.FaceDetectorYN.create(
            YUNET_ONNX_PATH, "", (320, 320), FACE_CONF, 0.3, 5000)
        self._yunet.setScoreThreshold(FACE_CONF)

    # ---------------- 1. person 检测（YOLO 优先，HOG 兜底） ----------------
    def _yolo_class_scores(self, img_bgr):
        """跑一次 YOLO，返回 {类别id: 该类最大置信度}（只保留 >= 0.15 的类别）"""
        if self._yolo is None:
            return {}
        try:
            blob, _ = _letterbox(img_bgr, self._size)
            blob = cv2.cvtColor(blob, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
            blob = blob.transpose(2, 0, 1)[None, ...]  # 1,3,H,W
            out = self._yolo.run([self._out_name], {self._inp_name: blob})[0]
            preds = np.asarray(out)
            if preds.ndim == 3:
                preds = preds[0]                      # (84, 8400)
            if preds.shape[0] < preds.shape[1]:
                preds = preds.T                       # → (8400, 84)：4xywh + 80cls
            if preds.size == 0:
                return {}
            cls_scores = preds[:, 4:]
            cls_ids = cls_scores.argmax(axis=1)
            confs = cls_scores.max(axis=1)
            keep = confs >= 0.15
            result = {}
            for cid, cf in zip(cls_ids[keep], confs[keep]):
                cid = int(cid)
                cf = float(cf)
                if cf > result.get(cid, 0.0):
                    result[cid] = cf
            return result
        except Exception:
            return {}

    def _yolo_person_conf(self, img_bgr):
        """返回图中 person 类的最大置信度（无 person 返回 0.0）"""
        return self._yolo_class_scores(img_bgr).get(0, 0.0)

    def _yolo_has_person(self, img_bgr):
        return self._yolo_person_conf(img_bgr) >= PERSON_CONF

    def _hog_has_person(self, img_bgr):
        if self._hog is None:
            return False
        try:
            gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
            # 图片过小放大后再检测，提升小人物检出率
            if gray.shape[1] < 200:
                gray = cv2.resize(gray, None, fx=2, fy=2, interpolation=cv2.INTER_LINEAR)
            boxes, _ = self._hog.detectMultiScale(
                gray, winStride=(8, 8), padding=(8, 8), scale=1.05)
            return boxes is not None and len(boxes) > 0
        except Exception:
            return False

    # ---------------- 2. YuNet 人脸检测（含水平翻转兜底） ----------------
    def _yunet_has_face(self, img_bgr):
        try:
            h, w = img_bgr.shape[:2]
            if h <= 0 or w <= 0:
                return False
            self._yunet.setInputSize((w, h))
            _, faces = self._yunet.detect(img_bgr)
            if faces is not None and len(faces) > 0:
                return True
            # 水平翻转再来一次：提高侧脸/偏脸检出率
            flipped = cv2.flip(img_bgr, 1)
            _, faces2 = self._yunet.detect(flipped)
            return faces2 is not None and len(faces2) > 0
        except Exception:
            return False

    # ---------------- 对外接口（与旧版保持一致） ----------------
    def detect(self, left, top, width, height):
        """检测指定屏幕区域是否包含人像内容（参数为屏幕绝对物理像素坐标）"""
        abs_left = int(left)
        abs_top = int(top)
        abs_width = max(1, int(width))
        abs_height = max(1, int(height))
        try:
            with mss.mss() as sct:
                monitor = {
                    "left": abs_left, "top": abs_top,
                    "width": abs_width, "height": abs_height,
                }
                screenshot = sct.grab(monitor)
                img = np.array(screenshot, dtype=np.uint8)
                if img.shape[2] == 4:
                    img = cv2.cvtColor(img, cv2.COLOR_BGRA2BGR)
                else:
                    img = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
        except Exception:
            return False
        return self.detect_image(img)

    def detect_image(self, img_bgr):
        """对内存中的 BGR 图片直接判定：person(YOLO→HOG) 优先，未中再 YuNet 人脸兜底"""
        if img_bgr is None or img_bgr.size == 0:
            return False
        # 1) person 检测（背影/全身/大半身人物）——YOLO 有则用，无则 HOG
        if self._yolo is not None:
            if self._yolo_has_person(img_bgr):
                return True
        else:
            if self._hog_has_person(img_bgr):
                return True
        # 2) 人脸兜底（脸部特写/侧脸/眼部为主的画面）
        return self._yunet_has_face(img_bgr)

    def detect_detail(self, img_bgr, person_conf=None, object_conf=None):
        """
        明细判定（供前端"勾选版"使用）：
          person_conf / object_conf：可选覆盖阈值（前端面板可调，不传则用模块默认）
        返回：
          {
            person: bool,   # 有人物（person 检测 或 人脸兜底）
            face:   bool,   # 仅人脸模型命中的情况
            phone:  bool,   # 检测到手机（按 object_conf 判定）
            screen: bool,   # 检测到屏幕（电视/显示器/笔记本，按 object_conf 判定）
            ok:     bool,   # 合格画面 = 有人 且 无手机 且 无屏幕
            conf: {person, phone, screen}  # 原始置信度（0~1），便于调阈值/核对
          }
        """
        empty = {
            "person": False, "face": False, "phone": False, "screen": False,
            "ok": False, "conf": {"person": 0.0, "phone": 0.0, "screen": 0.0},
        }
        if img_bgr is None or img_bgr.size == 0:
            return empty

        thr_person = PERSON_CONF if person_conf is None else float(person_conf)
        thr_object = OBJECT_CONF if object_conf is None else float(object_conf)

        scores = self._yolo_class_scores(img_bgr)
        person_conf_val = scores.get(0, 0.0)
        phone_conf = scores.get(PHONE_CLASS, 0.0)
        screen_conf = max([scores.get(c, 0.0) for c in SCREEN_CLASSES] or [0.0])

        person = person_conf_val >= thr_person
        face_only = False
        if not person:
            # 只在 YOLO 没检出人时才跑人脸兜底，节省时间
            if self._yunet_has_face(img_bgr):
                person = True
                face_only = True
            elif self._yolo is None and self._hog_has_person(img_bgr):
                person = True

        phone = phone_conf >= thr_object
        screen = screen_conf >= thr_object
        return {
            "person": bool(person),
            "face": bool(face_only),
            "phone": bool(phone),
            "screen": bool(screen),
            "ok": bool(person and not phone and not screen),
            "conf": {
                "person": round(float(person_conf_val), 3),
                "phone": round(float(phone_conf), 3),
                "screen": round(float(screen_conf), 3),
            },
        }
