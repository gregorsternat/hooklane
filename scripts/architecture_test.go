package scripts

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

const module = "github.com/gregorsternat/hooklane/"

// Keep explicit edges: adding a package requires an architecture decision, not
// a broad prefix exception. Test imports follow the same dependency direction.
var allowed = map[string][]string{
	"cmd/api":             {"internal/config", "internal/httpserver", "internal/delivery", "internal/store"},
	"internal/config":     {},
	"internal/httpserver": {"internal/store"},
	"internal/delivery":   {"internal/store"},
	"internal/store":      {"internal/store/sqlc"},
	"internal/store/sqlc": {},
}

func violations(pkg, filename string, source []byte) ([]string, error) {
	if source == nil {
		var err error
		source, err = os.ReadFile(filename)
		if err != nil {
			return nil, err
		}
	}
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, filename, source, 0)
	if err != nil {
		return nil, err
	}
	var issues []string
	report := func(pos token.Pos, message string) {
		issues = append(issues, fset.Position(pos).String()+": "+message)
	}
	edges, known := allowed[pkg]
	if !known {
		report(f.Pos(), "unmapped package; document its responsibility in docs/architecture.md and add explicit edges in scripts/architecture_test.go")
	}
	production := !strings.HasSuffix(filename, "_test.go")
	configDriver := ""
	for _, imp := range f.Imports {
		path, err := strconv.Unquote(imp.Path.Value)
		if err != nil {
			return nil, err
		}
		if strings.HasPrefix(path, module) {
			target := strings.TrimPrefix(path, module)
			ok := target == pkg // external-package tests may import their subject
			for _, edge := range edges {
				ok = ok || target == edge
			}
			if !ok {
				report(imp.Pos(), "forbidden dependency "+pkg+" -> "+target+"; move wiring to cmd/api or consume the documented boundary (docs/principles.md)")
			}
		}
		configParser := pkg == "internal/config" && path == "github.com/jackc/pgx/v5/pgxpool"
		if configParser {
			configDriver = "pgxpool"
			if imp.Name != nil {
				configDriver = imp.Name.Name
			}
			if configDriver == "." {
				report(imp.Pos(), "config may only use pgxpool.ParseConfig; do not dot-import the database driver")
			}
		}
		if (strings.HasPrefix(path, "github.com/jackc/pgx/") || strings.HasPrefix(path, "github.com/pressly/goose/") || path == "database/sql") && pkg != "cmd/api" && pkg != "internal/store" && pkg != "internal/store/sqlc" && !configParser {
			report(imp.Pos(), "database access belongs in internal/store; consume its interface instead")
		}
		if production && path == "log" {
			report(imp.Pos(), "use structured log/slog instead of legacy log; never log secrets or payloads")
		}
	}
	if configDriver != "" {
		ast.Inspect(f, func(n ast.Node) bool {
			if sel, ok := n.(*ast.SelectorExpr); ok {
				if id, ok := sel.X.(*ast.Ident); ok && id.Name == configDriver && sel.Sel.Name != "ParseConfig" {
					report(sel.Pos(), "config may only use pgxpool.ParseConfig for validation; open pools in cmd/api")
				}
			}
			return true
		})
	}
	if production {
		ast.Inspect(f, func(n ast.Node) bool {
			if call, ok := n.(*ast.CallExpr); ok {
				if id, ok := call.Fun.(*ast.Ident); ok && (id.Name == "print" || id.Name == "println") {
					report(call.Pos(), "use structured slog instead of print/println; never log secrets or payloads")
				}
			}
			return true
		})
	}
	return issues, nil
}

func TestArchitecture(t *testing.T) {
	for _, root := range []string{"../cmd", "../internal"} {
		err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() || !strings.HasSuffix(path, ".go") {
				return err
			}
			pkg := filepath.ToSlash(strings.TrimPrefix(filepath.Dir(path), "../"))
			issues, err := violations(pkg, path, nil)
			for _, issue := range issues {
				t.Error(issue)
			}
			return err
		})
		if err != nil {
			t.Fatal(err)
		}
	}
}

func TestPolicyRejectsBoundaryViolations(t *testing.T) {
	cases := []struct {
		name, pkg, filename, source string
		want                        int
	}{
		{"allowed", "internal/delivery", "worker.go", `package delivery; import "github.com/gregorsternat/hooklane/internal/store"`, 0},
		{"reverse edge", "internal/store", "store.go", `package store; import _ "github.com/gregorsternat/hooklane/internal/httpserver"`, 1},
		{"test backdoor", "internal/config", "config_test.go", `package config; import "github.com/gregorsternat/hooklane/internal/store"`, 1},
		{"external test", "internal/store", "store_test.go", `package store_test; import "github.com/gregorsternat/hooklane/internal/store"`, 0},
		{"nested package", "internal/store/new", "new.go", `package new`, 1},
		{"direct SQL", "internal/httpserver", "api.go", `package httpserver; import "github.com/jackc/pgx/v5"`, 1},
		{"config parsing", "internal/config", "config.go", `package config; import p "github.com/jackc/pgx/v5/pgxpool"; var parse = p.ParseConfig`, 0},
		{"config connection", "internal/config", "config.go", `package config; import p "github.com/jackc/pgx/v5/pgxpool"; var connect = p.New`, 1},
		{"legacy log alias", "internal/delivery", "worker.go", `package delivery; import l "log"; func f() { l.Print("x") }`, 1},
		{"print", "internal/delivery", "worker.go", `package delivery; func f() { println("x") }`, 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			issues, err := violations(tc.pkg, tc.filename, []byte(tc.source))
			if err != nil || len(issues) != tc.want {
				t.Fatalf("got %v, %v; want %d violations", issues, err, tc.want)
			}
		})
	}
}
