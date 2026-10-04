package main

/*
#include <stdlib.h>
#include "browser.h"
*/
import "C"

import (
	"finicky/urlhandlers"
	"fmt"
	"os"
	"path/filepath"
	"unsafe"
)

type nativeRegistry struct{}

func currentAppPath() string {
	value := C.currentApplicationPath()
	defer C.free(unsafe.Pointer(value))
	return filepath.Clean(C.GoString(value))
}
func (nativeRegistry) Handler(scheme string) (string, error) {
	cScheme := C.CString(scheme)
	defer C.free(unsafe.Pointer(cScheme))
	value := C.defaultApplicationPath(cScheme)
	if value == nil {
		return "", fmt.Errorf("no application registered for %s", scheme)
	}
	defer C.free(unsafe.Pointer(value))
	return filepath.Clean(C.GoString(value)), nil
}
func (nativeRegistry) Register(app string) error {
	cApp := C.CString(app)
	defer C.free(unsafe.Pointer(cApp))
	if !bool(C.registerApplication(cApp)) {
		return fmt.Errorf("Launch Services registration failed")
	}
	return nil
}
func (nativeRegistry) SetHandler(scheme, app string) error {
	cScheme, cApp := C.CString(scheme), C.CString(app)
	defer C.free(unsafe.Pointer(cScheme))
	defer C.free(unsafe.Pointer(cApp))
	if !bool(C.setDefaultApplicationPath(cApp, cScheme)) {
		return fmt.Errorf("macOS rejected or timed out changing %s to %s", scheme, app)
	}
	return nil
}

func runHandlerCommand(action, statePath string) error {
	registry := nativeRegistry{}
	app := currentAppPath()
	if action == "status" {
		isDefault, err := isDefaultBrowser()
		if err != nil {
			return err
		}
		fmt.Printf("Application: %s\nBundle ID: %s\nDevelopment: %t\nDefault: %t\n", app, currentBundleID(), isDevelopmentBuild(), isDefault)
		for _, scheme := range urlhandlers.Schemes {
			path, err := registry.Handler(scheme)
			if err != nil {
				fmt.Printf("%s: %v\n", scheme, err)
			} else {
				fmt.Printf("%s: %s\n", scheme, path)
			}
		}
		return nil
	}
	if action != "switch" && action != "restore" {
		return fmt.Errorf("unknown URL handler command %q (status, switch, restore)", action)
	}
	if !isDevelopmentBuild() {
		return fmt.Errorf("URL handler switch/restore requires a --dev bundle")
	}
	if statePath == "" {
		return fmt.Errorf("--handler-state is required for switch/restore")
	}
	statePath, err := filepath.Abs(statePath)
	if err != nil {
		return err
	}
	// Serialize switches/restores using this snapshot; status remains read-only.
	lock := statePath + ".lock"
	if err := os.Mkdir(lock, 0700); err != nil {
		return fmt.Errorf("lock restore state: %w", err)
	}
	defer os.Remove(lock)
	switch action {
	case "switch":
		err = urlhandlers.Switch(registry, app, statePath)
	case "restore":
		err = urlhandlers.Restore(registry, app, statePath)
	}
	if err != nil {
		return err
	}
	fmt.Printf("URL handlers %s complete. Restore state: %s\n", action, statePath)
	return nil
}
