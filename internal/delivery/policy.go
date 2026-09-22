// Package delivery implements bounded, signed outbound webhook delivery.
package delivery

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"time"
)

var ErrDestinationBlocked = errors.New("destination blocked by outbound policy")

// Policy validates both submitted URLs and every freshly resolved socket address.
// Private destinations require explicit CIDRs. Metadata/link-local addresses are
// always blocked, even if an operator supplies an overly broad allowlist.
type Policy struct {
	AllowHTTP    bool
	AllowedCIDRs []netip.Prefix
	resolver     interface {
		LookupNetIP(context.Context, string, string) ([]netip.Addr, error)
	}
}

func (p Policy) ValidateURL(ctx context.Context, raw string) error {
	u, err := p.parse(raw)
	if err != nil {
		return err
	}
	_, err = p.resolve(ctx, u.Hostname())
	return err
}

func (p Policy) parse(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || len(raw) > 2048 || u == nil {
		return nil, ErrDestinationBlocked
	}
	if u.Scheme != "https" && (u.Scheme != "http" || !p.AllowHTTP) {
		return nil, ErrDestinationBlocked
	}
	if u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.Opaque != "" || strings.Contains(u.Hostname(), "%") {
		return nil, ErrDestinationBlocked
	}
	if port := u.Port(); port != "" {
		n, e := strconv.Atoi(port)
		if e != nil || n < 1 || n > 65535 {
			return nil, ErrDestinationBlocked
		}
	}
	return u, nil
}

var prohibited = []netip.Prefix{
	netip.MustParsePrefix("fd00:ec2::/32"), netip.MustParsePrefix("168.63.129.16/32"),
	netip.MustParsePrefix("0.0.0.0/8"), netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("169.254.0.0/16"), netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("192.0.2.0/24"), netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("198.51.100.0/24"), netip.MustParsePrefix("203.0.113.0/24"),
	netip.MustParsePrefix("224.0.0.0/3"), netip.MustParsePrefix("2001::/32"),
	netip.MustParsePrefix("2001:db8::/32"), netip.MustParsePrefix("2002::/16"),
}

func (p Policy) allowed(ip netip.Addr) bool {
	ip = ip.Unmap()
	if !ip.IsValid() || ip.Zone() != "" || ip.IsUnspecified() || ip.IsMulticast() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
		return false
	}
	for _, prefix := range prohibited {
		if prefix.Contains(ip) {
			return false
		}
	}
	if ip.IsPrivate() || ip.IsLoopback() {
		for _, prefix := range p.AllowedCIDRs {
			if prefix.Contains(ip) {
				return true
			}
		}
		return false
	}
	// Only globally routable IPv6; excludes NAT64 and other translation ranges.
	if ip.Is6() && !netip.MustParsePrefix("2000::/3").Contains(ip) {
		return false
	}
	return ip.IsGlobalUnicast()
}

func (p Policy) resolve(ctx context.Context, host string) ([]netip.Addr, error) {
	if ip, err := netip.ParseAddr(host); err == nil {
		if !p.allowed(ip) {
			return nil, ErrDestinationBlocked
		}
		return []netip.Addr{ip}, nil
	}
	resolver := p.resolver
	if resolver == nil {
		resolver = net.DefaultResolver
	}
	ips, err := resolver.LookupNetIP(ctx, "ip", host)
	if err != nil || len(ips) == 0 {
		return nil, errors.New("destination DNS resolution failed")
	}
	for _, ip := range ips {
		if !p.allowed(ip) {
			return nil, ErrDestinationBlocked
		}
	}
	return ips, nil
}

func (p Policy) dial(ctx context.Context, network, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, ErrDestinationBlocked
	}
	ips, err := p.resolve(ctx, host)
	if err != nil {
		return nil, err
	}
	dialer := net.Dialer{Timeout: 3 * time.Second, KeepAlive: 30 * time.Second}
	for _, ip := range ips {
		conn, err := dialer.DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
		if err == nil {
			return conn, nil
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
	}
	return nil, errors.New("destination connection failed")
}

func (p Policy) client(timeout time.Duration) *http.Client {
	return &http.Client{
		Timeout:       timeout,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		Transport: &http.Transport{
			// Intentionally no environment proxy: it would bypass destination validation.
			DialContext: p.dial, ForceAttemptHTTP2: true, MaxIdleConns: 100, MaxIdleConnsPerHost: 8,
			IdleConnTimeout: 60 * time.Second, TLSHandshakeTimeout: 3 * time.Second,
			ResponseHeaderTimeout: timeout, MaxResponseHeaderBytes: 32 << 10,
		},
	}
}
