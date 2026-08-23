#!/bin/bash

# OKIT installer (standalone binary, macOS).
#
# Design constraints (documented in README "Shell 配置安全边界"):
#   - NEVER modify shell configs, npm prefix, or install Homebrew/Node/Python.
#     The release binary is self-contained; it needs none of them.
#   - Verify every downloaded artifact against its published SHA256 checksum.
#   - Fail loudly instead of best-effort-installing anything.

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Configuration
INSTALL_DIR="/usr/local/bin"
OKIT_DIR="$HOME/.okit"
OKIT_REPO="Cing-self/okit"

echo -e "${BLUE}🚀 安装 OKIT...${NC}"

# Check if macOS
OS=$(uname -s)
if [[ "$OS" != "Darwin" ]]; then
    echo -e "${RED}✗ 当前仅支持 macOS 平台（Linux/Windows 请用 npm: npm install -g @cing-self/okit-cli）${NC}"
    exit 1
fi

# ============================================
# 安装 OKIT
# ============================================

# Detect platform
ARCH=$(uname -m)
OKIT_VERSION="${OKIT_VERSION:-}"

# Determine architecture
# ASSET_ARCH is the suffix baked into the release zip names produced by
# scripts/publish-release.sh (and consumed by install.sh below), which mirrors
# the pkg binary output (okit-macos-arm64 / okit-macos-x64).
if [[ "$ARCH" == "arm64" ]]; then
    echo -e "${BLUE}📦 检测到 Apple Silicon (arm64)${NC}"
    BINARY_NAME="okit-macos-arm64"
    ASSET_ARCH="arm64"
elif [[ "$ARCH" == "x86_64" ]]; then
    echo -e "${BLUE}📦 检测到 Intel (x64)${NC}"
    BINARY_NAME="okit-macos-x64"
    ASSET_ARCH="x64"
else
    echo -e "${RED}✗ 不支持的架构: $ARCH${NC}"
    exit 1
fi

# Check if install directory exists and is writable
if [[ ! -d "$INSTALL_DIR" ]]; then
    echo -e "${YELLOW}⚠️  $INSTALL_DIR 不存在，尝试创建...${NC}"
    sudo mkdir -p "$INSTALL_DIR" || {
        echo -e "${RED}✗ 无法创建 $INSTALL_DIR${NC}"
        exit 1
    }
fi

# Check write permission
if [[ ! -w "$INSTALL_DIR" ]]; then
    echo -e "${YELLOW}⚠️  需要管理员权限来安装到 $INSTALL_DIR${NC}"
    USE_SUDO=true
else
    USE_SUDO=false
fi

# Create OKIT directory
echo -e "${BLUE}📂 创建配置目录: $OKIT_DIR${NC}"
mkdir -p "$OKIT_DIR/logs" "$OKIT_DIR/cache"

# Optional GitHub token for private-repo access during development.
# Public releases need nothing; api.github.com requests just carry it if set.
GH_AUTH_HEADER=()
if [[ -n "${OKIT_GITHUB_TOKEN:-}" ]]; then
    GH_AUTH_HEADER=(-H "Authorization: Bearer ${OKIT_GITHUB_TOKEN}")
fi

# Find and copy binary
if [[ -f "./bin/$BINARY_NAME" ]]; then
    echo -e "${BLUE}📂 使用本地构建版本 ($BINARY_NAME)${NC}"
    BINARY_SOURCE="./bin/$BINARY_NAME"
elif [[ -f "./dist/main.js" ]]; then
    echo -e "${BLUE}📂 使用本地源码版本${NC}"
    BINARY_SOURCE="./dist/main.js"
else
    echo -e "${BLUE}🌐 下载 Release 二进制${NC}"
    if [[ -z "$OKIT_VERSION" ]]; then
        # Resolve the latest release tag from GitHub's redirect — no JSON
        # parsing or extra interpreters required.
        LATEST_URL="$(curl -fsSL "${GH_AUTH_HEADER[@]}" -o /dev/null -w '%{url_effective}' \
            "https://github.com/${OKIT_REPO}/releases/latest" || true)"
        OKIT_VERSION="${LATEST_URL##*/}"
    fi

    if [[ -z "$OKIT_VERSION" || "$OKIT_VERSION" == "latest" ]]; then
        echo -e "${RED}✗ 无法获取最新版本号（私有仓库请设置 OKIT_GITHUB_TOKEN）${NC}"
        exit 1
    fi

    ASSET_NAME="okit-${OKIT_VERSION}-macos-${ASSET_ARCH}.zip"
    DOWNLOAD_URL="https://github.com/${OKIT_REPO}/releases/download/${OKIT_VERSION}/${ASSET_NAME}"
    echo -e "${BLUE}ℹ️  版本: ${OKIT_VERSION}${NC}"
    echo -e "${BLUE}ℹ️  下载地址: ${DOWNLOAD_URL}${NC}"

    TMP_DIR="$(mktemp -d)"
    trap 'rm -rf "$TMP_DIR"' EXIT
    ZIP_PATH="$TMP_DIR/$ASSET_NAME"
    echo -e "${BLUE}⬇️  下载: $ASSET_NAME${NC}"
    DOWNLOAD_TIMEOUT="${OKIT_DOWNLOAD_TIMEOUT:-600}"
    curl -fSL "${GH_AUTH_HEADER[@]}" --retry 5 --retry-delay 2 --retry-connrefused \
        --retry-max-time "$DOWNLOAD_TIMEOUT" -o "$ZIP_PATH" "$DOWNLOAD_URL"

    # ── SHA256 verification (mandatory) ─────────────────────────────
    SHA_URL="${DOWNLOAD_URL}.sha256"
    echo -e "${BLUE}🔐 校验 SHA256...${NC}"
    if ! curl -fSL "${GH_AUTH_HEADER[@]}" --retry 3 --retry-delay 2 \
        --retry-max-time 120 -o "$TMP_DIR/$ASSET_NAME.sha256" "$SHA_URL"; then
        echo -e "${RED}✗ 无法下载校验文件: ${ASSET_NAME}.sha256${NC}"
        echo -e "${RED}  拒绝安装未经校验的二进制。请到 Releases 页面确认该版本是否附带 .sha256 文件。${NC}"
        exit 1
    fi
    if ! (cd "$TMP_DIR" && shasum -a 256 --check "$ASSET_NAME.sha256" --status); then
        echo -e "${RED}✗ SHA256 校验失败 — 下载可能已损坏或被篡改，已中止安装${NC}"
        exit 1
    fi
    echo -e "${GREEN}✓ SHA256 校验通过${NC}"

    if command -v unzip &> /dev/null; then
        unzip -q "$ZIP_PATH" -d "$TMP_DIR/unpacked"
    else
        mkdir -p "$TMP_DIR/unpacked" && ditto -xk "$ZIP_PATH" "$TMP_DIR/unpacked"
    fi

    if [[ ! -f "$TMP_DIR/unpacked/okit" ]]; then
        echo -e "${RED}✗ 解压后未找到 okit 可执行文件${NC}"
        exit 1
    fi
    BINARY_SOURCE="$TMP_DIR/unpacked/okit"
fi

# Install binary
echo -e "${BLUE}📥 安装到 $INSTALL_DIR/okit${NC}"
if [[ "$USE_SUDO" == true ]]; then
    sudo cp "$BINARY_SOURCE" "$INSTALL_DIR/okit"
    sudo chmod +x "$INSTALL_DIR/okit"
else
    cp "$BINARY_SOURCE" "$INSTALL_DIR/okit"
    chmod +x "$INSTALL_DIR/okit"
fi

# /usr/local/bin is on the default macOS PATH. If it is somehow missing we
# print instructions instead of editing the user's shell config — see the
# README "Shell 配置安全边界" promise.
if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
    echo -e "${YELLOW}⚠️  $INSTALL_DIR 不在当前 PATH 中。请手动将其加入你的 Shell 配置，例如:${NC}"
    echo "    export PATH=\"$INSTALL_DIR:\$PATH\""
fi

INSTALLED_VERSION="$("$INSTALL_DIR/okit" --version 2>/dev/null || echo unknown)"
echo ""
echo -e "${GREEN}✓ OKIT ${INSTALLED_VERSION} 安装成功！${NC}"
echo ""
echo -e "${BLUE}使用方法:${NC}"
echo "  okit web        启动 Web 管理台 (http://localhost:3780)"
echo "  okit --help     查看全部命令"
echo "  okit upgrade    升级到最新版本"
echo ""
echo -e "${BLUE}卸载（本脚本不写任何 Shell 配置，卸载只需删除两处）:${NC}"
echo "  sudo rm -f $INSTALL_DIR/okit"
echo "  rm -rf $OKIT_DIR"
