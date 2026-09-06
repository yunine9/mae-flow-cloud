package main

import (
	"os"
	"testing"
)

// 环境集成测试：仅在显式设置 FETCH_LOGS_ENV_TEST=1 时运行（默认跳过）。
// 用于在真实 OSS 环境上做非破坏性节点发现验证。
//
// 运行前请把下面的常量改成真实环境值：
//
//	FETCH_LOGS_ENV_TEST=1 go test -run TestDiscoverNodesEnv -v

const envTestDiscoverHost = "141.71.105.2" // 网管节点 IP
const envTestPwd = "Changeme_456"      // sopuser/ossuser 共用密码
const envTestService = "FarsWebsite"   // 真实部署的服务名

func envTestEnabled() bool {
	return os.Getenv("FETCH_LOGS_ENV_TEST") == "1"
}

// TestDiscoverNodesEnv 对真实部署的服务做自动发现验证。
// 期望 statusapp 返回至少一个节点，且每个内部 IP 都能解析出可达 IP（或经 node_ip_map 映射）。
func TestDiscoverNodesEnv(t *testing.T) {
	if !envTestEnabled() {
		t.Skip("FETCH_LOGS_ENV_TEST not set; skipping env integration test")
	}
	logger := &FetchLogger{}
	cfg := &FetchConfig{
		Services:     []string{envTestService},
		Password:     envTestPwd,
		DiscoverHost: envTestDiscoverHost,
	}
	nodes, err := DiscoverNodes(logger, cfg)
	if err != nil {
		t.Fatalf("DiscoverNodes failed: %v\n日志:\n%s", err, logger.GetLogs())
	}
	if len(nodes) == 0 {
		t.Fatalf("DiscoverNodes returned no nodes\n日志:\n%s", logger.GetLogs())
	}
	t.Logf("发现节点: %v", nodes)
	for _, n := range nodes {
		t.Logf("  节点: %s", n)
	}
}
