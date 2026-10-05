//go:build darwin

package nativehost

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework Cocoa -framework CoreServices
#include <stdlib.h>
void pwrRun(int show);
void pwrStop(void);
char *pwrDefaultStatus(void);
int pwrSetDefault(void);
*/
import "C"
import (
	"encoding/json"
	"fmt"
	"unsafe"
)

var callbacks Callbacks

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
	return status, err
}
func SetDefaultBrowser() (DefaultStatus, error) {
	code := C.pwrSetDefault()
	if code != 0 {
		return DefaultStatus{}, fmt.Errorf("macOS rejected default browser registration (%d)", code)
	}
	return GetDefaultStatus()
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
