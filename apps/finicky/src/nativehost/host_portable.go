//go:build !darwin

package nativehost

import "sync"

var stopped = make(chan struct{})
var stopOnce sync.Once

func Run(show bool, cb Callbacks) {
	if show && cb.ShowSettings != nil {
		cb.ShowSettings()
	}
	<-stopped
}
func Stop() { stopOnce.Do(func() { close(stopped) }) }
