//go:build !darwin

package browser

func GetInstalledBrowsers() []string {
	found := []string{}
	for _, name := range []string{"Microsoft Edge", "Google Chrome", "Firefox", "Brave Browser", "Chromium"} {
		if _, err := portableExecutable(name); err == nil {
			found = append(found, name)
		}
	}
	return found
}
