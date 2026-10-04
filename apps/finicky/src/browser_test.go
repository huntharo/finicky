package main

import (
	"fmt"
	"testing"
)

func TestDefaultBrowserRequiresRuntimeIdentityAndExactPath(t *testing.T) {
	const productionID = "se.johnste.finicky"
	const developmentID = "se.johnste.finicky.dev.worktree"
	const installed = "/Applications/Finicky.app"
	const local = "/worktree/Finicky-Dev.app"
	for _, tc := range []struct {
		name, identity, app, handlerID, handlerPath string
		want                                        bool
	}{
		{"same ID different copy", productionID, local, productionID, installed, false},
		{"dev while production default", developmentID, local, productionID, installed, false},
		{"dev is exact default", developmentID, local, developmentID, local, true},
		{"production is exact default", productionID, installed, productionID, installed, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := matchesDefaultHandlers(tc.identity, tc.app, func(string) (string, string, error) { return tc.handlerID, tc.handlerPath, nil })
			if got != tc.want {
				t.Fatalf("default = %t; want %t", got, tc.want)
			}
		})
	}
}

func TestDefaultBrowserRequiresEveryScheme(t *testing.T) {
	for _, missing := range []string{"http", "https", "finicky"} {
		t.Run(missing, func(t *testing.T) {
			got := matchesDefaultHandlers("dev", "/dev.app", func(scheme string) (string, string, error) {
				if scheme == missing {
					return "", "", fmt.Errorf("not registered")
				}
				return "dev", "/dev.app", nil
			})
			if got {
				t.Fatal("must not consider a missing scheme default")
			}
		})
	}
}
