package main

import (
	"reflect"
	"strings"
	"testing"
)

// 基于真实环境抓取的 ipmc_adm statusapp 输出格式构造测试样例
const statusappSample = `Process Name          Process Type      App Name          Tenant Name  Process Mode  IP               PID     Status
AppClientService-0-0  AppClientService  AppClientService  manager      cluster       172.28.130.161   254330  RUNNING
AppClientService-1-0  AppClientService  AppClientService  manager      cluster       172.28.130.162   158190  RUNNING

[All Processes: 2] [Running: 2] [Not Running: 0]
`

func TestParseStatusappIPs(t *testing.T) {
	got := parseStatusappIPs(statusappSample)
	want := []string{"172.28.130.161", "172.28.130.162"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("parseStatusappIPs = %v, want %v", got, want)
	}
}

func TestParseStatusappIPsNoMatch(t *testing.T) {
	got := parseStatusappIPs("No matched processes.\n")
	if len(got) != 0 {
		t.Errorf("expected empty result, got %v", got)
	}
}

func TestJumpSSHScript(t *testing.T) {
	s := jumpSSHScript("Changeme_456", "sopuser", "172.28.130.166", "echo hi")
	for _, want := range []string{
		"expect <<'EOF'",
		"spawn ssh -o StrictHostKeyChecking=no sopuser@172.28.130.166",
		`send "Changeme_456\r"`,
		"eof",
		// 退出码透传：ssh 失败时 expect 必须非零退出，否则 sshRun 误报成功
		"lassign [wait] _ _ _ rc",
		"exit $rc",
	} {
		if !strings.Contains(s, want) {
			t.Errorf("jumpSSHScript missing %q:\n%s", want, s)
		}
	}
	// 目标命令应原样嵌入（含管道与 su 切换）
	cmd := "echo 'Changeme_456' | su - ossuser -c 'rm -rf /tmp/fetch_Foo_20260101'"
	s2 := jumpSSHScript("Changeme_456", "sopuser", "172.28.130.166", cmd)
	if !strings.Contains(s2, cmd) {
		t.Errorf("jumpSSHScript did not embed target command:\n%s", s2)
	}
}

func TestJumpSCPScriptDown(t *testing.T) {
	s := jumpSCPScriptDown("Changeme_456", "sopuser", "172.28.130.166", "/tmp/Foo.tar.gz", "/tmp/Foo.tar.gz")
	for _, want := range []string{
		"expect <<'EOF'",
		"spawn scp -o StrictHostKeyChecking=no sopuser@172.28.130.166:/tmp/Foo.tar.gz /tmp/Foo.tar.gz",
		`send "Changeme_456\r"`,
		// 退出码透传：scp 失败（如 Permission denied）时 expect 必须非零退出
		"lassign [wait] _ _ _ rc",
		"exit $rc",
	} {
		if !strings.Contains(s, want) {
			t.Errorf("jumpSCPScriptDown missing %q:\n%s", want, s)
		}
	}
}
