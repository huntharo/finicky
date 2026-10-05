package browser

import (
	"finicky/diagnostics"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// Only explicit browser executables are launched; opening through the system
// default would route back into PwrFinicky when it is the default browser.
func portableExecutable(name string) (string, error) {
	if filepath.IsAbs(name) {
		if info, err := os.Stat(name); err == nil && !info.IsDir() {
			return name, nil
		}
		return "", fmt.Errorf("browser executable not found: %s", name)
	}
	candidates := map[string][]string{
		"Google Chrome":  {"google-chrome", "google-chrome-stable", "chrome.exe"},
		"Microsoft Edge": {"microsoft-edge", "microsoft-edge-stable", "msedge.exe"},
		"Firefox":        {"firefox", "firefox.exe"}, "Brave Browser": {"brave-browser", "brave", "brave.exe"},
		"Chromium": {"chromium", "chromium-browser", "chromium.exe"},
	}
	aliases := map[string]string{"com.google.Chrome": "Google Chrome", "com.microsoft.edgemac": "Microsoft Edge", "org.mozilla.firefox": "Firefox", "com.brave.Browser": "Brave Browser"}
	if alias := aliases[name]; alias != "" {
		name = alias
	}
	for _, candidate := range candidates[name] {
		if path, err := exec.LookPath(candidate); err == nil {
			return path, nil
		}
	}
	if runtime.GOOS == "windows" {
		relative := map[string]string{"Google Chrome": "Google/Chrome/Application/chrome.exe", "Microsoft Edge": "Microsoft/Edge/Application/msedge.exe", "Firefox": "Mozilla Firefox/firefox.exe", "Brave Browser": "BraveSoftware/Brave-Browser/Application/brave.exe"}
		if rel := relative[name]; rel != "" {
			for _, root := range []string{os.Getenv("LOCALAPPDATA"), os.Getenv("PROGRAMFILES"), os.Getenv("PROGRAMFILES(X86)")} {
				if root != "" {
					path := filepath.Join(root, filepath.FromSlash(rel))
					if info, err := os.Stat(path); err == nil && !info.IsDir() {
						return path, nil
					}
				}
			}
		}
	}
	if path, err := exec.LookPath(name); err == nil {
		return path, nil
	}
	return "", fmt.Errorf("browser %q is not installed; select an installed browser or its executable path", name)
}

func launchPortable(config BrowserConfig, dryRun bool, trace *diagnostics.Trace) error {
	// Like the macOS launcher, a dry run resolves without requiring an
	// installed destination. Only a real handoff needs an executable/profile.
	if dryRun {
		trace.Mark("browser_prepare")
		return nil
	}
	path, err := portableExecutable(config.Name)
	if err != nil {
		return err
	}
	args := append([]string{}, config.Args...)
	if config.Profile != "" {
		profileArgs, ok := resolveBrowserProfileArgs(config.Name, config.Profile)
		if !ok {
			return fmt.Errorf("profile %q was not found in %s", config.Profile, config.Name)
		}
		args = append(profileArgs, args...)
	}
	args = append(args, config.URL)
	trace.Mark("browser_prepare")
	cmd := exec.Command(path, args...)
	if err := cmd.Start(); err != nil {
		return err
	}
	trace.Mark("browser_start")
	// Browsers may stay resident; reap asynchronously instead of waiting for exit.
	go cmd.Wait()
	return nil
}

func profileDirectory(home string, info browserInfo) string {
	if runtime.GOOS == "darwin" {
		return filepath.Join(home, "Library/Application Support", info.ConfigDirRelative)
	}
	if runtime.GOOS == "windows" {
		if info.Type == "Firefox" {
			return filepath.Join(os.Getenv("APPDATA"), "Mozilla", "Firefox")
		}
		paths := map[string]string{"Google Chrome": "Google/Chrome/User Data", "Microsoft Edge": "Microsoft/Edge/User Data", "Brave Browser": "BraveSoftware/Brave-Browser/User Data", "Chromium": "Chromium/User Data"}
		return filepath.Join(os.Getenv("LOCALAPPDATA"), filepath.FromSlash(paths[info.AppName]))
	}
	if info.Type == "Firefox" {
		return filepath.Join(home, ".mozilla", "firefox")
	}
	root := os.Getenv("XDG_CONFIG_HOME")
	if root == "" {
		root = filepath.Join(home, ".config")
	}
	paths := map[string]string{"Google Chrome": "google-chrome", "Microsoft Edge": "microsoft-edge", "Brave Browser": "BraveSoftware/Brave-Browser", "Chromium": "chromium"}
	rel := paths[info.AppName]
	if rel == "" {
		rel = strings.ToLower(strings.ReplaceAll(info.AppName, " ", "-"))
	}
	return filepath.Join(root, filepath.FromSlash(rel))
}
