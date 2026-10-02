package config

import (
	"os"
	"strings"
	"testing"
)

func configAPI(t *testing.T) []byte {
	t.Helper()
	api, err := os.ReadFile("../assets/finickyConfigAPI.js")
	if err != nil {
		t.Fatal(err)
	}
	return api
}

func TestCandidateValidation(t *testing.T) {
	for _, tc := range []struct{ name, script, errorText string }{
		{"syntax", `var finickyConfig = {`, "running config script"},
		{"evaluation", `throw new Error("top-level failure")`, "top-level failure"},
		{"missing export", `var wrongNamespace = {defaultBrowser: "Safari"}`, "Could not find configuration"},
		{"browser type", `var finickyConfig = {defaultBrowser: 123}`, "defaultBrowser"},
		{"handler type", `var finickyConfig = {defaultBrowser: "Safari", handlers: [{match: 123, browser: "Firefox"}]}`, "handlers"},
		{"option type", `var finickyConfig = {defaultBrowser: "Safari", options: {keepRunning: "true"}}`, "keepRunning"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			candidate, err := NewFromScript(configAPI(t), "finickyConfig", tc.script)
			if candidate != nil || err == nil || !strings.Contains(err.Error(), tc.errorText) {
				t.Fatalf("candidate = %v, error = %v; want rejected config with %q", candidate, err, tc.errorText)
			}
		})
	}
}

func TestCandidateAllowsRealConfigSemantics(t *testing.T) {
	vm, err := NewFromScript(configAPI(t), "finickyConfig", `var finickyConfig = {
  defaultBrowser: (url, options) => { throw new Error("must only run for a real URL") },
  handlers: [
   {match: [/example/, "*github.com*", (url, options) => !!options.opener], browser: null},
   {match: "*", browser: {name: "Chrome", appType: "appName", profile: "Work", args: ["--incognito"]}}
  ],
  rewrite: [{match: /example/, url: (url) => new URL(url.href)}],
  options: {keepRunning: true, hideIcon: false, logRequests: false, checkForUpdates: false}
 }`)
	if err != nil {
		t.Fatal(err)
	}
	state := vm.GetConfigState()
	if state == nil || state.DefaultBrowser != "Function" || state.Handlers != 2 || state.Rewrites != 1 {
		t.Fatalf("metadata must not invoke callbacks: %+v", state)
	}
	if vm.GetAllConfigOptions().CheckForUpdates {
		t.Fatal("candidate options were not applied")
	}
}
