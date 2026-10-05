// PwrFinicky is the native, resident URL handler. Electron is a separately
// launched settings application and is never required to dispatch a link.
package main

import (
	"bytes"
	"encoding/json"
	"finicky/nativehost"
	"finicky/resolver"
	"finicky/router"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
)

var buildVersion = "0.1.0"

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "PwrFinicky:", err)
		os.Exit(1)
	}
}

func run() error {
	runtime.LockOSThread()
	dataDir := flag.String("data-dir", "", "Separate configuration and runtime directory")
	configPath := flag.String("config", "", "Use an existing Finicky JS/TS config")
	headless := flag.Bool("headless", false, "Start routing without opening settings")
	dryRun := flag.Bool("dry-run", false, "Resolve links without launching browsers")
	testURL := flag.String("test", "", "Resolve a URL, print JSON, then exit")
	dispatchURL := flag.String("url", "", "Dispatch a URL to this PwrFinicky instance")
	uiPath := flag.String("ui", "", "Explicit Electron settings executable")
	rpcMethod := flag.String("rpc", "", "Call an existing instance (state, reload, quit)")
	params := flag.String("params", "{}", "JSON parameters for --rpc")
	version := flag.Bool("version", false, "Print version")
	flag.Parse()
	if *version {
		fmt.Println("PwrFinicky", buildVersion)
		return nil
	}
	if *dataDir == "" {
		root, err := os.UserConfigDir()
		if err != nil {
			return err
		}
		*dataDir = filepath.Join(root, "PwrFinicky")
	}
	absolute, err := filepath.Abs(*dataDir)
	if err != nil {
		return err
	}
	*dataDir = absolute
	if err = os.MkdirAll(*dataDir, 0700); err != nil {
		return err
	}
	endpointPath := filepath.Join(*dataDir, "endpoint.json")
	urls := []string{}
	if *dispatchURL != "" {
		urls = append(urls, *dispatchURL)
	}
	for _, arg := range flag.Args() {
		if strings.Contains(arg, "://") {
			urls = append(urls, arg)
		}
	}
	if *rpcMethod != "" {
		var payload any
		if err = json.Unmarshal([]byte(*params), &payload); err != nil {
			return err
		}
		result, err := call(endpointPath, *rpcMethod, payload)
		if err == nil {
			fmt.Println(string(result))
		}
		return err
	}
	release, lockErr := router.LockInstance(filepath.Join(*dataDir, "instance.lock"))
	if lockErr != nil {
		method := "showSettings"
		var payload any = map[string]any{}
		if *testURL != "" {
			method = "test"
			payload = map[string]any{"url": *testURL}
		}
		if len(urls) > 0 {
			method = "dispatch"
			payload = map[string]any{"url": urls[0]}
		}
		var result []byte
		for attempt := 0; attempt < 20; attempt++ {
			result, err = call(endpointPath, method, payload)
			if err == nil {
				break
			}
			time.Sleep(100 * time.Millisecond)
		}
		if err != nil {
			return fmt.Errorf("another instance owns this data directory but is not responding: %w", err)
		}
		if method != "showSettings" {
			fmt.Println(string(result))
		}
		for _, url := range remainingURLs(urls) {
			if _, err = call(endpointPath, "dispatch", map[string]any{"url": url}); err != nil {
				return err
			}
		}
		return nil
	}
	defer release()
	logFile, err := os.OpenFile(filepath.Join(*dataDir, "routing.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer logFile.Close()
	slog.SetDefault(slog.New(slog.NewJSONHandler(io.MultiWriter(os.Stderr, logFile), nil)))
	start := time.Now()
	engine, err := router.New(router.Options{DataDir: *dataDir, ConfigPath: *configPath, Version: buildVersion, DryRun: *dryRun})
	if err != nil {
		return err
	}
	defer engine.Close()
	if *testURL != "" {
		result, err := engine.Resolve(*testURL, nil, false)
		if err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(result)
	}
	var uiMu sync.Mutex
	showUI := func() error {
		uiMu.Lock()
		defer uiMu.Unlock()
		path := *uiPath
		if path == "" {
			executable, _ := os.Executable()
			base := filepath.Dir(executable)
			switch runtime.GOOS {
			case "darwin":
				path = filepath.Join(base, "..", "Resources", "PwrFinicky Settings.app", "Contents", "MacOS", "PwrFinicky Settings")
			case "windows":
				path = filepath.Join(base, "settings", "PwrFinicky Settings.exe")
			default:
				path = filepath.Join(base, "settings", "PwrFinicky Settings")
			}
		}
		if _, err := os.Stat(path); err != nil {
			return fmt.Errorf("settings application not found; build the complete app or pass --ui: %w", err)
		}
		command := exec.Command(path, "--endpoint", endpointPath)
		command.Stdout = logFile
		command.Stderr = logFile
		// Running from Electron-based terminals may inherit this variable.
		for _, entry := range os.Environ() {
			if !strings.HasPrefix(entry, "ELECTRON_RUN_AS_NODE=") {
				command.Env = append(command.Env, entry)
			}
		}
		if err := command.Start(); err != nil {
			return err
		}
		go command.Wait()
		return nil
	}
	controls := router.Controls{ShowSettings: showUI, Quit: nativehost.Stop, GetDefaultStatus: func() (any, error) { return nativehost.GetDefaultStatus() }, SetDefaultBrowser: func() (any, error) { return nativehost.SetDefaultBrowser() }}
	server, err := router.StartServer(engine, controls)
	if err != nil {
		return err
	}
	defer server.Close()
	slog.Info("PwrFinicky router ready", "version", buildVersion, "pid", os.Getpid(), "startup_ms", float64(time.Since(start).Microseconds())/1000, "dry_run", *dryRun)
	for _, url := range urls {
		url := url
		go engine.Resolve(url, nil, true)
	}
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(signals)
	go func() { <-signals; nativehost.Stop() }()
	nativehost.Run(!*headless && len(urls) == 0, nativehost.Callbacks{
		OpenURL: func(url, name, bundleID, path string, nativeMS float64) {
			received := time.Now().Add(-time.Duration(nativeMS * float64(time.Millisecond)))
			var opener *resolver.OpenerInfo
			if name != "" || bundleID != "" {
				opener = &resolver.OpenerInfo{Name: name, BundleID: bundleID, Path: path}
			}
			go func() {
				if _, err := engine.ResolveReceived(url, opener, true, received); err != nil {
					slog.Warn("URL rejected", "error_type", fmt.Sprintf("%T", err))
				}
			}()
		},
		ShowSettings: func() {
			go func() {
				if err := showUI(); err != nil {
					slog.Error("Unable to open settings", "error", err)
				}
			}()
		}, Quit: nativehost.Stop,
	})
	return nil
}

func call(path, method string, params any) ([]byte, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var endpoint router.Endpoint
	if err = json.Unmarshal(data, &endpoint); err != nil {
		return nil, err
	}
	if !strings.HasPrefix(endpoint.URL, "http://127.0.0.1:") || len(endpoint.Token) != 64 {
		return nil, fmt.Errorf("invalid local router endpoint")
	}
	body, _ := json.Marshal(map[string]any{"method": method, "params": params})
	request, err := http.NewRequest("POST", endpoint.URL+"/rpc", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+endpoint.Token)
	request.Header.Set("Content-Type", "application/json")
	client := http.Client{Timeout: 12 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	result, err := io.ReadAll(io.LimitReader(response.Body, 4<<20))
	if response.StatusCode != 200 {
		return nil, fmt.Errorf("router: %s", strings.TrimSpace(string(result)))
	}
	return result, err
}

func remainingURLs(urls []string) []string {
	if len(urls) < 2 {
		return nil
	}
	return urls[1:]
}
