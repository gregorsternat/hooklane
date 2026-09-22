package delivery

import (
	"context"
	"net/netip"
	"testing"
)

type testResolver struct {
	answers [][]netip.Addr
	calls   int
}

func (r *testResolver) LookupNetIP(context.Context, string, string) ([]netip.Addr, error) {
	i := r.calls
	if i >= len(r.answers) {
		i = len(r.answers) - 1
	}
	r.calls++
	return r.answers[i], nil
}

func TestDestinationPolicy(t *testing.T) {
	public := &testResolver{answers: [][]netip.Addr{{netip.MustParseAddr("93.184.215.14")}}}
	p := Policy{resolver: public}
	for _, raw := range []string{
		"http://example.com/hook", "file:///etc/passwd", "https://user:password@example.com/hook",
		"https://example.com/hook?token=secret", "https://example.com/hook#fragment", "https://localhost:0",
		"https://127.0.0.1/hook", "https://10.0.0.1/hook", "https://169.254.169.254/latest/meta-data",
		"https://[fd00:ec2::254]/", "https://168.63.129.16/", "https://[::1]/", "https://[::ffff:127.0.0.1]/", "https://[fe80::1%25lo0]/", "https://100.100.100.200/",
		"https://[64:ff9b::a9fe:a9fe]/", "https://[2002:7f00:1::]/", "https://192.0.2.1/",
	} {
		t.Run(raw, func(t *testing.T) {
			if err := p.ValidateURL(context.Background(), raw); err == nil {
				t.Fatal("unsafe destination accepted")
			}
		})
	}
	if err := p.ValidateURL(context.Background(), "https://example.com/hook"); err != nil {
		t.Fatal(err)
	}
}

func TestPrivateCIDROptInIsNarrow(t *testing.T) {
	p := Policy{AllowHTTP: true, AllowedCIDRs: []netip.Prefix{netip.MustParsePrefix("127.0.0.1/32"), netip.MustParsePrefix("10.20.0.0/16"), netip.MustParsePrefix("169.254.0.0/16"), netip.MustParsePrefix("fc00::/7")}}
	for _, ip := range []string{"127.0.0.1", "10.20.1.3"} {
		if !p.allowed(netip.MustParseAddr(ip)) {
			t.Errorf("explicit destination %s blocked", ip)
		}
	}
	for _, ip := range []string{"127.0.0.2", "10.30.1.3", "169.254.169.254", "fd00:ec2::254"} {
		if p.allowed(netip.MustParseAddr(ip)) {
			t.Errorf("unapproved destination %s accepted", ip)
		}
	}
	if err := p.ValidateURL(context.Background(), "http://127.0.0.1:4567/hook"); err != nil {
		t.Fatal(err)
	}
}

func TestMixedDNSAnswerRejected(t *testing.T) {
	p := Policy{resolver: &testResolver{answers: [][]netip.Addr{{netip.MustParseAddr("93.184.215.14"), netip.MustParseAddr("127.0.0.1")}}}}
	if err := p.ValidateURL(context.Background(), "https://example.com"); err == nil {
		t.Fatal("mixed public/private DNS response accepted")
	}
}

func TestDNSRebindingRecheckedAtDial(t *testing.T) {
	p := Policy{resolver: &testResolver{answers: [][]netip.Addr{{netip.MustParseAddr("93.184.215.14")}, {netip.MustParseAddr("127.0.0.1")}}}}
	if err := p.ValidateURL(context.Background(), "https://example.com"); err != nil {
		t.Fatal(err)
	}
	if conn, err := p.dial(context.Background(), "tcp", "example.com:443"); err == nil {
		_ = conn.Close()
		t.Fatal("rebound private address connected")
	}
}
