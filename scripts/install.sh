#!/usr/bin/env bash

set -euo pipefail

die() {
  printf '安装失败：%s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
用法：./install.sh [--port 端口]

把当前分发包（或仓库 dist/）里的 quotahot 安装为 Linux systemd 用户服务。
服务名为 quotahot.service。

选项：
  --port N  Web 服务端口，默认 8686
  -h, --help 显示帮助
EOF
}

systemd_escape() {
  local value=$1
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  value=${value//%/%%}
  printf '%s' "$value"
}

systemd_exec_escape() {
  local value
  value=$(systemd_escape "$1")
  value=${value//\$/\$\$}
  printf '%s' "$value"
}

port=8686
while (($# > 0)); do
  case "$1" in
    --port)
      (($# >= 2)) || die '--port 后需要端口号'
      port=$2
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "无法识别的参数：$1"
      ;;
  esac
done

[[ $port =~ ^[0-9]+$ ]] || die "端口必须是 1–65535：$port"
port_decimal=$((10#$port))
((port_decimal >= 1 && port_decimal <= 65535)) || die "端口必须是 1–65535：$port"
[[ $(uname -s) == Linux ]] || die '此脚本只支持 Linux；macOS 请使用 launchd，Windows 请使用任务计划程序或 nssm'

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [[ -n ${QUOTAHOT_INSTALL_SOURCE:-} ]]; then
  source_binary=$QUOTAHOT_INSTALL_SOURCE
elif [[ -f $script_dir/quotahot ]]; then
  source_binary=$script_dir/quotahot
elif [[ -f $script_dir/../dist/quotahot ]]; then
  source_binary=$(CDPATH= cd -- "$script_dir/.." && pwd)/dist/quotahot
else
  die '找不到 quotahot 构建产物；请在解压后的分发目录运行，或先执行 npm run build'
fi
[[ -f $source_binary ]] || die "找不到 quotahot 构建产物：$source_binary"
printf '构建产物目录：%s\n' "$(dirname -- "$source_binary")"

node_bin=$(command -v node 2>/dev/null || true)
[[ -n $node_bin ]] || die '目标机需要 Node.js 24 或更高版本'
node_version=$("$node_bin" --version 2>/dev/null || true)
node_major=${node_version#v}
node_major=${node_major%%.*}
[[ $node_major =~ ^[0-9]+$ ]] && ((node_major >= 24)) || die "目标机需要 Node.js 24 或更高版本，当前为 ${node_version:-未知}"

bin_dir=${QUOTAHOT_INSTALL_BIN_DIR:-$HOME/.quotahot/bin}
config_home=${XDG_CONFIG_HOME:-$HOME/.config}
unit_dir=${QUOTAHOT_SYSTEMD_USER_DIR:-$config_home/systemd/user}
data_dir=${QUOTAHOT_DATA_DIR:-$HOME/.quotahot}
target_binary=$bin_dir/quotahot
unit_path=$unit_dir/quotahot.service
systemctl_command=${QUOTAHOT_SYSTEMCTL:-systemctl}
service_path=$bin_dir${PATH:+:$PATH}
for path in "$node_bin" "$target_binary" "$data_dir" "$service_path"; do
  [[ $path != *$'\n'* && $path != *$'\r'* ]] || die '路径不能包含换行'
done
unit_node=$(systemd_exec_escape "$node_bin")
unit_binary=$(systemd_exec_escape "$target_binary")
unit_data=$(systemd_escape "$data_dir")
unit_path_env=$(systemd_escape "$service_path")

command -v "$systemctl_command" >/dev/null 2>&1 || die "找不到 systemctl：$systemctl_command"
was_enabled=0
if "$systemctl_command" --user is-enabled --quiet quotahot.service; then
  was_enabled=1
fi
mkdir -p "$bin_dir" "$unit_dir" "$data_dir"

# 覆盖就是覆盖，不留备份；这两个标记只用来判断失败时哪些文件是本次新建、可以删干净的
had_binary=0
if [[ -f $target_binary ]]; then had_binary=1; fi
binary_tmp=$(mktemp "$bin_dir/.quotahot.XXXXXX")
if ! install -m 0755 -- "$source_binary" "$binary_tmp"; then
  rm -f -- "$binary_tmp"
  die '复制 quotahot 失败'
fi
mv -f -- "$binary_tmp" "$target_binary"

had_unit=0
if [[ -f $unit_path ]]; then had_unit=1; fi
unit_tmp=$(mktemp "$unit_dir/.quotahot.service.XXXXXX")
cat >"$unit_tmp" <<EOF
[Unit]
Description=QuotaHot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$unit_data
ExecStart="$unit_node" "$unit_binary"
Restart=always
RestartSec=30
Environment="PATH=$unit_path_env"
Environment=PORT=$port
Environment="QUOTAHOT_DATA_DIR=$unit_data"

[Install]
WantedBy=default.target
EOF
chmod 0644 "$unit_tmp"
mv -f -- "$unit_tmp" "$unit_path"

# 旧文件已被覆盖，没有备份可退回，所以只清掉本次新建的那些，并且别把没启用过的服务留在启用态。
abort_install() {
  local reason=$1
  ((had_binary)) || rm -f -- "$target_binary"
  if ((!had_unit)); then
    rm -f -- "$unit_path"
    if ! "$systemctl_command" --user daemon-reload >/dev/null 2>&1; then
      printf '警告：删除新建的服务文件后 systemd daemon-reload 仍然失败\n' >&2
    fi
  fi
  if ((!was_enabled)) && ! "$systemctl_command" --user disable quotahot.service >/dev/null 2>&1; then
    printf '警告：安装失败后未能撤销服务启用状态\n' >&2
  fi
  if ((had_binary || had_unit)); then
    die "$reason；旧文件已被本次安装覆盖，无法还原"
  fi
  die "$reason；本次新建的文件已清除"
}

if ! "$systemctl_command" --user daemon-reload; then
  abort_install 'systemd 重新加载失败'
fi
if ! "$systemctl_command" --user enable quotahot.service; then
  abort_install 'systemd 启用服务失败'
fi
if ! "$systemctl_command" --user restart quotahot.service; then
  abort_install 'systemd 启动服务失败'
fi

printf 'QuotaHot 已安装到 %s\n' "$target_binary"
printf '用户服务已启动：http://localhost:%s\n' "$port"
printf '如需退出登录后继续运行，请执行：loginctl enable-linger %s\n' "${USER:-$(id -un)}"
