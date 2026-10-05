//go:build !darwin

package util

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

func UserHomeDir() (string, error)  { return os.UserHomeDir() }
func UserCacheDir() (string, error) { return os.UserCacheDir() }
func ShortenPath(path string) string {
	home, _ := os.UserHomeDir()
	if home != "" && (path == home || strings.HasPrefix(path, home+string(filepath.Separator))) {
		return "~" + path[len(home):]
	}
	return path
}
func GetModifierKeys() map[string]bool { return map[string]bool{} }
func GetSystemInfo() map[string]string {
	name, _ := os.Hostname()
	return map[string]string{"name": name, "localizedName": name, "platform": runtime.GOOS}
}
func GetPowerInfo() map[string]interface{} {
	return map[string]interface{}{"isCharging": nil, "isConnected": nil, "percentage": nil}
}
func IsAppRunning(identifier string) bool { return false }
