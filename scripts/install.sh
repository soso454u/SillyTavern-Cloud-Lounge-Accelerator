#!/usr/bin/env bash

set -Eeuo pipefail

REPOSITORY_URL="${ACCELERATOR_REPOSITORY:-https://github.com/soso454u/SillyTavern-Cloud-Lounge-Accelerator.git}"
REPOSITORY_BRANCH="${ACCELERATOR_BRANCH:-main}"
PROJECT_DIRECTORY="cloud-lounge-accelerator"
ROOT_ARGUMENT=""
ENABLE_LAZY_CHARACTERS=0
ENABLE_KEEP_ALIVE=0
ENABLE_FAST_START=0

usage() {
    cat <<'EOF'
云酒馆加速器一键安装/更新器

用法：
  bash install.sh [SillyTavern 根目录] [性能选项]
  bash install.sh --root /path/to/SillyTavern [性能选项]

选项：
  --root PATH          指定 SillyTavern 根目录
  --keep-alive         开启 HTTP/HTTPS Keep-Alive；网络异常时请关闭
  --lazy-characters    开启角色卡懒加载；旧扩展和模糊搜索可能受影响
  --fast-start         同时开启上面两项（普通安装默认不开启）
  -h, --help           显示帮助

如未指定路径，安装器会先检查 SILLYTAVERN_ROOT，
然后检查当前目录和常见容器路径。
EOF
}

die() {
    printf '\n[错误] %s\n' "$*" >&2
    exit 1
}

info() {
    printf '[云酒馆加速器] %s\n' "$*"
}

while (($# > 0)); do
    case "$1" in
        --root)
            (($# >= 2)) || die '--root 后缺少路径'
            ROOT_ARGUMENT="$2"
            shift 2
            ;;
        --lazy-characters)
            ENABLE_LAZY_CHARACTERS=1
            shift
            ;;
        --keep-alive)
            ENABLE_KEEP_ALIVE=1
            shift
            ;;
        --fast-start)
            ENABLE_FAST_START=1
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        -* )
            die "未知选项：$1"
            ;;
        *)
            [[ -z "$ROOT_ARGUMENT" ]] || die '只能指定一个 SillyTavern 根目录'
            ROOT_ARGUMENT="$1"
            shift
            ;;
    esac
done

if ((ENABLE_FAST_START == 1)); then
    ENABLE_KEEP_ALIVE=1
    ENABLE_LAZY_CHARACTERS=1
fi

is_sillytavern_root() {
    local candidate="$1"
    [[ -f "$candidate/server.js" && -f "$candidate/package.json" && -f "$candidate/config.yaml" ]] || return 1
    grep -Eq '"name"[[:space:]]*:[[:space:]]*"sillytavern"' "$candidate/package.json"
}

resolve_root() {
    local requested="${ROOT_ARGUMENT:-${SILLYTAVERN_ROOT:-}}"
    if [[ -n "$requested" ]]; then
        [[ -d "$requested" ]] || die "目录不存在：$requested"
        local resolved
        resolved="$(cd "$requested" && pwd -P)"
        is_sillytavern_root "$resolved" || die "这不是 SillyTavern 根目录：$resolved\n根目录中应直接存在 server.js、package.json 和 config.yaml。"
        printf '%s\n' "$resolved"
        return
    fi

    if is_sillytavern_root "$PWD"; then
        pwd -P
        return
    fi

    local candidates=(
        '/app'
        '/app/SillyTavern'
        '/home/node/app'
        '/opt/SillyTavern'
        '/SillyTavern'
    )
    local matches=()
    local candidate
    for candidate in "${candidates[@]}"; do
        if is_sillytavern_root "$candidate"; then
            matches+=("$candidate")
        fi
    done

    if ((${#matches[@]} == 1)); then
        (cd "${matches[0]}" && pwd -P)
        return
    fi

    die '无法唯一确定 SillyTavern 根目录。请先 cd 进入根目录后重试，或把路径作为参数传入。'
}

require_command() {
    command -v "$1" >/dev/null 2>&1 || die "缺少必需命令：$1"
}

install_or_update_repository() {
    local destination="$1"
    local label="$2"

    if [[ -e "$destination" && ! -d "$destination/.git" ]]; then
        die "$label 目录已存在，但不是 Git 仓库：$destination\n为避免覆盖你的文件，安装器已停止。请手动备份或重命名该目录后重试。"
    fi

    if [[ -d "$destination/.git" ]]; then
        info "更新${label}：$destination"
        git -C "$destination" pull --ff-only origin "$REPOSITORY_BRANCH"
    else
        info "安装${label}：$destination"
        mkdir -p "$(dirname "$destination")"
        git clone --depth 1 --branch "$REPOSITORY_BRANCH" "$REPOSITORY_URL" "$destination"
    fi
}

update_config() {
    local config_path="$1"
    local arguments=(--config "$config_path")
    ((ENABLE_KEEP_ALIVE == 1)) && arguments+=(--keep-alive)
    ((ENABLE_LAZY_CHARACTERS == 1)) && arguments+=(--lazy-characters)
    node "$SERVER_PLUGIN_DIRECTORY/scripts/configure.mjs" "${arguments[@]}"
}

require_command git
require_command grep
require_command node

SILLYTAVERN_DIRECTORY="$(resolve_root)"
SERVER_PLUGIN_DIRECTORY="$SILLYTAVERN_DIRECTORY/plugins/$PROJECT_DIRECTORY"
UI_EXTENSION_DIRECTORY="$SILLYTAVERN_DIRECTORY/public/scripts/extensions/third-party/$PROJECT_DIRECTORY"

info "SillyTavern 根目录：$SILLYTAVERN_DIRECTORY"
if ((ENABLE_LAZY_CHARACTERS == 1)); then
    info '注意：角色卡懒加载可能不兼容部分旧扩展，高级模糊搜索将只按角色名搜索'
fi
install_or_update_repository "$SERVER_PLUGIN_DIRECTORY" '服务端插件'
install_or_update_repository "$UI_EXTENSION_DIRECTORY" '全局 UI 扩展'
update_config "$SILLYTAVERN_DIRECTORY/config.yaml"

[[ -f "$SERVER_PLUGIN_DIRECTORY/server/index.js" ]] || die '服务端插件验证失败'
[[ -f "$UI_EXTENSION_DIRECTORY/manifest.json" ]] || die 'UI 扩展验证失败'

printf '\n============================================================\n'
printf '云酒馆加速器已安装/更新完成。\n'
printf '\n已安装：\n  1. 服务端插件：%s\n  2. 全局 UI 扩展：%s\n' "$SERVER_PLUGIN_DIRECTORY" "$UI_EXTENSION_DIRECTORY"
printf '\n请继续完成：\n'
printf '  1. 在 1Panel / Docker / 系统中重启 SillyTavern。\n'
printf '  2. 用 HTTPS 域名，或在同机上用 localhost/127.0.0.1 访问。\n'
printf '  3. 打开“扩展设置 → 云酒馆加速器”，确认显示“已启用”。\n'
printf '============================================================\n'
