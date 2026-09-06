package main

import (
	"archive/zip"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/BurntSushi/toml"
	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

// 固定值（容器化环境，不开放配置）
const (
	namespace  = "mae"        // K8s 命名空间固定 mae
	logBase    = "/opt/log"   // 容器内日志基础目录
	containerTmp = "/opt/tmp" // 容器内可写临时目录（MAE 容器根文件系统只读）
	omPort     = 22           // OM 节点 SSH 端口固定 22
)

type K8sConfig struct {
	OMHost    string // OM 节点 IP
	OMUser    string // OM 节点 SSH 用户（默认 root）
	OMPwd     string // OM 节点 SSH 密码
	Service   string // 微服务名（如 FarsService）
	LocalDir  string // 本地保存目录
	Timestamp string // 本次拉取时间戳
}

// ConfigFile 对应 config.toml 文件结构（容器化日志拉取场景）
type ConfigFile struct {
	Host    string `toml:"host"`    // OM 节点 IP
	User    string `toml:"user"`    // OM 节点 SSH 用户（默认 root）
	Pwd     string `toml:"pwd"`     // OM 节点 SSH 密码
	Service string `toml:"service"` // 微服务名
	LocalDir string `toml:"local_dir"` // 本地保存目录
}

type K8sLogger struct {
	mu   sync.Mutex
	logs []string
}

func (l *K8sLogger) Info(format string, args ...interface{}) {
	msg := fmt.Sprintf("[INFO] "+format, args...)
	l.mu.Lock()
	l.logs = append(l.logs, msg)
	l.mu.Unlock()
	fmt.Println(msg)
}

func (l *K8sLogger) Error(format string, args ...interface{}) {
	msg := fmt.Sprintf("[ERROR] "+format, args...)
	l.mu.Lock()
	l.logs = append(l.logs, msg)
	l.mu.Unlock()
	fmt.Println(msg)
}

func (l *K8sLogger) GetLogs() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return strings.Join(l.logs, "\n")
}

// createDefaultConfig 生成带注释示例的 config.toml 模板
func createDefaultConfig(filePath string) error {
	content := `# fetch-logs-k8s 配置文件（容器化日志拉取）
# 请根据实际情况修改以下配置项
#
# 提示: 所有配置项都支持命令行参数直传(免维护本文件), CLI 值优先于本文件:
#   fetch-logs-k8s --host 71.26.146.142 --user root \
#                  --pwd <密码或环境变量 FETCH_LOGS_K8S_PWD> \
#                  --service FarsService

# OM 节点 IP（必填，容器化环境总节点，kubectl 在此节点上）
host = ""

# OM 节点 SSH 用户（默认 root）
user = "root"

# OM 节点 SSH 密码（必填）
pwd = ""

# 微服务名（必填，如 FarsService、FarsFrontendService、SWMService）
service = ""

# 本地保存目录（默认 local-logs-k8s，位于 exe 同目录下）
# 产出解压后的日志目录: <服务名>_<拉取时间戳>_<pod名>/（每 Pod 一个独立目录）
local_dir = "local-logs-k8s"
`
	return os.WriteFile(filePath, []byte(content), 0644)
}

// usageFetchLogsK8s 打印用法
func usageFetchLogsK8s() {
	fmt.Println(`fetch-logs-k8s — 从容器化环境(K8s)抓取微服务日志到本地

用法(AI/脚本友好, 全参数直传):
  fetch-logs-k8s --host <OM节点IP> --user root --pwd <密码> --service <服务名>
                 [--local-dir <目录>]
  # 经 OM 节点 kubectl 发现 Pod 并发抓取所有副本

用法(配置文件, 兼容旧体验):
  fetch-logs-k8s [config.toml路径]        # 缺省读 exe 同目录 config.toml

参数:
  --host       OM 节点 IP（容器化环境总节点, kubectl 在此节点上）
  --user       OM 节点 SSH 用户(默认 root)
  --pwd        OM 节点 SSH 密码; 缺省读环境变量 FETCH_LOGS_K8S_PWD,
               再缺省回落 config.toml。命令行明文密码会进进程列表,
               自动化场景建议用环境变量
  --service    微服务名(如 FarsService、FarsFrontendService、SWMService)
  --local-dir  本地保存目录(默认 local-logs-k8s, 相对 exe 目录)
  --help       显示本帮助

固定值(无需配置): 命名空间 mae、日志路径 /opt/log/<服务名>、容器临时目录 /opt/tmp、OM SSH 端口 22

优先级: CLI 参数 > 环境变量(密码) > 配置文件`)
}

// sshRun 在 OM 节点上执行单条命令，返回合并 stdout+stderr。
func sshRun(logger *K8sLogger, cfg *K8sConfig, cmd string, timeout time.Duration) (string, error) {
	clientConfig := &ssh.ClientConfig{
		User:            cfg.OMUser,
		Auth:            []ssh.AuthMethod{ssh.Password(cfg.OMPwd)},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
		Timeout:         timeout,
	}
	addr := fmt.Sprintf("%s:%d", cfg.OMHost, omPort)
	client, err := ssh.Dial("tcp", addr, clientConfig)
	if err != nil {
		return "", fmt.Errorf("SSH 连接失败 %s: %w", addr, err)
	}
	defer client.Close()
	session, err := client.NewSession()
	if err != nil {
		return "", err
	}
	defer session.Close()
	out, err := session.CombinedOutput(cmd)
	return string(out), err
}

// sftpDownload 从 OM 节点下载文件到本地。
func sftpDownload(cfg *K8sConfig, remotePath, localPath string) error {
	clientConfig := &ssh.ClientConfig{
		User:            cfg.OMUser,
		Auth:            []ssh.AuthMethod{ssh.Password(cfg.OMPwd)},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
	}
	addr := fmt.Sprintf("%s:%d", cfg.OMHost, omPort)
	client, err := ssh.Dial("tcp", addr, clientConfig)
	if err != nil {
		return fmt.Errorf("SSH 连接失败 %s: %w", addr, err)
	}
	defer client.Close()
	sftpClient, err := sftp.NewClient(client)
	if err != nil {
		return err
	}
	defer sftpClient.Close()
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

// kubectlGetPods 在 OM 上跑 kubectl get pods，返回原始输出。
func kubectlGetPods(logger *K8sLogger, cfg *K8sConfig) (string, error) {
	cmd := fmt.Sprintf("kubectl get pods -n %s -o wide --no-headers 2>&1", namespace)
	return sshRun(logger, cfg, cmd, 30*time.Second)
}

// parsePods 从 kubectl get pods 输出中解析匹配服务名且 Running 的 Pod 名。
// Pod 格式: NAME READY STATUS RESTARTS AGE IP NODE ...
func parsePods(output, serviceName string) []string {
	serviceLower := strings.ToLower(serviceName)
	var pods []string
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "NAME") || strings.HasPrefix(line, "No resources") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		podName := fields[0]
		status := fields[2]
		if status != "Running" {
			continue
		}
		// Pod 名包含服务名（不区分大小写）
		if strings.Contains(strings.ToLower(podName), serviceLower) {
			pods = append(pods, podName)
		}
	}
	return pods
}

// kubectlExecZip 在容器内用 zip 打包 /opt/log/<service>/ 到 /opt/tmp/<archive>。
func kubectlExecZip(logger *K8sLogger, cfg *K8sConfig, pod, archiveName string) error {
	// cd /opt/log && zip -r /opt/tmp/<archive> <ServiceName>/  —— zip 内部路径为 <ServiceName>/...
	cmd := fmt.Sprintf("kubectl exec %s -n %s -- sh -c 'cd %s && zip -r %s/%s %s/ 2>&1 | tail -3'",
		pod, namespace, logBase, containerTmp, archiveName, cfg.Service)
	out, err := sshRun(logger, cfg, cmd, 5*time.Minute)
	if err != nil {
		return fmt.Errorf("容器内 zip 失败: %w\n输出: %s", err, out)
	}
	logger.Info("[%s] 容器内 zip 完成: %s/%s", pod, containerTmp, archiveName)
	return nil
}

// kubectlCpAndSftp: kubectl cp（Pod→OM /tmp/）+ SFTP（OM→本地）
func kubectlCpAndSftp(logger *K8sLogger, cfg *K8sConfig, pod, containerArchive, localZip string) error {
	// 1. kubectl cp 从 Pod 拉到 OM /tmp/
	omTmp := fmt.Sprintf("/tmp/%s", filepath.Base(containerArchive))
	cpCmd := fmt.Sprintf("kubectl cp %s/%s:%s %s 2>&1", namespace, pod, containerArchive, omTmp)
	out, err := sshRun(logger, cfg, cpCmd, 10*time.Minute)
	if err != nil {
		return fmt.Errorf("kubectl cp 失败: %w\n输出: %s", err, out)
	}
	logger.Info("[%s] kubectl cp -> OM %s", pod, omTmp)
	// 2. SFTP 从 OM 拉回本地
	if err := sftpDownload(cfg, omTmp, localZip); err != nil {
		return fmt.Errorf("SFTP 下载失败: %w", err)
	}
	logger.Info("[%s] SFTP -> 本地 %s", pod, localZip)
	// 3. 清理 OM /tmp/
	sshRun(logger, cfg, fmt.Sprintf("rm -f %s", omTmp), 30*time.Second)
	return nil
}

// kubectlExecRm 清理容器内 /opt/tmp/ 压缩包。
func kubectlExecRm(logger *K8sLogger, cfg *K8sConfig, pod, archiveName string) {
	cmd := fmt.Sprintf("kubectl exec %s -n %s -- rm -f %s/%s 2>&1", pod, namespace, containerTmp, archiveName)
	sshRun(logger, cfg, cmd, 30*time.Second)
	logger.Info("[%s] 已清理容器内 %s/%s", pod, containerTmp, archiveName)
}

// unzipZip 将 zip 解压到 destDir。
func unzipZip(zipPath, destDir string) error {
	r, err := zip.OpenReader(zipPath)
	if err != nil {
		return err
	}
	defer r.Close()
	for _, f := range r.File {
		fpath := filepath.Join(destDir, f.Name)
		if !strings.HasPrefix(filepath.Clean(fpath), filepath.Clean(destDir)+string(os.PathSeparator)) {
			return fmt.Errorf("非法解压路径: %s", f.Name)
		}
		if f.FileInfo().IsDir() {
			os.MkdirAll(fpath, 0755)
			continue
		}
		os.MkdirAll(filepath.Dir(fpath), 0755)
		outFile, err := os.OpenFile(fpath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0644)
		if err != nil {
			return err
		}
		rc, err := f.Open()
		if err != nil {
			outFile.Close()
			return err
		}
		io.Copy(outFile, rc)
		outFile.Close()
		rc.Close()
	}
	return nil
}

// maxConcurrency 限制多 Pod 并发抓取的最大并发数。
const maxConcurrency = 5

// fetchFromPod 抓取单个 Pod 的日志：容器内 zip → kubectl cp + SFTP 下载 → 解压 → 清理。
// 返回 error 供并发调用收集；某 Pod 失败不影响其他 Pod。
func fetchFromPod(logger *K8sLogger, cfg *K8sConfig, pod string) error {
	logger.Info("========== Pod %s 开始抓取 ==========", pod)

	archiveName := fmt.Sprintf("%s_%s_%s.zip", cfg.Service, cfg.Timestamp, pod)
	containerArchive := fmt.Sprintf("%s/%s", containerTmp, archiveName)

	// 1. 容器内 zip
	if err := kubectlExecZip(logger, cfg, pod, archiveName); err != nil {
		kubectlExecRm(logger, cfg, pod, archiveName)
		return err
	}

	// 2. kubectl cp + SFTP 下载
	rootName := fmt.Sprintf("%s_%s_%s", cfg.Service, cfg.Timestamp, pod)
	stageDir := filepath.Join(cfg.LocalDir, rootName)
	os.MkdirAll(stageDir, 0755)
	localZip := filepath.Join(cfg.LocalDir, archiveName)
	if err := kubectlCpAndSftp(logger, cfg, pod, containerArchive, localZip); err != nil {
		kubectlExecRm(logger, cfg, pod, archiveName)
		return err
	}

	// 3. 解压
	if err := unzipZip(localZip, stageDir); err != nil {
		logger.Error("[%s] 解压失败: %v", pod, err)
	} else {
		os.Remove(localZip)
		logger.Info("[%s] 解压完成: %s/%s/", pod, cfg.LocalDir, rootName)
	}

	// 4. 清理容器内
	kubectlExecRm(logger, cfg, pod, archiveName)

	logger.Info("========== Pod %s 抓取完成 ==========", pod)
	return nil
}

func main() {
	logger := &K8sLogger{}

	exePath, err := os.Executable()
	if err != nil {
		logger.Error("无法获取可执行文件路径: %v", err)
		os.Exit(1)
	}
	defaultConfig := filepath.Join(filepath.Dir(exePath), "config.toml")

	fs := flag.NewFlagSet("fetch-logs-k8s", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	var cliHost, cliUser, cliPwd, cliService, cliLocalDir string
	var showHelp bool
	fs.StringVar(&cliHost, "host", "", "OM 节点 IP")
	fs.StringVar(&cliUser, "user", "", "OM 节点 SSH 用户(默认 root)")
	fs.StringVar(&cliPwd, "pwd", "", "OM 节点 SSH 密码")
	fs.StringVar(&cliService, "service", "", "微服务名(如 FarsService)")
	fs.StringVar(&cliLocalDir, "local-dir", "", "本地保存目录")
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
		usageFetchLogsK8s()
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
		fmt.Println("请编辑该文件，填写实际的 host、pwd、service 等信息后重新运行；")
		fmt.Println("或直接用命令行参数: fetch-logs-k8s --host <OM IP> --user root --pwd <密码> --service <服务名>")
		fmt.Println("========================================")
		os.Exit(1)
	}

	// CLI 显式值 > 环境变量(密码) > 配置文件
	if cliHost != "" {
		cfgFile.Host = cliHost
	}
	if cliUser != "" {
		cfgFile.User = cliUser
	}
	if cliPwd != "" {
		cfgFile.Pwd = cliPwd
	} else if env := os.Getenv("FETCH_LOGS_K8S_PWD"); env != "" {
		cfgFile.Pwd = env
	}
	if cliService != "" {
		cfgFile.Service = cliService
	}
	if cliLocalDir != "" {
		cfgFile.LocalDir = cliLocalDir
	}

	// 必填校验
	if cfgFile.Host == "" || cfgFile.Pwd == "" || cfgFile.Service == "" {
		usageFetchLogsK8s()
		fmt.Println()
		var missing []string
		if cfgFile.Host == "" {
			missing = append(missing, "--host(OM 节点 IP)")
		}
		if cfgFile.Pwd == "" {
			missing = append(missing, "--pwd 或环境变量 FETCH_LOGS_K8S_PWD")
		}
		if cfgFile.Service == "" {
			missing = append(missing, "--service(微服务名)")
		}
		logger.Error("缺少必填参数: %s", strings.Join(missing, "、"))
		os.Exit(1)
	}

	// 默认值
	if cfgFile.User == "" {
		cfgFile.User = "root"
	}
	if cfgFile.LocalDir == "" {
		cfgFile.LocalDir = "local-logs-k8s"
	}

	cfg := &K8sConfig{
		OMHost:    cfgFile.Host,
		OMUser:    cfgFile.User,
		OMPwd:     cfgFile.Pwd,
		Service:   cfgFile.Service,
		LocalDir:  cfgFile.LocalDir,
		Timestamp: time.Now().Format("20060102150405"),
	}
	// local-dir 相对路径解析到 exe 同目录
	if !filepath.IsAbs(cfg.LocalDir) {
		cfg.LocalDir = filepath.Join(filepath.Dir(exePath), cfg.LocalDir)
	}
	os.MkdirAll(cfg.LocalDir, 0755)

	logger.Info("OM 节点: %s@%s, 服务: %s, 命名空间: %s", cfg.OMUser, cfg.OMHost, cfg.Service, namespace)

	// 1. 发现 Pod
	logger.Info("========== 发现 Pod ==========")
	output, err := kubectlGetPods(logger, cfg)
	if err != nil {
		logger.Error("kubectl get pods 失败: %v", err)
		os.Exit(1)
	}
	pods := parsePods(output, cfg.Service)
	if len(pods) == 0 {
		logger.Error("未发现服务 %s 的 Running Pod", cfg.Service)
		os.Exit(1)
	}
	logger.Info("发现 %d 个 Pod: %v", len(pods), pods)

	// 多 Pod 并发抓取（信号量限并发上限，某 Pod 失败不影响其他 Pod）
	logger.Info("========== 开始并发抓取 %d 个 Pod（并发度上限 %d）==========", len(pods), maxConcurrency)

	var wg sync.WaitGroup
	sem := make(chan struct{}, maxConcurrency)
	var errMu sync.Mutex
	var errs []string

	for _, pod := range pods {
		wg.Add(1)
		go func(p string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			if err := fetchFromPod(logger, cfg, p); err != nil {
				logger.Error("Pod %s 抓取失败: %v", p, err)
				errMu.Lock()
				errs = append(errs, fmt.Sprintf("%s: %v", p, err))
				errMu.Unlock()
			}
		}(pod)
	}
	wg.Wait()

	if len(errs) > 0 {
		logger.Error("%d/%d 个 Pod 抓取失败:\n  - %s", len(errs), len(pods), strings.Join(errs, "\n  - "))
		fmt.Println("\n=== 日志 ===")
		fmt.Println(logger.GetLogs())
		os.Exit(1)
	}
	logger.Info("=== 全部 %d 个 Pod 抓取完成 ===", len(pods))
	fmt.Println("\n=== 日志 ===")
	fmt.Println(logger.GetLogs())
}
