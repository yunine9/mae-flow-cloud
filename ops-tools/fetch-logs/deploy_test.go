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
	} {
		if !strings.Contains(s, want) {
			t.Errorf("jumpSCPScriptDown missing %q:\n%s", want, s)
		}
	}
}

// 基于真实 OSS 节点 ifconfig 输出构造的样例：
// eth0 为内部 IP（172.28.130.165），eth1 为大网 IP（141.71.105.5），lo 为回环。
const bigNetIfconfigSample = `eth0: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500
        inet 172.28.130.165  netmask 255.255.240.0  broadcast 172.28.143.255
        inet6 fe80::f816:3eff:fe46:cee5  prefixlen 64  scopeid 0x20<link>
        ether fa:16:3e:46:ce:e5  txqueuelen 1000  (Ethernet)
eth1: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500
        inet 141.71.105.5  netmask 255.255.248.0  broadcast 141.71.111.255
        inet6 fe80::f816:3eff:fe48:f3f2  prefixlen 64  scopeid 0x20<link>
        ether fa:16:3e:48:f3:f2  txqueuelen 1000  (Ethernet)
lo: flags=73<UP,LOOPBACK,RUNNING>  mtu 65536
        inet 127.0.0.1  netmask 255.0.0.0
`

// TestParseBigNetIP 覆盖 parseBigNetIP 从 ifconfig/ip addr 输出解析大网（可达）IP 的语义。
func TestParseBigNetIP(t *testing.T) {
	const internalIP = "172.28.130.165"

	tests := []struct {
		name   string
		output string
		wantIP string
		wantOK bool
	}{
		{name: "双网卡", output: bigNetIfconfigSample, wantIP: "141.71.105.5", wantOK: true},
		{
			name: "ip addr 格式",
			output: `2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc pfifo_fast state UP group default qlen 1000
    inet 172.28.130.165/20 brd 172.28.143.255 scope global eth0
3: eth1: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc pfifo_fast state UP group default qlen 1000
    inet 141.71.105.5/21 brd 141.71.111.255 scope global eth1
`,
			wantIP: "141.71.105.5",
			wantOK: true,
		},
		{
			name: "仅内部IP单网卡",
			output: `eth0: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500
        inet 172.28.130.165  netmask 255.255.240.0  broadcast 172.28.143.255
lo: flags=73<UP,LOOPBACK,RUNNING>  mtu 65536
        inet 127.0.0.1  netmask 255.0.0.0
`,
			wantIP: "",
			wantOK: false,
		},
		{
			name: "回环仅含",
			output: `lo: flags=73<UP,LOOPBACK,RUNNING>  mtu 65536
        inet 127.0.0.1  netmask 255.0.0.0
`,
			wantIP: "",
			wantOK: false,
		},
		{name: "无匹配", output: "Authorized users only. All activities may be monitored and reported.\n", wantIP: "", wantOK: false},
		{
			name: "多候选歧义",
			output: `eth0: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500
        inet 172.28.130.165  netmask 255.255.240.0  broadcast 172.28.143.255
eth1: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500
        inet 141.71.105.5  netmask 255.255.248.0  broadcast 141.71.111.255
eth2: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500
        inet 10.0.0.5  netmask 255.255.255.0  broadcast 10.0.0.255
`,
			wantIP: "",
			wantOK: false,
		},
		{
			// 回归用例：工具同时执行 ifconfig 与 ip addr，同一地址会各出现一次，
			// 必须先对候选去重，否则 141.71.105.5 重复导致"多候选歧义"而解析失败。
			name: "ifconfig+ip addr 双输出去重",
			output: bigNetIfconfigSample + `===IPADDR===
1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN group default qlen 1000
    inet 127.0.0.1/8 scope host lo
2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc fq_codel state UP group default qlen 1000
    inet 172.28.130.165/20 brd 172.28.143.255 scope global eth0
3: eth1: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc fq_codel state UP group default qlen 1000
    inet 141.71.105.5/21 brd 141.71.111.255 scope global eth1
`,
			wantIP: "141.71.105.5",
			wantOK: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotIP, gotOK := parseBigNetIP(tt.output, internalIP)
			if gotIP != tt.wantIP || gotOK != tt.wantOK {
				t.Errorf("parseBigNetIP = (%q, %v), want (%q, %v)", gotIP, gotOK, tt.wantIP, tt.wantOK)
			}
		})
	}
}
