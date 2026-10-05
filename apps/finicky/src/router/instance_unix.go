//go:build !windows

package router

import (
	"golang.org/x/sys/unix"
	"os"
)

func LockInstance(path string) (func(), error) {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = unix.Flock(int(file.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		file.Close()
		return nil, err
	}
	return func() { unix.Flock(int(file.Fd()), unix.LOCK_UN); file.Close() }, nil
}
