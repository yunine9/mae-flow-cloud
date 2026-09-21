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
	namespace    = "mae"        // K8s 命名空间固定 mae
	logBase      = "/opt/log"   // 容器内日志基础目录
	containerTmp = "/opt/tmp"   // 容器内可写临时目录（MAE 容器根文件系统只读）
	omPort       = 22           // OM 节点 SSH 端口固定 22
	omLoginUser  = "sopuser"    // OM 节点 SSH 登录用户固定 sopuser（root 不允许直接密码登录）
	omSuUser     = "root"       // OM 节点 su 切换目标（kubectl 需 root 权限），与 sopuser 共用密码
)

type K8sConfig struct {
	OMHost    string // OM 节点 IP
	OMPwd     string // OM 节点 sopuser/root 共用密码
	Service   string // 微服务名（如 FarsService）
	LocalDir  string // 本地保存目录
	Timestamp string // 本次拉取时间戳
}

// ConfigFile 对应 config.toml 文件结构（容器化日志拉取场景）
type ConfigFile struct {
	Host     string `toml:"host"`     // OM 节点 IP
	Pwd      string `toml:"pwd"`      // OM 节点 sopuser/root 共用密码
	Service  string `toml:"service"`  // 微服务名
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
#   fetch-logs-k8s --host 71.26.146.142 \
#                  --pwd <密码> \
#                  --service FarsService

# OM 节点 IP（必填，容器化环境总节点，kubectl 在此节点上）
host = ""

# OM 节点 sopuser/root 共用密码（必填）
# 工具固定以 sopuser 登录 OM 节点，再 su root 执行 kubectl（root 不允许直接密码登录）
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
  fetch-logs-k8s --host <OM节点IP> --pwd <密码> --service <服务名>
                 [--local-dir <目录>]
  # 经 OM 节点 kubectl 发现 Pod 并发抓取所有副本

用法(配置文件, 兼容旧体验):
  fetch-logs-k8s [config.toml路径]        # 缺省读 exe 同目录 config.toml

参数:
  --host       OM 节点 IP（容器化环境总节点, kubectl 在此节点上）
  --pwd        OM 节点 sopuser/root 共用密码(必填, 命令行直传)
  --service    微服务名(如 FarsService、FarsFrontendService、SWMService)
  --local-dir  本地保存目录(默认 local-logs-k8s, 相对 exe 目录)
  --help       显示本帮助

固定值(无需配置): 命名空间 mae、日志路径 /opt/log/<服务名>、容器临时目录 /opt/tmp、
                 OM SSH 端口 22、登录用户 sopuser（su root 执行 kubectl）

优先级: CLI 参数 > 配置文件`)
}

// shq 用单引号包裹字符串并转义其中的单引号（shell 安全引用）
func shq(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'"'"'`) + "'"
}

// sshRun 在 OM 节点上以 sopuser 登录、su root 执行单条命令，返回合并 stdout+stderr。
// OM 节点 root 不允许直接密码登录，固定以 sopuser 登录后 su root（共用密码）执行 kubectl。
func sshRun(logger *K8sLogger, cfg *K8sConfig, cmd string, timeout time.Duration) (string, error) {
	clientConfig := &ssh.ClientConfig{
		User:            omLoginUser,
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
	// 以 sopuser 登录后 su root 执行命令（密码通过 stdin 传给 su，避免进进程列表）
	wrapped := fmt.Sprintf("echo '%s' | su - %s -c %s 2>&1", cfg.OMPwd, omSuUser, shq(cmd))
	out, err := session.CombinedOutput(wrapped)
	return string(out), err
}

// sftpDownload 从 OM 节点下载文件到本地（以 sopuser 登录 SFTP）。
// 前置：远端文件需 sopuser 可读——kubectl cp 落到 OM /tmp 的文件 owner 是 root，
// 调用方须在 cp 后 chmod a+r 放开读权限，否则 sopuser SFTP 读会 Permission denied。
func sftpDownload(cfg *K8sConfig, remotePath, localPath string) error {
	clientConfig := &ssh.ClientConfig{
		User:            omLoginUser,
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

// listPodContainers 列出 Pod 的所有业务容器名（过滤 init 容器）。
// 多容器 Pod（如 accesssouth 含 med/mmlmed/fmmed/...）需遍历每个容器抓日志。
func listPodContainers(logger *K8sLogger, cfg *K8sConfig, pod string) ([]string, error) {
	cmd := fmt.Sprintf("kubectl get pod %s -n %s -o jsonpath=\"{.spec.containers[*].name}\" 2>&1", pod, namespace)
	out, err := sshRun(logger, cfg, cmd, 30*time.Second)
	if err != nil {
		return nil, fmt.Errorf("列出 Pod %s 容器失败: %w\n输出: %s", pod, err, out)
	}
	// sshRun 经 su root 执行，输出首行可能是 "Password:" 提示符——过滤掉
	out = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(out), "Password:"))
	containers := strings.Fields(out)
	// 过滤掉 su 提示符残留（如 "Password:" 被拆分后混入）
	var real []string
	for _, c := range containers {
		if c != "Password:" && !strings.HasPrefix(c, "Password") {
			real = append(real, c)
		}
	}
	if len(real) == 0 {
		return nil, fmt.Errorf("Pod %s 未发现任何业务容器", pod)
	}
	return real, nil
}

// kubectlExecZip 在指定容器内用 zip 打包 /opt/log/ 全部内容到 /opt/tmp/<archive>。
// 多容器 Pod 各容器的日志目录名不同（如 FMDriverService/、textlog/），统一打包整个 /opt/log/。
// 若容器内 /opt/log/ 不存在（部分容器无日志），返回 errNoLogDir 让调用方跳过，不视为失败。
var errNoLogDir = fmt.Errorf("容器内 %s 不存在（该容器无日志）", logBase)

func kubectlExecZip(logger *K8sLogger, cfg *K8sConfig, pod, container, archiveName string) error {
	// 先检查容器内 /opt/log/ 是否存在；部分容器（如 fmmed）无日志目录，跳过
	checkCmd := fmt.Sprintf("kubectl exec %s -n %s -c %s -- sh -c 'test -d %s && echo LOGDIR_OK || echo NO_LOGDIR' 2>&1", pod, namespace, container, logBase)
	checkOut, _ := sshRun(logger, cfg, checkCmd, 30*time.Second)
	if strings.Contains(checkOut, "NO_LOGDIR") {
		logger.Info("[%s/%s] 容器无 %s 目录，跳过", pod, container, logBase)
		return errNoLogDir
	}
	// cd /opt/log && zip -r /opt/tmp/<archive> . —— 打包 /opt/log 全部，zip 内部路径还原原结构
	cmd := fmt.Sprintf("kubectl exec %s -n %s -c %s -- sh -c 'cd %s && zip -r %s/%s . 2>&1 | tail -3'",
		pod, namespace, container, logBase, containerTmp, archiveName)
	out, err := sshRun(logger, cfg, cmd, 5*time.Minute)
	if err != nil {
		return fmt.Errorf("容器内 zip 失败: %w\n输出: %s", err, out)
	}
	logger.Info("[%s/%s] 容器内 zip 完成: %s/%s", pod, container, containerTmp, archiveName)
	return nil
}

// kubectlCpAndSftp: kubectl cp（Pod 容器→OM /tmp/）+ SFTP（OM→本地）
// 注意：kubectl cp 失败时退出码可能仍为 0（如容器内文件不存在），必须 cp 后检查 OM 落地文件是否存在。
func kubectlCpAndSftp(logger *K8sLogger, cfg *K8sConfig, pod, container, containerArchive, localZip string) error {
	// 1. kubectl cp 从指定容器拉到 OM /tmp/（root 执行，落地文件 owner=root）
	omTmp := fmt.Sprintf("/tmp/%s", filepath.Base(containerArchive))
	cpCmd := fmt.Sprintf("kubectl cp %s/%s:%s -c %s %s 2>&1", namespace, pod, containerArchive, container, omTmp)
	out, err := sshRun(logger, cfg, cpCmd, 10*time.Minute)
	if err != nil {
		return fmt.Errorf("kubectl cp 失败: %w\n输出: %s", err, out)
	}
	// 2. 检查 OM 落地文件是否存在（kubectl cp 失败时 exit 可能仍 0）
	lsOut, lsErr := sshRun(logger, cfg, fmt.Sprintf("ls -l %s 2>&1", shq(omTmp)), 15*time.Second)
	if lsErr != nil || strings.Contains(lsOut, "No such file") {
		return fmt.Errorf("kubectl cp 未落地文件 %s（cp 输出: %s）", omTmp, strings.TrimSpace(out))
	}
	logger.Info("[%s/%s] kubectl cp -> OM %s", pod, container, omTmp)
	// 3. chmod a+r 放开读权限：kubectl cp 落地 owner=root，sopuser SFTP 读不了，必须放开
	if out, err := sshRun(logger, cfg, fmt.Sprintf("chmod a+r %s", shq(omTmp)), 30*time.Second); err != nil {
		logger.Error("[%s/%s] chmod a+r %s 失败（不影响下载，可能 SFTP 读失败）: %v\n输出: %s", pod, container, omTmp, err, out)
	}
	// 4. SFTP 从 OM 拉回本地（sopuser 登录）
	if err := sftpDownload(cfg, omTmp, localZip); err != nil {
		return fmt.Errorf("SFTP 下载失败: %w", err)
	}
	logger.Info("[%s/%s] SFTP -> 本地 %s", pod, container, localZip)
	// 5. 清理 OM /tmp/（root 删）
	sshRun(logger, cfg, fmt.Sprintf("rm -f %s", shq(omTmp)), 30*time.Second)
	return nil
}

// kubectlExecRm 清理指定容器内 /opt/tmp/ 压缩包。
func kubectlExecRm(logger *K8sLogger, cfg *K8sConfig, pod, container, archiveName string) {
	cmd := fmt.Sprintf("kubectl exec %s -n %s -c %s -- rm -f %s/%s 2>&1", pod, namespace, container, containerTmp, archiveName)
	sshRun(logger, cfg, cmd, 30*time.Second)
	logger.Info("[%s/%s] 已清理容器内 %s/%s", pod, container, containerTmp, archiveName)
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

// fetchFromPod 抓取单个 Pod 的日志：遍历 Pod 所有业务容器，逐容器 zip → kubectl cp + SFTP 下载 → 解压 → 清理。
// 多容器 Pod（如 accesssouth 含 med/mmlmed/fmmed/...）每个容器日志目录不同，需逐容器抓取。
// 返回 error 供并发调用收集；某 Pod 失败不影响其他 Pod。
func fetchFromPod(logger *K8sLogger, cfg *K8sConfig, pod string) error {
	logger.Info("========== Pod %s 开始抓取 ==========", pod)

	containers, err := listPodContainers(logger, cfg, pod)
	if err != nil {
		return err
	}
	logger.Info("[%s] 发现 %d 个业务容器: %v", pod, len(containers), containers)

	var podErrs []string
	for _, container := range containers {
		// 每个容器独立 archive + 产物目录（含容器名，多容器互不覆盖）
		archiveName := fmt.Sprintf("%s_%s_%s_%s.zip", cfg.Service, cfg.Timestamp, pod, container)
		containerArchive := fmt.Sprintf("%s/%s", containerTmp, archiveName)
		rootName := fmt.Sprintf("%s_%s_%s_%s", cfg.Service, cfg.Timestamp, pod, container)
		stageDir := filepath.Join(cfg.LocalDir, rootName)
		os.MkdirAll(stageDir, 0755)
		localZip := filepath.Join(cfg.LocalDir, archiveName)

		logger.Info("---------- Pod %s 容器 %s ----------", pod, container)
		// 1. 容器内 zip（无日志目录的容器跳过，不视为失败）
		if err := kubectlExecZip(logger, cfg, pod, container, archiveName); err != nil {
			if err == errNoLogDir {
				os.RemoveAll(stageDir) // 清理空产物目录
				continue
			}
			kubectlExecRm(logger, cfg, pod, container, archiveName)
			podErrs = append(podErrs, fmt.Sprintf("%s: %v", container, err))
			continue
		}
		// 2. kubectl cp + SFTP 下载
		if err := kubectlCpAndSftp(logger, cfg, pod, container, containerArchive, localZip); err != nil {
			kubectlExecRm(logger, cfg, pod, container, archiveName)
			podErrs = append(podErrs, fmt.Sprintf("%s: %v", container, err))
			continue
		}
		// 3. 解压
		if err := unzipZip(localZip, stageDir); err != nil {
			logger.Error("[%s/%s] 解压失败: %v", pod, container, err)
			podErrs = append(podErrs, fmt.Sprintf("%s: 解压失败: %v", container, err))
		} else {
			os.Remove(localZip)
			logger.Info("[%s/%s] 解压完成: %s/%s/", pod, container, cfg.LocalDir, rootName)
		}
		// 4. 清理容器内
		kubectlExecRm(logger, cfg, pod, container, archiveName)
	}

	if len(podErrs) > 0 {
		logger.Info("========== Pod %s 抓取完成（%d/%d 容器失败）==========", pod, len(podErrs), len(containers))
		return fmt.Errorf("Pod %s 部分容器失败:\n  - %s", pod, strings.Join(podErrs, "\n  - "))
	}
	logger.Info("========== Pod %s 抓取完成（%d 容器全部成功）==========", pod, len(containers))
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
	var cliHost, cliPwd, cliService, cliLocalDir string
	var showHelp bool
	fs.StringVar(&cliHost, "host", "", "OM 节点 IP")
	fs.StringVar(&cliPwd, "pwd", "", "OM 节点 sopuser/root 共用密码")
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
		fmt.Println("或直接用命令行参数: fetch-logs-k8s --host <OM IP> --pwd <密码> --service <服务名>")
		fmt.Println("========================================")
		os.Exit(1)
	}

	// CLI 显式值 > 配置文件
	if cliHost != "" {
		cfgFile.Host = cliHost
	}
	if cliPwd != "" {
		cfgFile.Pwd = cliPwd
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
			missing = append(missing, "--pwd")
		}
		if cfgFile.Service == "" {
			missing = append(missing, "--service(微服务名)")
		}
		logger.Error("缺少必填参数: %s", strings.Join(missing, "、"))
		os.Exit(1)
	}

	// 默认值
	if cfgFile.LocalDir == "" {
		cfgFile.LocalDir = "local-logs-k8s"
	}

	cfg := &K8sConfig{
		OMHost:    cfgFile.Host,
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

	logger.Info("OM 节点: %s（%s 登录 su %s）, 服务: %s, 命名空间: %s", cfg.OMHost, omLoginUser, omSuUser, cfg.Service, namespace)

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
