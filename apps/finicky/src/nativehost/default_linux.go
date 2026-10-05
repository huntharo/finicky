//go:build linux

package nativehost

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

func xdg(args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	data, err := exec.CommandContext(ctx, "xdg-mime", args...).Output()
	return strings.TrimSpace(string(data)), err
}
func GetDefaultStatus() (DefaultStatus, error) {
	http, err := xdg("query", "default", "x-scheme-handler/http")
	if err != nil {
		return DefaultStatus{}, err
	}
	https, err := xdg("query", "default", "x-scheme-handler/https")
	return DefaultStatus{HTTP: http, HTTPS: https, IsDefault: http == "pwrfinicky.desktop" && https == "pwrfinicky.desktop"}, err
}
func SetDefaultBrowser() (DefaultStatus, error) {
	executable, err := os.Executable()
	if err != nil {
		return DefaultStatus{}, err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return DefaultStatus{}, err
	}
	root := os.Getenv("XDG_DATA_HOME")
	if root == "" {
		root = filepath.Join(home, ".local", "share")
	}
	dir := filepath.Join(root, "applications")
	if err = os.MkdirAll(dir, 0755); err != nil {
		return DefaultStatus{}, err
	}
	escaped := strings.NewReplacer("\\", "\\\\", "\"", "\\\"", "`", "\\`", "$", "\\$", "%", "%%").Replace(executable)
	contents := fmt.Sprintf("[Desktop Entry]\nType=Application\nName=PwrFinicky\nExec=\"%s\" %%u\nTerminal=false\nCategories=Network;WebBrowser;\nMimeType=x-scheme-handler/http;x-scheme-handler/https;x-scheme-handler/pwrfinicky;\n", escaped)
	if err = os.WriteFile(filepath.Join(dir, "pwrfinicky.desktop"), []byte(contents), 0644); err != nil {
		return DefaultStatus{}, err
	}
	for _, scheme := range []string{"http", "https", "pwrfinicky"} {
		if _, err = xdg("default", "pwrfinicky.desktop", "x-scheme-handler/"+scheme); err != nil {
			return DefaultStatus{}, err
		}
	}
	return GetDefaultStatus()
}
