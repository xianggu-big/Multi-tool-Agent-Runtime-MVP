# mta-sandbox:node24 — 写能力沙箱镜像（M1 Step1）
#
# 目的：为「改前试跑」提供一个与宿主隔离、但**能真跑 tsc / node --test** 的 Linux 环境。
#
# 关键设计（对照两轮评审）：
#   ① P0-1：node_modules 在镜像内安装（Linux ABI），**绝不 bind mount 宿主 node_modules**
#      （宿主是 Windows ABI，Linux 容器加载必 ERR_DLOPEN_FAILED）；每 run 用 docker cp
#      把仓库快照（排除 node_modules/data）送进容器，不动镜像内的依赖。
#   ② P0-2：含 build-essential + python3 —— better-sqlite3 对 Node 24 的 prebuild 覆盖不确定，
#      一旦回退源码编译必须有工具链；npm ci 带 3 次重试（国内网络抖动是首要失败源）。
#   ③ P2-d：非 root 运行（node 用户）；/work 归 node 所有，供快照落地与检查执行。
#   ④ 容器有网络（诚实清单已披露，不做网络隔离）。
FROM node:24-bookworm-slim

# 编译工具链（better-sqlite3 / sqlite-vec 回退源码编译必需）+ ca-certificates（npm 拉包）
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential python3 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /work

# 仅依赖清单 → 最大化层缓存（源码不进镜像）
COPY package.json package-lock.json ./

# npm ci 带重试；装完立刻自检原生模块可加载（这是"能真跑测试"的前提，装坏了要立刻知道）
RUN set -eux; \
    for i in 1 2 3; do \
      if npm ci --no-audit --no-fund --loglevel=error; then break; fi; \
      echo "npm ci 第 $i 次失败，5s 后重试…"; sleep 5; \
    done; \
    node -e "require('better-sqlite3'); console.log('better-sqlite3 在', process.platform, '可加载 ✅')"; \
    node -e "try{require('sqlite-vec');console.log('sqlite-vec 可加载 ✅')}catch(e){console.log('sqlite-vec 加载检查跳过:', e.message)}"

# 非 root：/work 交给 node 用户
RUN chown -R node:node /work
USER node

# 常驻容器：由 SandboxSession 用 docker exec 驱动（sleep 保持存活，--rm 收尾）
CMD ["sleep", "infinity"]
