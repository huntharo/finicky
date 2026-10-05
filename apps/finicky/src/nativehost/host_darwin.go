//go:build darwin

package nativehost

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework Cocoa -framework CoreServices
#include <stdlib.h>
void pwrRun(int show);
void pwrStop(void);
char *pwrDefaultStatus(void);
void pwrSetDefault(void);
*/
import "C"
import (
	"encoding/json"
	"sync"
	"unsafe"
)

var callbacks Callbacks
var defaultRegistration struct {
	sync.Mutex
	pending bool
	err     string
}

func Run(show bool, cb Callbacks) {
	callbacks = cb
	var flag C.int
	if show {
		flag = 1
	}
	C.pwrRun(flag)
}
func Stop() { C.pwrStop() }
func GetDefaultStatus() (DefaultStatus, error) {
	value := C.pwrDefaultStatus()
	defer C.free(unsafe.Pointer(value))
	var status DefaultStatus
	err := json.Unmarshal([]byte(C.GoString(value)), &status)
	defaultRegistration.Lock()
	status.Pending, status.Error = defaultRegistration.pending, defaultRegistration.err
	defaultRegistration.Unlock()
	return status, err
}
func SetDefaultBrowser() (DefaultStatus, error) {
	defaultRegistration.Lock()
	start := !defaultRegistration.pending
	if start {
		defaultRegistration.pending = true
		defaultRegistration.err = ""
	}
	defaultRegistration.Unlock()
	if start {
		C.pwrSetDefault()
	}
	return GetDefaultStatus()
}

//export PwrDefaultFinished
func PwrDefaultFinished(message *C.char) {
	defaultRegistration.Lock()
	defer defaultRegistration.Unlock()
	defaultRegistration.pending = false
	defaultRegistration.err = C.GoString(message)
}

//export PwrOpenURL
func PwrOpenURL(raw, name, bundleID, path *C.char, nativeMS C.double) {
	if callbacks.OpenURL != nil {
		callbacks.OpenURL(C.GoString(raw), C.GoString(name), C.GoString(bundleID), C.GoString(path), float64(nativeMS))
	}
}

//export PwrShowSettings
func PwrShowSettings() {
	if callbacks.ShowSettings != nil {
		callbacks.ShowSettings()
	}
}

//export PwrQuit
func PwrQuit() {
	if callbacks.Quit != nil {
		callbacks.Quit()
	}
}
