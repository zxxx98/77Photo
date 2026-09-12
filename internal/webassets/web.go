package webassets

import (
	"embed"
	"io/fs"
	"net/http"
	"path"
	"strings"
)

// Static is replaced with the Vite output during the container/release build.
// The checked-in shell keeps `go test` and a plain local `go run` useful before
// the frontend toolchain has been invoked.
//
//go:embed static/*
var Static embed.FS

func Handler() http.Handler {
	files, err := fs.Sub(Static, "static")
	if err != nil {
		panic(err)
	}
	fileServer := http.FileServer(http.FS(files))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if name == "" {
			name = "index.html"
		}
		if _, err := fs.Stat(files, name); err != nil {
			if strings.HasPrefix(name, "assets/") || path.Ext(name) != "" {
				http.NotFound(w, r)
				return
			}
			name = "index.html"
		}
		if name == "index.html" {
			data, err := fs.ReadFile(files, name)
			if err != nil {
				http.Error(w, "web shell unavailable", http.StatusInternalServerError)
				return
			}
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(data)
			return
		}
		r2 := r.Clone(r.Context())
		r2.URL.Path = "/" + name
		fileServer.ServeHTTP(w, r2)
	})
}
