//go:build windows

package nativehost

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"
)

func registry(args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "reg.exe", args...)
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	data, err := command.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("registry command failed: %w", err)
	}
	return strings.TrimSpace(string(data)), nil
}
func GetDefaultStatus() (DefaultStatus, error) {
	values := make([]string, 2)
	for i, scheme := range []string{"http", "https"} {
		data, err := registry("query", `HKCU\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\`+scheme+`\UserChoice`, "/v", "ProgId")
		if err == nil {
			fields := strings.Fields(data)
			if len(fields) > 0 {
				values[i] = fields[len(fields)-1]
			}
		}
	}
	return DefaultStatus{HTTP: values[0], HTTPS: values[1], IsDefault: values[0] == "PwrFinickyURL" && values[1] == "PwrFinickyURL"}, nil
}
func SetDefaultBrowser() (DefaultStatus, error) {
	executable, err := os.Executable()
	if err != nil {
		return DefaultStatus{}, err
	}
	command := `"` + executable + `" "%1"`
	entries := [][]string{
		{`HKCU\Software\Classes\PwrFinickyURL`, "/ve", "/d", "PwrFinicky URL"},
		{`HKCU\Software\Classes\PwrFinickyURL`, "/v", "URL Protocol", "/d", ""},
		{`HKCU\Software\Classes\PwrFinickyURL\shell\open\command`, "/ve", "/d", command},
		{`HKCU\Software\PwrDrvr\PwrFinicky\Capabilities`, "/v", "ApplicationName", "/d", "PwrFinicky"},
		{`HKCU\Software\PwrDrvr\PwrFinicky\Capabilities`, "/v", "ApplicationDescription", "/d", "Browser and profile routing"},
		{`HKCU\Software\RegisteredApplications`, "/v", "PwrFinicky", "/d", `Software\PwrDrvr\PwrFinicky\Capabilities`},
	}
	for _, scheme := range []string{"http", "https", "pwrfinicky"} {
		entries = append(entries, []string{`HKCU\Software\PwrDrvr\PwrFinicky\Capabilities\URLAssociations`, "/v", scheme, "/d", "PwrFinickyURL"})
	}
	for _, entry := range entries {
		args := append([]string{"add"}, entry...)
		args = append(args, "/f")
		if _, err = registry(args...); err != nil {
			return DefaultStatus{}, err
		}
	}
	// Windows requires the user to choose the default in Settings.
	cmd := exec.Command("rundll32.exe", "url.dll,FileProtocolHandler", "ms-settings:defaultapps")
	if err = cmd.Start(); err != nil {
		return DefaultStatus{}, err
	}
	go cmd.Wait()
	return GetDefaultStatus()
}
