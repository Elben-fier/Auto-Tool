# 本地后端 — 人像检测 / 图片相似度服务

审核脚本依赖的本地 HTTP 服务，全部在本机完成推理（`http://127.0.0.1:5002`），**不上传任何图片或文本数据**。

## 1. 运行环境与依赖

- Python 3.10（Windows）
- 依赖安装：`pip install -r requirements.txt`

| 依赖 | 用途 |
|---|---|
| flask | HTTP 服务 |
| opencv-python | 图像解码、YuNet 人脸检测、HOG 兜底、图像处理 |
| numpy | 数值计算 |
| onnxruntime | YOLOv8n ONNX 推理（纯 CPU，无需 torch） |
| mss / pywin32 / Pillow | 按屏幕坐标截屏（`/detect`、`/debug_screenshot`） |

## 2. 模型文件（仓库不包含，需自行准备）

| 文件 | 用途 | 获取方式 |
|---|---|---|
| `face_detection_yunet_2023mar.onnx` | 人脸检测（正脸/侧脸/脸部特写） | OpenCV 官方模型库（约 230 KB）<br>`https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx` |
| `yolov8n.onnx` | 人物 / 手机 / 屏幕 检测（COCO 80 类） | Ultralytics 官方**未直接发布 onnx**，需从 `yolov8n.pt` 导出（约 12.5 MB），见下 |

### 导出 yolov8n.onnx

```bash
pip install ultralytics

# 1) 下载官方权重（国内网络可加镜像前缀，例如 https://gh-proxy.com/ 拼在 github 链接前）
curl -L -o yolov8n.pt https://github.com/ultralytics/assets/releases/download/v8.2.0/yolov8n.pt

# 2) 导出 onnx（CPU 即可，约 1~2 分钟）
python -c "from ultralytics import YOLO; YOLO('yolov8n.pt').export(format='onnx', imgsz=640, opset=12, dynamic=False)"
```

把生成的 `yolov8n.onnx` 与本目录的 YuNet 模型一起放到 `backend/` 下即可，程序启动时自动加载。

> 说明：找不 `yolov8n.onnx` 时程序会**自动降级**为 OpenCV 内置 HOG 行人检测（精度较低，无手机/屏幕识别），仍可运行；放入该文件即自动切回 YOLO 模式。

## 3. 启动

```bash
cd backend
python server.py      # 或双击 run.bat（会自动安装依赖）
```

启动成功时会打印：

```
[detector] YOLOv8n.onnx 加载成功（YOLO 模式）
  监听地址: http://127.0.0.1:5002
  速率限制: 4.5 张/秒（按图片张数计数，非按请求）
```

健康检查：浏览器访问 <http://127.0.0.1:5002/health> 返回 `{"status":"ok"}`。
**该窗口不要关闭**（可最小化），关闭后脚本所有请求都会失败。

## 4. 接口一览

| 接口 | 方法 | 说明 |
|---|---|---|
| `/health` | GET/POST | 健康检查 |
| `/detect` | POST | 按屏幕坐标截屏 + 人像检测 → `{"hasFace": bool}` |
| `/detect_batch` | POST | base64 图片批量人像检测 → `{"results": [bool, ...]}`（兼容旧脚本） |
| `/detect_batch_detail` | POST | 批量**明细**检测（人物/人脸/手机/屏幕 + 置信度，阈值可由前端传入） |
| `/compare` | POST | 两两图片相似度（第5列 vs 第6列） |
| `/debug_screenshot` | POST | 调试：按坐标截屏存盘 |

字段与算法细节见 [../docs/后端接口与算法说明.md](../docs/后端接口与算法说明.md)。

## 5. 可调阈值（`detector.py` 顶部）

| 常量 | 默认值 | 说明 |
|---|---|---|
| `PERSON_CONF` | 0.35 | YOLO person 置信度阈值（前端可用 `person_conf` 覆盖） |
| `FACE_CONF` | 0.55 | YuNet 人脸置信度阈值 |
| `OBJECT_CONF` | 0.25 | 手机/屏幕**候选上报**阈值；真正判定阈值由前端 `object_conf` 决定（脚本面板默认 0.55） |
| `SIM_W_SSIM / HASH16 / HASH8 / HIST / ASPECT` | 0.50 / 0.25 / 0.15 / 0.05 / 0.05 | 相似度加权系数 |

判错/判正的完整规则由前端脚本控制（见 `../docs/版本演进记录.md`）。
