//go:build !darwin

package browser

import (
	"bytes"
	"encoding/json"
	"finicky/diagnostics"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestPortableBrowserHelperProcess(t *testing.T) {
	output := os.Getenv("PWRFINICKY_TEST_BROWSER_OUTPUT")
	if output == "" {
		return
	}
	for i, arg := range os.Args {
		if arg == "--" {
			data, _ := json.Marshal(os.Args[i+1:])
			if err := os.WriteFile(output, data, 0600); err != nil {
				os.Exit(2)
			}
			os.Exit(0)
		}
	}
	os.Exit(3)
}

func TestPortableHandoffPreservesArgumentsAndOmitsURLsFromLogs(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	output := filepath.Join(t.TempDir(), "browser-arguments.json")
	t.Setenv("PWRFINICKY_TEST_BROWSER_OUTPUT", output)
	t.Setenv("FINICKY_DIAGNOSTICS", "1")
	var logs bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })
	url := `https://example.com/private?token=SECRET&text="quoted space"`
	trace := diagnostics.Begin("portable-test")
	err = LaunchBrowserWithTrace(BrowserConfig{Name: executable, URL: url,
		Args: []string{"-test.run=^TestPortableBrowserHelperProcess$", "--", "--custom=two words"},
	}, false, false, trace)
	trace.Finish(false, false, err != nil)
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	var args []string
	for time.Now().Before(deadline) {
		if data, err := os.ReadFile(output); err == nil && json.Unmarshal(data, &args) == nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !reflect.DeepEqual(args, []string{"--custom=two words", url}) {
		t.Fatalf("browser arguments changed: %q", args)
	}
	if strings.Contains(logs.String(), "SECRET") || strings.Contains(logs.String(), "https://") {
		t.Fatal("routine handoff logs included a URL")
	}
	if !strings.Contains(logs.String(), "browser_start") {
		t.Fatal("missing process handoff timing")
	}
}

func TestPortableDryRunDoesNotRequireInstalledBrowser(t *testing.T) {
	if err := LaunchBrowser(BrowserConfig{Name: "not-an-installed-browser", URL: "https://example.com"}, true, false); err != nil {
		t.Fatal(err)
	}
}
