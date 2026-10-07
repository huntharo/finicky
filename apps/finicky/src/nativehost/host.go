package nativehost

type Callbacks struct {
	OpenURL      func(url, name, bundleID, path string, nativeMS float64)
	ShowSettings func()
	Quit         func()
}

type DefaultStatus struct {
	IsDefault bool   `json:"isDefault"`
	HTTP      string `json:"http"`
	HTTPS     string `json:"https"`
	HTTPPath  string `json:"httpPath,omitempty"`
	HTTPSPath string `json:"httpsPath,omitempty"`
	Pending   bool   `json:"pending,omitempty"`
	Error     string `json:"error,omitempty"`
}
