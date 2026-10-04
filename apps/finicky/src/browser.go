package main

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Foundation
#include "browser.h"
*/
import "C"

import (
	"finicky/urlhandlers"
	"fmt"
	"unsafe"
)

func currentBundleID() string {
	result := C.currentBundleIdentifier()
	if result == nil {
		return ""
	}
	defer C.free(unsafe.Pointer(result))
	return C.GoString(result)
}

func isDevelopmentBuild() bool { return bool(C.isDevelopmentBundle()) }

func isDefaultBrowser() (bool, error) {
	identity := currentBundleID()
	if identity == "" {
		return false, fmt.Errorf("application has no bundle identifier")
	}
	return matchesDefaultHandlers(identity, currentAppPath(), func(scheme string) (string, string, error) {
		handlerID, err := getDefaultHandlerForURLScheme(scheme)
		if err != nil {
			return "", "", err
		}
		handlerPath, err := (nativeRegistry{}).Handler(scheme)
		return handlerID, handlerPath, err
	}), nil
}

func matchesDefaultHandlers(identity, app string, handler func(string) (string, string, error)) bool {
	for _, scheme := range urlhandlers.Schemes {
		handlerID, handlerPath, err := handler(scheme)
		// An unregistered scheme means we are not the default yet.
		if err != nil || handlerID != identity || handlerPath != app {
			return false
		}
	}
	return true
}

func setDefaultBrowser() (bool, error) {
	isDefault, err := isDefaultBrowser()
	if err != nil {
		return false, err
	}
	if isDefault {
		return true, nil
	}

	setDefaultHandlerForURLScheme(currentBundleID(), "http")
	setDefaultHandlerForURLScheme(currentBundleID(), "https")
	setDefaultHandlerForURLScheme(currentBundleID(), "finicky")
	return true, nil
}

func getDefaultHandlerForURLScheme(scheme string) (string, error) {
	// Convert Go string to C string
	cScheme := C.CString(scheme)
	defer C.free(unsafe.Pointer(cScheme))

	// Call the Objective-C function from browse.m
	result := C.getDefaultHandlerForURLScheme(cScheme)
	if result != nil {
		defer C.free(unsafe.Pointer(result))
		return C.GoString(result), nil
	} else {
		return "", fmt.Errorf("no default handler found for '%s'", scheme)
	}
}

func setDefaultHandlerForURLScheme(bundleId string, scheme string) (bool, error) {
	// Convert Go string to C string
	cScheme := C.CString(scheme)
	defer C.free(unsafe.Pointer(cScheme))
	cBundleId := C.CString(bundleId)
	defer C.free(unsafe.Pointer(cBundleId))

	// Call the Objective-C function from browse.m
	result := bool(C.setDefaultHandlerForURLScheme(cBundleId, cScheme))

	return result, nil
}
