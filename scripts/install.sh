#!/usr/bin/env bash

set -Eeuo pipefail

REPOSITORY_URL="${ACCELERATOR_REPOSITORY:-https://github.com/soso454u/SillyTavern-Cloud-Lounge-Accelerator.git}"
REPOSITORY_BRANCH="${ACCELERATOR_BRANCH:-main}"
PROJECT_DIRECTORY="cloud-lounge-accelerator"
ROOT_ARGUMENT=""
ENABLE_LAZY_CHARACTERS=0

usage() {
    cat <<'EOF'
云酒馆加速器一键安装/更新器

用法：
  bash install.sh [SillyTavern 根目录] [--lazy-characters]
  bash install.sh --root /path/to/SillyTavern [--lazy-characters]

选项：
  --root PATH          指定 SillyTavern 根目录
  --lazy-characters    同时开启官方角色卡懒加载
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
    local timestamp backup_base backup_path backup_counter
    timestamp="$(date '+%Y%m%d-%H%M%S')"
    backup_base="${config_path}.backup-cloud-lounge-${timestamp}"
    backup_path="$backup_base"
    backup_counter=1
    while [[ -e "$backup_path" ]]; do
        backup_path="${backup_base}-${backup_counter}"
        ((backup_counter += 1))
    done
    cp -p "$config_path" "$backup_path"
    info "已备份配置：$backup_path"

    node - "$config_path" "$ENABLE_LAZY_CHARACTERS" <<'NODE'
const fs = require('node:fs');
const configPath = process.argv[2];
const enableLazyCharacters = process.argv[3] === '1';
let content = fs.readFileSync(configPath, 'utf8');

if (/^enableServerPlugins\s*:/m.test(content)) {
    content = content.replace(/^enableServerPlugins\s*:.*$/m, 'enableServerPlugins: true');
} else {
    content = `${content.trimEnd()}\n\n# Enabled by Cloud Lounge Accelerator installer\nenableServerPlugins: true\n`;
}

if (enableLazyCharacters && /^\s+lazyLoadCharacters\s*:/m.test(content)) {
    content = content.replace(/^(\s*)lazyLoadCharacters\s*:.*$/m, '$1lazyLoadCharacters: true');
}

fs.writeFileSync(configPath, content, 'utf8');
NODE

    if ((ENABLE_LAZY_CHARACTERS == 1)); then
        if grep -Eq '^[[:space:]]+lazyLoadCharacters[[:space:]]*:' "$config_path"; then
            if grep -Eq '^[[:space:]]+lazyLoadCharacters[[:space:]]*:[[:space:]]*true([[:space:]]|$)' "$config_path"; then
                info '已开启 performance.lazyLoadCharacters'
            else
                die 'performance.lazyLoadCharacters 更新验证失败，请使用自动备份恢复。'
            fi
        else
            info '未在 config.yaml 中找到 lazyLoadCharacters，已跳过该可选设置。'
        fi
    fi

    grep -Eq '^enableServerPlugins[[:space:]]*:[[:space:]]*true([[:space:]]|$)' "$config_path" \
        || die 'config.yaml 更新验证失败，请使用自动备份恢复。'
}

require_command git
require_command grep
require_command node

SILLYTAVERN_DIRECTORY="$(resolve_root)"
SERVER_PLUGIN_DIRECTORY="$SILLYTAVERN_DIRECTORY/plugins/$PROJECT_DIRECTORY"
UI_EXTENSION_DIRECTORY="$SILLYTAVERN_DIRECTORY/public/scripts/extensions/third-party/$PROJECT_DIRECTORY"

info "SillyTavern 根目录：$SILLYTAVERN_DIRECTORY"
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
