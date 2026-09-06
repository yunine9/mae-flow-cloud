package main

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"flag"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/BurntSushi/toml"
	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

// ConfigFile 对应 config.toml 文件结构
// login_user / su_user / log_base 为固定值，不开放配置：
//
//	login_user = "sopuser"（SSH/SFTP 登录用户）
//	su_user    = "ossuser"（日志读取用户，切换链 login_user -> su_user）
//	log_base   = "/var/log/oss/MAE"（日志基础目录，实际抓取 <log_base>/<服务名> 全部内容）
type ConfigFile struct {
	Host        string            `toml:"hosts"`         // 网管节点 IP，自动发现业务节点（主力）
	SingleHosts []string          `toml:"single_hosts"`  // 直连指定的业务节点 IP（备选）
	Password    string            `toml:"pwd"`
	Services    []string          `toml:"services"`
	LocalDir    string            `toml:"local_dir"`
	NodeIPMap   map[string]string `toml:"node_ip_map"`   // 内部 IP→可达 IP 显式覆盖（自动解析失败时用）
	SshJump     string            `toml:"ssh_jump"`      // 跳板机 IP，内网节点无法直连时配置
}

// 固定配置常量
const (
	loginUser = "sopuser"
	suUser    = "ossuser"
	logBase   = "/var/log/oss/MAE"
)

type FetchConfig struct {
	Hosts        []string // 运行时最终目标节点列表（发现结果或 SingleHosts），串行抓取
	Password     string   // sopuser/ossuser 共用密码（su 到 ossuser 也复用）
	Services     []string // 服务名列表，逐个抓取 <log_base>/<服务名> 下全部内容
	LocalDir     string   // 本地保存目录（默认 local-logs，位于 exe 同目录下）
	Timestamp    string   // 本次拉取时间戳，用于压缩包根目录命名（yyyyMMddHHmmss）
	DiscoverHost string   // 网管节点 IP，用于自动发现业务节点
	SingleHosts  []string // 用户直连指定的业务节点 IP
	NodeIPMap    map[string]string
	SshJump      string // 跳板机（可达 IP），用于连接无法直连的内网节点
}

// sshPort 固定 SSH 端口（OSS 节点统一 22）。
const sshPort = 22

type FetchLogger struct {
	mu   sync.Mutex
	logs []string
}

func (l *FetchLogger) Info(format string, args ...interface{}) {
	msg := fmt.Sprintf("[INFO] "+format, args...)
	l.mu.Lock()
	l.logs = append(l.logs, msg)
	l.mu.Unlock()
	fmt.Println(msg)
}

func (l *FetchLogger) Error(format string, args ...interface{}) {
	msg := fmt.Sprintf("[ERROR] "+format, args...)
	l.mu.Lock()
	l.logs = append(l.logs, msg)
	l.mu.Unlock()
	fmt.Println(msg)
}

func (l *FetchLogger) GetLogs() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return strings.Join(l.logs, "\n")
}

// createDefaultConfig 生成带注释示例的 config.toml 模板
func createDefaultConfig(filePath string) error {
	content := `# fetch-logs 配置文件
# 请根据实际情况修改以下配置项
#
# 提示: 所有配置项都支持命令行参数直传(免维护本文件), CLI 值优先于本文件:
#   fetch-logs --host 60.14.46.16 --host 60.14.46.17 \
#              --service TranFmaWebsite \
#              --pwd <密码或环境变量 FETCH_LOGS_PWD> \
#              --local-dir local-logs

# 网管节点 IP（与 single_hosts 二选一，主力方式）
# 工具连接网管节点，通过 ipmc_adm statusapp 自动发现运行该服务的所有后台节点，逐台抓取
# hosts = "60.14.46.16"

# 直连指定的目标服务器 IP 列表（与 hosts 二选一，备选方式）
# 已知目标服务器 IP 时直接指定，跳过自动发现
# 单台服务器: single_hosts = ["60.14.46.16"]
# 多台服务器: single_hosts = ["60.14.46.16", "60.14.46.17", "60.14.46.18"]
# 程序会依次连接每台服务器抓取日志
single_hosts = []

# 服务器密码，sopuser/ossuser 共用（必填）
pwd = ""

# 需要抓取日志的服务名列表（必填，至少一个）
# 示例: services = ["TranFmaWebsite"]
# 多服务: services = ["TranFmaWebsite", "AnotherService"]
# 抓取 /var/log/oss/MAE/<服务名> 下的全部内容并打包 zip 下载
services = []

# 本地保存目录（默认 local-logs，位于 exe 同目录下）
# 可为相对路径（相对 exe 目录），也可为绝对路径
# 每个服务产出解压后的日志目录: <服务名>_<拉取时间戳>/（自动解压并删除中间压缩包）
local_dir = "local-logs"

# 网管节点 IP（与 single_hosts 二选一，主力方式）
# 工具连接网管节点，通过 ipmc_adm statusapp 自动发现运行该服务的所有后台节点，逐台抓取
# hosts = ""

# 节点 IP 映射（可选）
# 自动发现返回的是节点内部 IP（如 172.28.130.161），默认会自动解析大网（可达）IP；
# 仅当自动解析失败或需固定映射时才配置。格式: "内部IP" = "可达IP"
# [node_ip_map]
# "172.28.130.161" = "60.14.46.16"

# 跳板机 IP（可选）
# 当后台节点为内网 IP（本机无法直连，如 172.28.130.166）时，可配置跳板机。
# 工具会先连跳板机，再经跳板机 ssh/scp 到目标节点抓取日志。
# 跳板机与目标节点复用 user/password 凭据（SSH 端口固定 22）。
# ssh_jump = ""
`
	return os.WriteFile(filePath, []byte(content), 0644)
}

// ================= CLI 参数层（AI 友好入口） =================
//
// 取值优先级: CLI 显式参数 > 环境变量(仅密码, FETCH_LOGS_PWD) > config.toml。
// 给了任何 CLI 参数就完全不读也不写配置文件——调用方(Agent/适配器)
// 不需要维护任何落盘状态;完全无参数运行时保留旧的 config.toml 体验
// (缺文件自动生成模板),位置参数仍按旧语义当作配置文件路径。

type sliceFlag []string

func (s *sliceFlag) String() string { return strings.Join(*s, ",") }
func (s *sliceFlag) Set(value string) error { *s = append(*s, value); return nil }

func usageFetchLogs(fs *flag.FlagSet) {
	fmt.Println(`fetch-logs — 从网管服务器抓取服务业务日志

用法(AI/脚本友好, 全参数直传):
  fetch-logs --host <网管节点IP> --service <服务名> [--service <服务名>...]
             [--pwd <密码>]                # 自动发现所有后台节点（经 ipmc_adm statusapp，主力）
  fetch-logs --single-host <IP> [--single-host <IP>...] --service <服务名> [--service <服务名>...]
             [--pwd <密码>] [--local-dir <目录>]   # 直连指定节点（备选）

用法(配置文件, 兼容旧体验):
  fetch-logs [config.toml路径]        # 缺省读 exe 同目录 config.toml

参数:
  --host         网管节点 IP, 自动发现运行该服务的所有后台节点(主力, 与 --single-host 二选一)
  --single-host  目标服务器 IP, 可重复出现; 直连指定, 跳过发现(备选, 与 --host 二选一)
  --service     服务名(抓 /var/log/oss/MAE/<服务名> 全部内容), 可重复出现
  --pwd    sopuser/ossuser 共用密码; 缺省读环境变量 FETCH_LOGS_PWD,
               再缺省回落 config.toml。命令行明文密码会进进程列表,
               自动化场景建议用环境变量
  --local-dir   本地保存目录(默认 local-logs, 相对 exe 目录)
  --ssh-jump    跳板机 IP, 内网节点无法直连时配置(经跳板 ssh/scp 到目标)
  --help        显示本帮助

优先级: CLI 参数 > 环境变量(密码) > 配置文件`)
	_ = fs
}

func main() {
	logger := &FetchLogger{}

	exePath, err := os.Executable()
	if err != nil {
		logger.Error("无法获取可执行文件路径: %v", err)
		os.Exit(1)
	}
	defaultConfig := filepath.Join(filepath.Dir(exePath), "config.toml")

	fs := flag.NewFlagSet("fetch-logs", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	var cliSingleHosts, cliServices sliceFlag
	var cliPwd, cliLocalDir string
	var cliHost, cliSshJump string
	var showHelp bool
	fs.StringVar(&cliHost, "host", "", "网管节点 IP, 自动发现所有后台节点(主力)")
	fs.Var(&cliSingleHosts, "single-host", "目标服务器 IP(可重复, 直连指定, 备选)")
	fs.Var(&cliServices, "service", "服务名(可重复)")
	fs.StringVar(&cliPwd, "pwd", "", "sopuser/ossuser 共用密码")
	fs.StringVar(&cliLocalDir, "local-dir", "", "本地保存目录")
	fs.StringVar(&cliSshJump, "ssh-jump", "", "跳板机 IP")
	fs.BoolVar(&showHelp, "help", false, "显示用法")

	// 旧用法兼容: 唯一位置参数且不是 flag → 视为配置文件路径
	args := os.Args[1:]
	var posConfig string
	if len(args) == 1 && !strings.HasPrefix(args[0], "-") {
		posConfig = args[0]
		args = nil
	}
	parseErr := fs.Parse(args)
	if parseErr != nil || showHelp {
		usageFetchLogs(fs)
		if parseErr != nil {
			os.Exit(1)
		}
		os.Exit(0)
	}
	cliGiven := fs.NFlag() > 0 || posConfig != ""

	var cfgFile ConfigFile
	configPath := posConfig
	if configPath == "" {
		configPath = defaultConfig
	}
	if _, statErr := os.Stat(configPath); statErr == nil {
		logger.Info("读取配置文件: %s", configPath)
		if _, err := toml.DecodeFile(configPath, &cfgFile); err != nil {
			logger.Error("读取配置文件失败: %v", err)
			os.Exit(1)
		}
	} else if !cliGiven {
		// 完全无参数且无配置文件: 保留首跑模板体验
		logger.Info("配置文件不存在，自动创建模板: %s", configPath)
		if createErr := createDefaultConfig(configPath); createErr != nil {
			logger.Error("创建配置文件模板失败: %v", createErr)
			os.Exit(1)
		}
		fmt.Println("\n========================================")
		fmt.Printf("已生成配置文件模板: %s\n", configPath)
		fmt.Println("请编辑该文件，填写实际的 hosts、password、services 等信息后重新运行；")
		fmt.Println("或直接用命令行参数: fetch-logs --host <IP> --service <服务名> --pwd <密码>")
		fmt.Println("========================================")
		os.Exit(1)
	}

	// CLI 显式值 > 环境变量(密码) > 配置文件
	if len(cliSingleHosts) > 0 {
		cfgFile.SingleHosts = cliSingleHosts
	}
	if len(cliServices) > 0 {
		cfgFile.Services = cliServices
	}
	if cliPwd != "" {
		cfgFile.Password = cliPwd
	} else if env := os.Getenv("FETCH_LOGS_PWD"); env != "" {
		cfgFile.Password = env
	}
	if cliLocalDir != "" {
		cfgFile.LocalDir = cliLocalDir
	}
	if cliHost != "" {
		cfgFile.Host = cliHost
	}
	if cliSshJump != "" {
		cfgFile.SshJump = cliSshJump
	}

	// hosts（网管节点）与 single_hosts（直连节点）二选一: 两者都空则报缺参
	if (cfgFile.Host == "" && len(cfgFile.SingleHosts) == 0) || len(cfgFile.Services) == 0 || cfgFile.Password == "" {
		usageFetchLogs(fs)
		fmt.Println()
		var missing []string
		if cfgFile.Host == "" && len(cfgFile.SingleHosts) == 0 {
			missing = append(missing, "--host(网管节点, 自动发现) 或 --single-host(直连节点)")
		}
		if len(cfgFile.Services) == 0 {
			missing = append(missing, "--service(服务名)")
		}
		if cfgFile.Password == "" {
			missing = append(missing, "--pwd 或环境变量 FETCH_LOGS_PWD")
		}
		logger.Error("缺少必填参数: %s", strings.Join(missing, "、"))
		os.Exit(1)
	}

	cfg := &FetchConfig{
		Hosts:        cfgFile.SingleHosts,
		Password:     cfgFile.Password,
		Services:     cfgFile.Services,
		LocalDir:     cfgFile.LocalDir,
		DiscoverHost: cfgFile.Host,
		SingleHosts:  cfgFile.SingleHosts,
		NodeIPMap:    cfgFile.NodeIPMap,
		SshJump:      cfgFile.SshJump,
	}

	// 填充默认值
	if cfg.LocalDir == "" {
		cfg.LocalDir = "local-logs"
	}
	// local_dir 为相对路径时，解析到 exe 同目录下
	if !filepath.IsAbs(cfg.LocalDir) {
		cfg.LocalDir = filepath.Join(filepath.Dir(exePath), cfg.LocalDir)
	}
	// 本次拉取时间戳，用于日志目录命名
	cfg.Timestamp = time.Now().Format("20060102150405")

	// single_hosts 为空且配了 host（网管节点）时，自动发现后台节点
	if len(cfg.Hosts) == 0 && cfg.DiscoverHost != "" {
		logger.Info("========== 自动发现后台节点 ==========")
		discovered, discoverErr := DiscoverNodes(logger, cfg)
		if discoverErr != nil {
			logger.Error("自动发现后台节点失败: %v", discoverErr)
			fmt.Println("\n=== 日志 ===")
			fmt.Println(logger.GetLogs())
			os.Exit(1)
		}
		if len(discovered) == 0 {
			logger.Error("自动发现未返回任何节点: 服务 %v 可能未部署或服务名有误", cfg.Services)
			fmt.Println("\n=== 日志 ===")
			fmt.Println(logger.GetLogs())
			os.Exit(1)
		}
		cfg.Hosts = discovered
		logger.Info("发现节点: %v", cfg.Hosts)
	}

	logger.Info("目标服务器: %v", cfg.Hosts)
	logger.Info("抓取目录: %s/<服务名> 全部内容，服务: %v", logBase, cfg.Services)
	logger.Info("本地保存: %s（产出 <服务名>_%s/ 解压目录）", cfg.LocalDir, cfg.Timestamp)

	if err := fetchAll(logger, cfg); err != nil {
		logger.Error("整体流程失败: %v", err)
		fmt.Println("\n=== 日志 ===")
		fmt.Println(logger.GetLogs())
		os.Exit(1)
	}

	fmt.Println("\n=== 日志 ===")
	fmt.Println(logger.GetLogs())
}

// maxConcurrency 限制多节点并发抓取的最大并发数，避免打满本机 SFTP 连接或网管节点。
// 节点数 ≤ 该值时全部并发；超过则排队。
const maxConcurrency = 5

func fetchAll(logger *FetchLogger, cfg *FetchConfig) error {
	// 本地保存目录
	if err := os.MkdirAll(cfg.LocalDir, 0755); err != nil {
		return fmt.Errorf("创建本地保存目录失败: %v", err)
	}

	n := len(cfg.Hosts)
	logger.Info("========== 开始并发抓取 %d 个节点（并发度上限 %d）==========", n, maxConcurrency)

	var wg sync.WaitGroup
	sem := make(chan struct{}, maxConcurrency) // 信号量，限制并发度
	var errMu sync.Mutex
	var errs []string // 收集各节点错误（不中止其他节点）

	for i, host := range cfg.Hosts {
		wg.Add(1)
		go func(idx int, h string) {
			defer wg.Done()
			sem <- struct{}{} // 占一个并发槽
			defer func() { <-sem }()

			logger.Info("========== 服务器 %s (%d/%d) 开始 ==========", h, idx+1, n)
			if err := fetchFromHost(logger, cfg, h); err != nil {
				logger.Error("服务器 %s 抓取失败: %v", h, err)
				errMu.Lock()
				errs = append(errs, fmt.Sprintf("%s: %v", h, err))
				errMu.Unlock()
			} else {
				logger.Info("服务器 %s 抓取完成 (%d/%d)", h, idx+1, n)
			}
		}(i, host)
	}
	wg.Wait()

	if len(errs) > 0 {
		return fmt.Errorf("%d/%d 个节点抓取失败:\n  - %s", len(errs), n, strings.Join(errs, "\n  - "))
	}
	logger.Info("========== 全部 %d 个节点抓取完成 ==========", n)
	return nil
}

// ================= SSH 基元（非交互） =================

// sshRun 通过 SSH（用户/密码/端口）在 host 上执行单条命令，
// 返回合并后的 stdout+stderr。timeout 约束整个操作。
func sshRun(logger *FetchLogger, host string, port int, user, password, cmd string, timeout time.Duration) (string, error) {
	clientConfig := &ssh.ClientConfig{
		User:            user,
		Auth:            []ssh.AuthMethod{ssh.Password(password)},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
		Timeout:         timeout,
	}

	addr := fmt.Sprintf("%s:%d", host, port)
	client, err := ssh.Dial("tcp", addr, clientConfig)
	if err != nil {
		return "", fmt.Errorf("SSH 连接失败 %s: %w", addr, err)
	}
	defer client.Close()

	session, err := client.NewSession()
	if err != nil {
		return "", fmt.Errorf("创建 SSH 会话失败 %s: %w", addr, err)
	}
	defer session.Close()

	output, err := session.CombinedOutput(cmd)
	outStr := string(output)
	// su 会向 stderr 输出 "Password: " 提示符，这是正常现象，不视为错误。
	if err != nil {
		return outStr, fmt.Errorf("命令执行失败 %s: %w\n输出: %s", addr, err, outStr)
	}
	return outStr, nil
}

// dialSftp 以密码认证直连服务器，返回 SSH 客户端与 SFTP 客户端（用于递归下载）。
func dialSftp(host string, port int, user, password string) (*ssh.Client, *sftp.Client, error) {
	clientConfig := &ssh.ClientConfig{
		User:            user,
		Auth:            []ssh.AuthMethod{ssh.Password(password)},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
	}
	addr := fmt.Sprintf("%s:%d", host, port)
	client, err := ssh.Dial("tcp", addr, clientConfig)
	if err != nil {
		return nil, nil, fmt.Errorf("SSH 连接失败 %s: %w", addr, err)
	}
	sftpClient, err := sftp.NewClient(client)
	if err != nil {
		client.Close()
		return nil, nil, fmt.Errorf("创建 SFTP 客户端失败 %s: %w", addr, err)
	}
	return client, sftpClient, nil
}

// shq 用单引号包裹字符串并转义其中的单引号（shell 安全引用）
func shq(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'"'"'`) + "'"
}

// ================= 节点发现（经网管节点的 ipmc_adm statusapp 自动发现后台节点） =================

// ipv4Regex 用于从 statusapp 输出中提取 IPv4 地址。
var ipv4Regex = regexp.MustCompile(`\b\d{1,3}(\.\d{1,3}){3}\b`)

// DiscoverNodes 连接 cfg.DiscoverHost（网管节点），对 cfg.Services 中的每个服务执行
// ipmc_adm statusapp 查找运行该服务的节点，合并去重所有节点 IP，应用
// cfg.NodeIPMap 翻译（内部 -> 可达），返回可达主机列表。
// 多服务场景：任一服务发现的节点都会并入最终列表（去重）。
func DiscoverNodes(logger *FetchLogger, cfg *FetchConfig) ([]string, error) {
	logger.Info("开始发现服务 %v 所在节点（网管节点: %s）", cfg.Services, cfg.DiscoverHost)

	seen := make(map[string]bool)
	var reachable []string

	for _, service := range cfg.Services {
		discoveryCmd := fmt.Sprintf("echo '%s' | su - ossadm -c \". /opt/cloud/manager/bin/engr_profile.sh; ipmc_adm -cmd statusapp -app %s -nodeip global\"",
			cfg.Password, service)

		output, err := sshRun(logger, cfg.DiscoverHost, sshPort, loginUser, cfg.Password, discoveryCmd, 30*time.Second)
		if err != nil {
			return nil, fmt.Errorf("执行节点发现命令失败（服务 %s）: %w", service, err)
		}

		internal := parseStatusappIPs(output)
		if len(internal) == 0 {
			logger.Info("[警告] 服务 %s 未发现任何节点（可能未部署或服务名有误）", service)
			continue
		}

		for _, ip := range internal {
			if seen[ip] {
				continue
			}
			seen[ip] = true
			target := ip
			if mapped, ok := cfg.NodeIPMap[ip]; ok && mapped != "" {
				target = mapped
				logger.Info("发现节点: %s -> %s（node_ip_map 映射，服务 %s）", ip, target, service)
			} else if reachableIP, derr := discoverNodeReachableIP(logger, cfg, ip); derr == nil {
				target = reachableIP
				logger.Info("发现节点: %s -> %s（自动解析大网 IP，服务 %s）", ip, target, service)
			} else {
				logger.Info("[警告] 节点 %s 自动解析大网 IP 失败: %v，回退使用内部 IP", ip, derr)
			}
			if !seen[target] {
				seen[target] = true
				reachable = append(reachable, target)
			}
		}
	}

	if len(reachable) == 0 {
		return nil, fmt.Errorf("未在服务 %v 上发现任何节点：服务可能未部署，或服务名称有误", cfg.Services)
	}
	return reachable, nil
}

// parseStatusappIPs 从 ipmc_adm statusapp 输出中提取去重后的 IPv4 节点地址。
// 跳过表头（Process Name）与汇总行（All Processes）及无匹配提示（No matched）。
func parseStatusappIPs(output string) []string {
	seen := make(map[string]bool)
	var ips []string
	for _, line := range strings.Split(output, "\n") {
		if strings.Contains(line, "Process Name") {
			continue
		}
		if strings.Contains(line, "All Processes") || strings.Contains(line, "No matched") {
			continue
		}
		for _, ip := range ipv4Regex.FindAllString(line, -1) {
			if !seen[ip] {
				seen[ip] = true
				ips = append(ips, ip)
			}
		}
	}
	return ips
}

// parseBigNetIP 从 ifconfig / ip addr 输出中解析节点的"大网"（可达）IP。
// 排除回环地址与内部 IP 本身；多个候选时优先选择与内部 IP 网段（前两段）不同的地址。
// 无法确定唯一可达 IP 时返回 ("", false)。
func parseBigNetIP(output, internalIP string) (string, bool) {
	ipRe := regexp.MustCompile(`(?m)^\s*inet\s+(\d{1,3}(\.\d{1,3}){3})`)
	internalParts := strings.Split(internalIP, ".")
	seen := make(map[string]bool)
	var candidates []string
	for _, m := range ipRe.FindAllStringSubmatch(output, -1) {
		ip := m[1]
		// 同时执行 ifconfig 与 ip addr 时同一地址会出现两次，需去重。
		if ip == "127.0.0.1" || ip == internalIP || seen[ip] {
			continue
		}
		seen[ip] = true
		candidates = append(candidates, ip)
	}
	if len(candidates) == 0 {
		return "", false
	}
	if len(candidates) == 1 {
		return candidates[0], true
	}
	// 多个候选：优先选择与内部 IP 前两段不同的"大网"地址
	var bigNet []string
	for _, c := range candidates {
		parts := strings.Split(c, ".")
		if (len(parts) >= 2 && len(internalParts) >= 2) && (parts[0] != internalParts[0] || parts[1] != internalParts[1]) {
			bigNet = append(bigNet, c)
		}
	}
	if len(bigNet) == 1 {
		return bigNet[0], true
	}
	return "", false
}

// discoverNodeReachableIP 经网管节点（cfg.DiscoverHost）中转，ssh 到节点内部 IP 执行
// ifconfig/ip addr，自动解析其可达的大网 IP。
// 复用 jumpSSHScript 的 expect 驱动方式在网管节点上发起对内部节点的 ssh。
func discoverNodeReachableIP(logger *FetchLogger, cfg *FetchConfig, internalIP string) (string, error) {
	if cfg.DiscoverHost == "" {
		return "", fmt.Errorf("未配置网管节点（host），无法自动解析节点大网 IP")
	}
	cmd := "ifconfig; echo '===IPADDR==='; ip addr 2>/dev/null"
	script := jumpSSHScript(cfg.Password, loginUser, internalIP, cmd)
	output, err := sshRun(logger, cfg.DiscoverHost, sshPort, loginUser, cfg.Password, script, 60*time.Second)
	if err != nil {
		return "", fmt.Errorf("经网管节点查询 %s 的 ifconfig 失败: %w", internalIP, err)
	}
	if ip, ok := parseBigNetIP(output, internalIP); ok {
		return ip, nil
	}
	return "", fmt.Errorf("无法从 %s 的 ifconfig 输出解析出大网 IP:\n%s", internalIP, output)
}

// ================= 跳板（内网节点经 ssh_jump 中转） =================

// jumpSSHScript 构造在跳板机上执行的 expect 脚本：
// 通过 ssh（交互式输入密码）在目标主机 target 上执行 targetCmd。
// 说明：部分 OSS 环境禁止 direct-tcpip 隧道（nested SSH），
// 但跳板机可用 expect 驱动系统 ssh/scp 完成对目标主机的访问。
func jumpSSHScript(jumpPwd, targetUser, target, targetCmd string) string {
	return fmt.Sprintf(`expect <<'EOF'
set timeout 900
spawn ssh -o StrictHostKeyChecking=no %s@%s "%s"
expect {
  "password:" { send "%s\r"; exp_continue }
  "yes/no" { send "yes\r"; exp_continue }
  eof
}
EOF`, targetUser, target, targetCmd, jumpPwd)
}

// jumpSCPScript 构造在跳板机上执行的 expect 脚本：
// 将跳板机本地文件 localPath 通过 scp（交互式输入密码）从目标主机 remotePath 拉取到跳板机。
// 方向：目标 -> 跳板机（下载场景）。
func jumpSCPScriptDown(jumpPwd, targetUser, target, remotePath, localPath string) string {
	return fmt.Sprintf(`expect <<'EOF'
set timeout 900
spawn scp -o StrictHostKeyChecking=no %s@%s:%s %s
expect {
  "password:" { send "%s\r"; exp_continue }
  "yes/no" { send "yes\r"; exp_continue }
  eof
}
EOF`, targetUser, target, remotePath, localPath, jumpPwd)
}

// jumpRun 通过跳板机 cfg.SshJump 在目标主机 target 上执行 targetCmd，返回输出。
func jumpRun(logger *FetchLogger, cfg *FetchConfig, target, targetCmd string, timeout time.Duration) (string, error) {
	script := jumpSSHScript(cfg.Password, loginUser, target, targetCmd)
	return sshRun(logger, cfg.SshJump, sshPort, loginUser, cfg.Password, script, timeout)
}

// ================= 每台服务器的抓取流程（非交互） =================

// fetchFromHost 在单个节点 host 上抓取所有服务的日志（非交互 SSH）：
//  1. 以 ossuser 把 <log_base>/<服务名> 复制到 /tmp/fetch_<服务>_<时间戳> 暂存并放开读权限
//  2. 经 SFTP（sopuser）递归下载暂存目录并打包 zip、解压、删除中间压缩包
//  3. 以 ossuser 清理远端暂存目录
//
// 当 cfg.SshJump 非空时，走跳板路径：暂存/清理经跳板 ssh，下载经跳板 scp 拉取。
func fetchFromHost(logger *FetchLogger, cfg *FetchConfig, host string) error {
	if cfg.SshJump != "" {
		return fetchFromHostViaJump(logger, cfg, host)
	}

	logger.Info("===== 开始对节点 [%s] 抓取日志 =====", host)

	// 逐个服务：暂存 + 下载 + 清理
	for _, service := range cfg.Services {
		srcDir := logBase + "/" + service
		stage := fmt.Sprintf("/tmp/fetch_%s_%s_%s", service, cfg.Timestamp, host)
		logger.Info("---------- 服务 %s 目录 %s ----------", service, srcDir)

		// 1. 以 ossuser 暂存：清空旧暂存 + 递归复制（-L 跟随符号链接）+ 放开读/遍历权限
		stageCmd := fmt.Sprintf("echo '%s' | su - %s -c 'rm -rf %s && mkdir -p %s && cp -rL %s/. %s/ && chmod -R a+rX %s'",
			cfg.Password, suUser, shq(stage), shq(stage), shq(srcDir), shq(stage), shq(stage))
		if out, err := sshRun(logger, host, sshPort, loginUser, cfg.Password, stageCmd, 600*time.Second); err != nil {
			logger.Error("节点 [%s] 暂存服务 %s 失败: %v\n输出: %s", host, service, err, out)
			continue
		}
		logger.Info("[%s] 服务 %s 已暂存到 %s", host, service, stage)

		// 2. 经 SFTP 递归下载该服务全部文件并打包 zip
		client, sftpClient, err := dialSftp(host, sshPort, loginUser, cfg.Password)
		if err != nil {
			logger.Error("节点 [%s] 建立 SFTP 失败: %v", host, err)
			fetchCleanupRemote(logger, cfg, host, stage)
			continue
		}
		if err := downloadAndZipService(sftpClient, stage, cfg.LocalDir, service, cfg.Timestamp, host, logger); err != nil {
			logger.Error("节点 [%s] 下载/打包失败（服务 %s）: %v", host, service, err)
		}
		sftpClient.Close()
		client.Close()

		// 3. 清理远端暂存目录
		fetchCleanupRemote(logger, cfg, host, stage)
	}

	logger.Info("===== 节点 [%s] 日志抓取完成 =====", host)
	return nil
}

// fetchCleanupRemote 以 ossuser 清理远端暂存目录（/tmp 有粘滞位，sopuser 删不掉）。
func fetchCleanupRemote(logger *FetchLogger, cfg *FetchConfig, host, stage string) {
	cleanCmd := fmt.Sprintf("echo '%s' | su - %s -c 'rm -rf %s'", cfg.Password, suUser, shq(stage))
	if _, err := sshRun(logger, host, sshPort, loginUser, cfg.Password, cleanCmd, 180*time.Second); err != nil {
		logger.Error("清理远端暂存 %s 失败（不影响下载结果）: %v", stage, err)
	} else {
		logger.Info("已清理远端暂存: %s", stage)
	}
}

// fetchFromHostViaJump 通过跳板机对目标节点抓取日志：
//  1. 经跳板 ssh 以 ossuser 暂存 <log_base>/<服务名> 到 /tmp
//  2. 经跳板 scp 把暂存目录从目标节点拉取到跳板机，打包成 zip，再 SFTP 拉回本地
//  3. 经跳板 ssh 以 ossuser 清理远端暂存
//
// 注意：跳板路径下无法直接对目标节点 SFTP 递归下载（nested SSH 受限），
// 改用「目标 -> 跳板机 tar.gz -> 本地 SFTP」两跳拉取。
func fetchFromHostViaJump(logger *FetchLogger, cfg *FetchConfig, host string) error {
	logger.Info("===== 开始对节点 [%s] 抓取日志（跳板: %s）=====", host, cfg.SshJump)

	for _, service := range cfg.Services {
		srcDir := logBase + "/" + service
		stage := fmt.Sprintf("/tmp/fetch_%s_%s_%s", service, cfg.Timestamp, host)
		tarName := fmt.Sprintf("%s_%s_%s.tar.gz", service, cfg.Timestamp, host)
		jumpTar := fmt.Sprintf("/tmp/%s", tarName) // 跳板机上的中间 tar（含节点 IP，避免多节点串行冲突）
		logger.Info("---------- 服务 %s 目录 %s ----------", service, srcDir)

		// 1. 经跳板 ssh 以 ossuser 暂存 + 打包成 tar.gz（放在目标节点 /tmp）
		packCmd := fmt.Sprintf("echo '%s' | su - %s -c 'rm -rf %s && mkdir -p %s && cp -rL %s/. %s/ && chmod -R a+rX %s && tar -czf %s -C %s . && rm -rf %s'",
			cfg.Password, suUser, shq(stage), shq(stage), shq(srcDir), shq(stage), shq(stage),
			shq(jumpTar), shq(stage), shq(stage))
		if out, err := jumpRun(logger, cfg, host, packCmd, 600*time.Second); err != nil {
			logger.Error("节点 [%s] 暂存/打包服务 %s 失败: %v\n输出: %s", host, service, err, out)
			continue
		}
		logger.Info("[%s] 服务 %s 已打包为 %s", host, service, jumpTar)

		// 2. 目标 -> 跳板机：scp 拉取 tar 到跳板机 /tmp
		downScript := jumpSCPScriptDown(cfg.Password, loginUser, host, jumpTar, jumpTar)
		if _, err := sshRun(logger, cfg.SshJump, sshPort, loginUser, cfg.Password, downScript, 15*time.Minute); err != nil {
			logger.Error("跳板机拉取 %s 失败: %v", jumpTar, err)
			fetchCleanupRemoteViaJump(logger, cfg, host, jumpTar, stage)
			continue
		}
		logger.Info("已拉取到跳板机: %s", jumpTar)

		// 3. 跳板机 -> 本地：SFTP 下载 tar，解压成 <服务名>_<时间戳>_<节点IP>/ 目录
		if err := downloadAndExtractTarViaJump(logger, cfg, jumpTar, service, host); err != nil {
			logger.Error("下载/解压 %s 失败: %v", jumpTar, err)
		}

		// 4. 清理：目标节点 tar+暂存，跳板机 tar
		fetchCleanupRemoteViaJump(logger, cfg, host, jumpTar, stage)
		sshRun(logger, cfg.SshJump, sshPort, loginUser, cfg.Password, fmt.Sprintf("rm -f %s", shq(jumpTar)), 60*time.Second)
	}

	logger.Info("===== 节点 [%s] 日志抓取完成 =====", host)
	return nil
}

// fetchCleanupRemoteViaJump 经跳板 ssh 清理目标节点上的 tar 与暂存目录。
func fetchCleanupRemoteViaJump(logger *FetchLogger, cfg *FetchConfig, host, tarPath, stage string) {
	cleanCmd := fmt.Sprintf("echo '%s' | su - %s -c 'rm -f %s && rm -rf %s'", cfg.Password, suUser, shq(tarPath), shq(stage))
	if _, err := jumpRun(logger, cfg, host, cleanCmd, 180*time.Second); err != nil {
		logger.Error("清理远端 %s/%s 失败（不影响下载结果）: %v", tarPath, stage, err)
	} else {
		logger.Info("已清理远端: %s, %s", tarPath, stage)
	}
}

// downloadAndExtractTarViaJump 从跳板机 SFTP 下载 tar 到本地，解压成
// <服务名>_<时间戳>_<节点IP>/ 目录，并删除中间 tar。
// 多节点场景：rootName 含节点 IP，每个节点独立目录，互不覆盖。
func downloadAndExtractTarViaJump(logger *FetchLogger, cfg *FetchConfig, jumpTar, service, host string) error {
	rootName := service + "_" + cfg.Timestamp + "_" + host
	stageDir := filepath.Join(cfg.LocalDir, rootName)
	if err := os.RemoveAll(stageDir); err != nil {
		return err
	}
	if err := os.MkdirAll(stageDir, 0755); err != nil {
		return err
	}

	// SFTP 从跳板机下载 tar 到本地临时文件
	localTar := filepath.Join(os.TempDir(), rootName+".tar.gz")
	client, sftpClient, err := dialSftp(cfg.SshJump, sshPort, loginUser, cfg.Password)
	if err != nil {
		return err
	}
	defer client.Close()
	defer sftpClient.Close()

	remoteFile, err := sftpClient.Open(jumpTar)
	if err != nil {
		return fmt.Errorf("打开跳板机 tar 失败: %w", err)
	}
	defer remoteFile.Close()
	localFile, err := os.Create(localTar)
	if err != nil {
		return err
	}
	defer localFile.Close()
	if _, err := io.Copy(localFile, remoteFile); err != nil {
		return fmt.Errorf("下载 tar 失败: %w", err)
	}
	defer os.Remove(localTar)

	// 解压 tar 到 stageDir（远端用 tar -C stage . 打包，解压即还原日志目录结构）
	if err := extractTarGz(localTar, stageDir); err != nil {
		os.RemoveAll(stageDir)
		return fmt.Errorf("解压 tar 失败: %w", err)
	}

	// 统计文件数与大小
	count, total := countFiles(stageDir)
	if count == 0 {
		os.RemoveAll(stageDir)
		return fmt.Errorf("服务 %s 解压后无任何文件", service)
	}
	logger.Info("服务 %s 共下载 %d 个文件（%.1f KB）", service, count, float64(total)/1024)
	logger.Info("解压完成: %s/%s/", cfg.LocalDir, rootName)
	return nil
}

// countFiles 统计目录下普通文件数与总字节数。
func countFiles(dir string) (int, int64) {
	count := 0
	var total int64
	filepath.Walk(dir, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		if !info.IsDir() {
			count++
			total += info.Size()
		}
		return nil
	})
	return count, total
}

// extractTarGz 将 tar.gz 解压到 destDir。
func extractTarGz(tarPath, destDir string) error {
	f, err := os.Open(tarPath)
	if err != nil {
		return err
	}
	defer f.Close()

	gzr, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	defer gzr.Close()

	tr := tar.NewReader(gzr)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		// zip-slip 防护
		target := filepath.Join(destDir, hdr.Name)
		if !strings.HasPrefix(filepath.Clean(target), filepath.Clean(destDir)+string(os.PathSeparator)) {
			return fmt.Errorf("非法 tar 条目路径: %s", hdr.Name)
		}
		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0755); err != nil {
				return err
			}
		case tar.TypeReg, tar.TypeSymlink:
			if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
				return err
			}
			out, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, os.FileMode(hdr.Mode))
			if err != nil {
				return err
			}
			if _, err := io.Copy(out, tr); err != nil {
				out.Close()
				return err
			}
			out.Close()
		}
	}
	return nil
}

// downloadAndZipService 经 SFTP 递归下载远端暂存目录的全部文件到本地，并打包成 zip。
// 压缩包根目录名 = <服务名>_<时间戳>_<节点IP>，内部结构还原服务日志原目录结构。
// 多节点场景：每个节点产出一个独立目录（rootName 含节点 IP），互不覆盖。
func downloadAndZipService(sftpClient *sftp.Client, remoteStage, localDir, service, ts, host string, logger *FetchLogger) error {
	rootName := service + "_" + ts + "_" + host
	stageDir := filepath.Join(localDir, rootName)
	if err := os.RemoveAll(stageDir); err != nil {
		return err
	}
	if err := os.MkdirAll(stageDir, 0755); err != nil {
		return err
	}

	count := 0
	var total int64
	walker := sftpClient.Walk(remoteStage)
	for walker.Step() {
		if walker.Err() != nil {
			continue
		}
		info := walker.Stat()
		if info == nil || !info.Mode().IsRegular() {
			continue
		}
		rel := strings.TrimPrefix(walker.Path(), remoteStage+"/")
		localPath := filepath.Join(stageDir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(localPath), 0755); err != nil {
			return err
		}
		if err := downloadFile(sftpClient, walker.Path(), localPath); err != nil {
			logger.Error("下载失败: %v（%s）", err, walker.Path())
			continue
		}
		count++
		total += info.Size()
	}
	if count == 0 {
		os.RemoveAll(stageDir)
		return fmt.Errorf("暂存目录 %s 中没有任何可下载的文件", remoteStage)
	}
	logger.Info("服务 %s 共下载 %d 个文件（%.1f KB）", service, count, float64(total)/1024)

	zipPath := filepath.Join(localDir, rootName+".zip")
	if err := zipDir(stageDir, zipPath, rootName); err != nil {
		os.RemoveAll(stageDir)
		return err
	}
	if st, err := os.Stat(zipPath); err == nil {
		logger.Info("打包完成: %s（%.1f KB）", zipPath, float64(st.Size())/1024)
	}
	os.RemoveAll(stageDir)

	// 将 zip 解压到 local_dir，并删除压缩包，最终只保留解压后的日志目录
	if err := unzipZip(zipPath, localDir); err != nil {
		logger.Error("解压失败（服务 %s）: %v", service, err)
	} else {
		if err := os.Remove(zipPath); err != nil {
			logger.Error("删除压缩包失败（服务 %s）: %v", service, err)
		} else {
			logger.Info("解压完成: %s/%s/，已删除压缩包", localDir, rootName)
		}
	}
	return nil
}

// unzipZip 将 zip 解压到 destDir（解压后得到 <服务名>_<时间戳>/ 目录）。
// 带 zip-slip 防护，防止恶意条目写到目录外。
func unzipZip(zipPath, destDir string) error {
	r, err := zip.OpenReader(zipPath)
	if err != nil {
		return err
	}
	defer r.Close()

	for _, f := range r.File {
		fpath := filepath.Join(destDir, f.Name)
		if !strings.HasPrefix(fpath, filepath.Clean(destDir)+string(os.PathSeparator)) {
			return fmt.Errorf("非法解压路径: %s", f.Name)
		}
		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(fpath, 0755); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(fpath), 0755); err != nil {
			return err
		}
		outFile, err := os.OpenFile(fpath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0644)
		if err != nil {
			return err
		}
		rc, err := f.Open()
		if err != nil {
			outFile.Close()
			return err
		}
		_, err = io.Copy(outFile, rc)
		outFile.Close()
		rc.Close()
		if err != nil {
			return err
		}
	}
	return nil
}

// downloadFile 通过 SFTP 将远端文件下载到本地
func downloadFile(sftpClient *sftp.Client, remotePath, localPath string) error {
	remoteFile, err := sftpClient.Open(remotePath)
	if err != nil {
		return err
	}
	defer remoteFile.Close()

	localFile, err := os.Create(localPath)
	if err != nil {
		return err
	}
	defer localFile.Close()

	_, err = io.Copy(localFile, remoteFile)
	return err
}

// zipDir 将 srcDir 目录内容压缩为 zip，压缩包内根目录名称为 rootName。
// 例如 srcDir/<logs> 打包后路径为 rootName/<logs>，解压即还原原目录结构。
func zipDir(srcDir, zipPath, rootName string) error {
	zipFile, err := os.Create(zipPath)
	if err != nil {
		return err
	}
	defer zipFile.Close()

	writer := zip.NewWriter(zipFile)
	defer writer.Close()

	return filepath.Walk(srcDir, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(srcDir, p)
		if err != nil {
			return err
		}
		entry := path.Join(rootName, filepath.ToSlash(rel))
		fw, err := writer.Create(entry)
		if err != nil {
			return err
		}
		f, err := os.Open(p)
		if err != nil {
			return err
		}
		defer f.Close()
		_, err = io.Copy(fw, f)
		return err
	})
}
