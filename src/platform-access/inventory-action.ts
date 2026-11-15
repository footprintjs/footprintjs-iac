import { freeze } from '../graph/data.ts';
import { hostActionDigest } from './data.ts';
import type { HostAction } from './types.ts';

/** Fixed read-only inventory. No OS file is sourced and no raw machine identifier is emitted. */
const script = String.raw`set -eu
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
LC_ALL=C
export LC_ALL
family=unknown
case "$(uname -s 2>/dev/null || true)" in Linux) family=linux ;; Darwin) family=darwin ;; esac
architecture=unknown
case "$(uname -m 2>/dev/null || true)" in x86_64|amd64) architecture=amd64 ;; aarch64|arm64) architecture=arm64 ;; esac
kernel=$(uname -r 2>/dev/null || true)
distribution=
os_version=
identity=
cpu=$(getconf _NPROCESSORS_ONLN 2>/dev/null || true)
memory_total=
memory_available=
privilege=unknown
if [ "$(id -u 2>/dev/null || true)" = 0 ]; then privilege=root; else privilege=unprivileged; fi
if [ "$family" = linux ]; then
  if [ -r /etc/os-release ]; then
    distribution=$(awk -F= '$1=="ID" {gsub(/^"|"$/, "", $2); print $2; exit}' /etc/os-release)
    os_version=$(awk -F= '$1=="VERSION_ID" {gsub(/^"|"$/, "", $2); print $2; exit}' /etc/os-release)
  fi
  machine=
  if [ -r /etc/machine-id ]; then machine=$(awk 'NF { print; exit }' /etc/machine-id); fi
  if [ -z "$machine" ] && [ -r /sys/class/dmi/id/product_uuid ]; then machine=$(awk 'NF { print; exit }' /sys/class/dmi/id/product_uuid); fi
  if [ -n "$machine" ] && command -v sha256sum >/dev/null 2>&1; then identity=$(printf '%s' "$machine" | sha256sum | awk '{print $1}'); fi
  if [ -r /proc/meminfo ]; then
    memory_total=$(awk '$1=="MemTotal:" {printf "%.0f",$2*1024}' /proc/meminfo)
    memory_available=$(awk '$1=="MemAvailable:" {printf "%.0f",$2*1024}' /proc/meminfo)
  fi
  # Honor visible cgroup v2 quotas, including ancestor limits. Do not report the Docker VM's capacity.
  cgroup_dir=/sys/fs/cgroup
  if [ -r /proc/self/cgroup ]; then
    cgroup_path=$(awk -F: '$1=="0" && $2=="" {print $3; exit}' /proc/self/cgroup)
    case "$cgroup_path" in *..*) cgroup_path= ;; esac
    if [ -n "$cgroup_path" ] && [ -d "/sys/fs/cgroup$cgroup_path" ]; then cgroup_dir="/sys/fs/cgroup$cgroup_path"; fi
  fi
  minimum() { awk -v value="$1" -v limit="$2" 'BEGIN {if(value ~ /^[0-9]+([.][0-9]+)?$/ && limit ~ /^[0-9]+([.][0-9]+)?$/) {if(limit<value)value=limit; printf "%.6f", value}}'; }
  while [ -d "$cgroup_dir" ]; do
    if [ -r "$cgroup_dir/cpu.max" ]; then
      quota=$(awk '$1!="max" && $1>0 && $2>0 {printf "%.6f", $1/$2}' "$cgroup_dir/cpu.max")
      if [ -n "$quota" ]; then cpu=$(minimum "$cpu" "$quota"); fi
    fi
    if [ -r "$cgroup_dir/cpuset.cpus.effective" ]; then
      cpuset=$(awk 'NF {n=split($1,a,","); total=0; for(i=1;i<=n;i++){m=split(a[i],b,"-"); if(m==1)total++; else if(m==2 && b[2]>=b[1])total+=b[2]-b[1]+1; else exit} print total}' "$cgroup_dir/cpuset.cpus.effective")
      if [ -n "$cpuset" ] && [ "$cpuset" -gt 0 ]; then cpu=$(minimum "$cpu" "$cpuset"); fi
    fi
    if [ -r "$cgroup_dir/memory.max" ]; then
      limit=$(awk '$1!="max" && $1>0 {printf "%.0f", $1}' "$cgroup_dir/memory.max")
      if [ -n "$limit" ]; then
        memory_total=$(minimum "$memory_total" "$limit" | awk '{printf "%.0f",$1}')
        if [ -r "$cgroup_dir/memory.current" ]; then
          remaining=$(awk -v maximum="$limit" 'NR==1 {v=maximum-$1; if(v<0)v=0; printf "%.0f",v}' "$cgroup_dir/memory.current")
          memory_available=$(minimum "$memory_available" "$remaining" | awk '{printf "%.0f",$1}')
        else memory_available=; fi
      fi
    fi
    if [ "$cgroup_dir" = /sys/fs/cgroup ]; then break; fi
    cgroup_dir=$(dirname "$cgroup_dir")
    case "$cgroup_dir" in /sys/fs/cgroup|/sys/fs/cgroup/*) ;; *) break ;; esac
  done
  # Legacy cgroup v1 mounts, when visible to the process.
  if [ -r /sys/fs/cgroup/cpu/cpu.cfs_quota_us ] && [ -r /sys/fs/cgroup/cpu/cpu.cfs_period_us ]; then
    quota=$(awk 'NR==FNR {q=$1;next} q>0 && $1>0 {printf "%.6f",q/$1}' /sys/fs/cgroup/cpu/cpu.cfs_quota_us /sys/fs/cgroup/cpu/cpu.cfs_period_us)
    if [ -n "$quota" ]; then cpu=$(minimum "$cpu" "$quota"); fi
  fi
  if [ -r /sys/fs/cgroup/memory/memory.limit_in_bytes ]; then
    limit=$(awk '$1>0 {printf "%.0f",$1}' /sys/fs/cgroup/memory/memory.limit_in_bytes)
    if [ -n "$limit" ]; then
      memory_total=$(minimum "$memory_total" "$limit" | awk '{printf "%.0f",$1}')
      if [ -r /sys/fs/cgroup/memory/memory.usage_in_bytes ]; then
        remaining=$(awk -v maximum="$limit" 'NR==1 {v=maximum-$1; if(v<0)v=0; printf "%.0f",v}' /sys/fs/cgroup/memory/memory.usage_in_bytes)
        memory_available=$(minimum "$memory_available" "$remaining" | awk '{printf "%.0f",$1}')
      else memory_available=; fi
    fi
  fi
fi
disk_total=$(df -Pk / 2>/dev/null | awk 'NR==2 {printf "%.0f", $2*1024}')
disk_available=$(df -Pk / 2>/dev/null | awk 'NR==2 {printf "%.0f", $4*1024}')
printf '%s\n' footprint-host-inventory-v1
printf '%s\n' "family=$family" "distribution=$distribution" "os_version=$os_version" "kernel=$kernel" "architecture=$architecture" "identity=$identity" "cpu=$cpu" "memory_total=$memory_total" "memory_available=$memory_available" "disk_total=$disk_total" "disk_available=$disk_available" "privilege=$privilege"
for executable in kubeadm kubelet kubectl containerd; do
  state=unknown
  version=
  if command -v "$executable" >/dev/null 2>&1; then
    state=installed
    case "$executable" in
      kubectl) version=$(kubectl version --client=true -o json 2>/dev/null | sed -n 's/.*"gitVersion": *"\([^"]*\)".*/\1/p' | head -n 1) ;;
      *) version=$("$executable" --version 2>/dev/null | grep -oE 'v?[0-9]+\.[0-9]+\.[0-9]+([-+][A-Za-z0-9_.-]+)?' | head -n 1 || true) ;;
    esac
  else state=absent; fi
  printf '%s\n' "$executable=$state" "$executable-version=$version"
done
# Positive markers establish configured Kubernetes; their absence does not establish a globally empty server.
cluster=unknown
for marker in /etc/kubernetes/admin.conf /etc/kubernetes/kubelet.conf /var/lib/kubelet/config.yaml /etc/rancher/k3s/k3s.yaml /etc/rancher/rke2/rke2.yaml /var/snap/microk8s/current/credentials/client.config; do
  if [ -e "$marker" ]; then cluster=present; fi
done
printf '%s\n' "kubernetes=$cluster"
`;

export const HOST_INVENTORY_ACTION: Readonly<HostAction> = freeze({ id: 'footprint-host-inventory-v1', script, effect: 'read-only' });
export const HOST_INVENTORY_ACTION_DIGEST = hostActionDigest(HOST_INVENTORY_ACTION);
