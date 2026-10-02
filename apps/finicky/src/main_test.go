package main

import (
	"errors"
	"finicky/config"
	"testing"
)

func TestRejectedReloadRetainsActiveState(t *testing.T) {
	active, err := config.NewFromScript(finickyConfigAPIJS, "finickyConfig", `var finickyConfig = {defaultBrowser: "Safari", options: {keepRunning: true}}`)
	if err != nil {
		t.Fatal(err)
	}
	previousVM, previousInfo, previousKeepRunning := vm, configInfo, shouldKeepRunning
	t.Cleanup(func() { vm, configInfo, shouldKeepRunning = previousVM, previousInfo, previousKeepRunning })
	info := &ConfigInfo{DefaultBrowser: "Safari", ConfigPath: "/last-good.ts"}
	vm, configInfo, shouldKeepRunning = active, info, true
	rejected := errors.New("candidate validation failed")
	if err := applyConfigCandidate(nil, nil, rejected); !errors.Is(err, rejected) {
		t.Fatalf("error = %v", err)
	}
	if vm != active || configInfo != info || !shouldKeepRunning {
		t.Fatal("rejected candidate changed active configuration")
	}
	if state := vm.GetConfigState(); state.DefaultBrowser != "Safari" {
		t.Fatalf("last working runtime lost: %+v", state)
	}
}

func TestAcceptedReloadReplacesActiveState(t *testing.T) {
	previousVM, previousInfo, previousKeepRunning := vm, configInfo, shouldKeepRunning
	t.Cleanup(func() { vm, configInfo, shouldKeepRunning = previousVM, previousInfo, previousKeepRunning })
	candidate, err := config.NewFromScript(finickyConfigAPIJS, "finickyConfig", `var finickyConfig = {defaultBrowser: "Firefox", options: {keepRunning: false, checkForUpdates: false, logRequests: false}}`)
	if err != nil {
		t.Fatal(err)
	}
	info := &ConfigInfo{DefaultBrowser: "Firefox", ConfigPath: "/new-config.ts"}
	if err := applyConfigCandidate(candidate, info, nil); err != nil {
		t.Fatal(err)
	}
	if vm != candidate || configInfo != info || shouldKeepRunning {
		t.Fatal("accepted candidate was not applied")
	}
	if state := vm.GetConfigState(); state.DefaultBrowser != "Firefox" {
		t.Fatalf("new runtime not in use: %+v", state)
	}
}
