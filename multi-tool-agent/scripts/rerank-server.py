#!/usr/bin/env python
"""本地 cross-encoder rerank 服务（供 src/knowledge/httpReranker.ts 调用）

启动（Windows PowerShell）：
    $env:KMP_DUPLICATE_LIB_OK='TRUE'
    python scripts/rerank-server.py --model D:\\bge-reranker\\model --port 8930

接口：
    GET  /health   -> {"ok": true, "model": "...", "device": "cpu"}
    POST /rerank   -> {"scores": [0.93, 0.02, ...], "latencyMs": 41}
         body: {"query": "...", "passages": ["...", "..."]}

设计约束：
  - 只在本机回环上监听（127.0.0.1），不对外暴露；
  - 打分与 passages 顺序一一对应，调用方负责把分数映射回候选 id；
  - 不做任何持久化，模型在进程内常驻（冷启动约 9s）。
"""
import argparse
import os
import time

# anaconda + torch 常见 OMP 冲突：必须在 import torch 之前设置
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
# 模型已下载到本地目录，禁止联网检查
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

from flask import Flask, jsonify, request  # noqa: E402
from sentence_transformers import CrossEncoder  # noqa: E402

app = Flask(__name__)

MODEL = None
MODEL_NAME = ""
DEVICE = "cpu"
MAX_LEN = 512
BATCH = 16


@app.route("/health", methods=["GET"])
def health():
    return jsonify(ok=MODEL is not None, model=MODEL_NAME, device=DEVICE, maxLength=MAX_LEN)


@app.route("/rerank", methods=["POST"])
def rerank():
    if MODEL is None:
        return jsonify(error="model not loaded"), 503
    body = request.get_json(force=True, silent=True) or {}
    query = (body.get("query") or "").strip()
    passages = body.get("passages") or []
    if not query or not isinstance(passages, list) or not passages:
        return jsonify(error="need non-empty query and passages[]"), 400
    if len(passages) > 256:
        return jsonify(error="too many passages (max 256)"), 400

    t0 = time.time()
    scores = MODEL.predict(
        [(query, str(p)) for p in passages],
        batch_size=BATCH,
        show_progress_bar=False,
    )
    latency = int((time.time() - t0) * 1000)
    return jsonify(scores=[float(x) for x in scores], latencyMs=latency, count=len(passages))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=r"D:\bge-reranker\model")
    ap.add_argument("--port", type=int, default=8930)
    ap.add_argument("--max-length", type=int, default=512)
    ap.add_argument("--batch", type=int, default=16)
    args = ap.parse_args()

    MODEL_NAME, MAX_LEN, BATCH = args.model, args.max_length, args.batch
    t0 = time.time()
    MODEL = CrossEncoder(args.model, max_length=args.max_length, device=DEVICE)
    print(f"[rerank] loaded {args.model} on {DEVICE} in {time.time() - t0:.1f}s", flush=True)
    print(f"[rerank] listening http://127.0.0.1:{args.port}", flush=True)
    app.run(host="127.0.0.1", port=args.port, threaded=False)
