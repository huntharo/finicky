package router

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"finicky/browser"
	"finicky/resolver"
	"finicky/rules"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type Endpoint struct {
	URL   string `json:"url"`
	Token string `json:"token"`
	PID   int    `json:"pid"`
}
type Controls struct {
	ShowSettings      func() error
	Quit              func()
	GetDefaultStatus  func() (any, error)
	SetDefaultBrowser func() (any, error)
}
type Server struct {
	http     *http.Server
	Endpoint Endpoint
	Path     string
	listener net.Listener
}
type rpcRequest struct {
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

func StartServer(engine *Engine, controls Controls) (*Server, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	secret := make([]byte, 32)
	if _, err = rand.Read(secret); err != nil {
		listener.Close()
		return nil, err
	}
	server := &Server{Endpoint: Endpoint{URL: "http://" + listener.Addr().String(), Token: hex.EncodeToString(secret), PID: os.Getpid()}, Path: filepath.Join(engine.options.DataDir, "endpoint.json"), listener: listener}
	mux := http.NewServeMux()
	mux.HandleFunc("/state", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" {
			http.Error(w, "method not allowed", 405)
			return
		}
		respond(w, engine.Snapshot(), nil)
	})
	mux.HandleFunc("/rpc", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			http.Error(w, "method not allowed", 405)
			return
		}
		var call rpcRequest
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&call); err != nil {
			respond(w, nil, errors.New("invalid request"))
			return
		}
		var value any
		var err error
		switch call.Method {
		case "state":
			value = engine.Snapshot()
		case "test", "dispatch":
			var params struct {
				URL    string               `json:"url"`
				Opener *resolver.OpenerInfo `json:"opener"`
			}
			err = json.Unmarshal(call.Params, &params)
			if err == nil {
				value, err = engine.Resolve(params.URL, params.Opener, call.Method == "dispatch")
			}
		case "saveRules":
			var params struct {
				Rules rules.RulesFile `json:"rules"`
			}
			err = json.Unmarshal(call.Params, &params)
			if err == nil {
				value, err = engine.SaveRules(params.Rules)
			}
		case "setConfig":
			var params struct {
				Path string `json:"path"`
			}
			err = json.Unmarshal(call.Params, &params)
			if err == nil {
				value, err = engine.SetConfig(params.Path)
			}
		case "useVisualRules":
			value, err = engine.SetConfig("")
		case "reload":
			value = engine.Reload()
		case "getProfiles":
			var params struct {
				Browser string `json:"browser"`
			}
			err = json.Unmarshal(call.Params, &params)
			if err == nil {
				value = browser.GetProfilesForBrowser(params.Browser)
			}
		case "showSettings":
			if controls.ShowSettings != nil {
				err = controls.ShowSettings()
			}
		case "getDefaultStatus":
			if controls.GetDefaultStatus != nil {
				value, err = controls.GetDefaultStatus()
			} else {
				err = errors.New("default browser status unavailable")
			}
		case "setDefaultBrowser":
			if controls.SetDefaultBrowser != nil {
				value, err = controls.SetDefaultBrowser()
			} else {
				err = errors.New("default browser registration unavailable")
			}
		case "quit":
			if controls.Quit != nil {
				time.AfterFunc(150*time.Millisecond, controls.Quit)
			}
		default:
			err = fmt.Errorf("unknown method: %s", call.Method)
		}
		respond(w, value, err)
	})
	server.http = &http.Server{ReadHeaderTimeout: 3 * time.Second, ReadTimeout: 5 * time.Second, WriteTimeout: 15 * time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if r.Header.Get("Origin") != "" || subtle.ConstantTimeCompare([]byte(token), []byte(server.Endpoint.Token)) != 1 {
			http.Error(w, "unauthorized", 401)
			return
		}
		mux.ServeHTTP(w, r)
	})}
	if err = writeJSON(server.Path, server.Endpoint); err != nil {
		listener.Close()
		return nil, err
	}
	go server.http.Serve(listener)
	return server, nil
}

func respond(w http.ResponseWriter, value any, err error) {
	w.Header().Set("Content-Type", "application/json")
	if err != nil {
		w.WriteHeader(400)
		json.NewEncoder(w).Encode(map[string]any{"error": err.Error()})
		return
	}
	json.NewEncoder(w).Encode(value)
}
func (s *Server) Close() {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	s.http.Shutdown(ctx)
	if data, err := os.ReadFile(s.Path); err == nil {
		var endpoint Endpoint
		if json.Unmarshal(data, &endpoint) == nil && endpoint.Token == s.Endpoint.Token {
			os.Remove(s.Path)
		}
	}
}
