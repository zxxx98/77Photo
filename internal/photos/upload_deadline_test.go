package photos

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestUploadDeadlineOverridesServerBodyAndResponseDeadlines(t *testing.T) {
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		setUploadDeadline(w, time.Second)
		if _, err := io.Copy(io.Discard, r.Body); err != nil {
			t.Errorf("read upload: %v", err)
			return
		}
		time.Sleep(100 * time.Millisecond)
		_, _ = w.Write([]byte("ok"))
	}))
	server.Config.ReadTimeout = 40 * time.Millisecond
	server.Config.WriteTimeout = 40 * time.Millisecond
	server.Start()
	defer server.Close()

	input, output := io.Pipe()
	request, err := http.NewRequest(http.MethodPost, server.URL, input)
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		time.Sleep(100 * time.Millisecond)
		_, writeErr := output.Write([]byte("video"))
		_ = output.CloseWithError(writeErr)
	}()
	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatalf("upload after short server deadlines: %v", err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil || response.StatusCode != http.StatusOK || string(body) != "ok" {
		t.Fatalf("response = %d %q, read error %v", response.StatusCode, body, err)
	}
}

func TestUploadStorageFullIsReportedWithoutClaimingSuccess(t *testing.T) {
	for _, cause := range []error{syscall.ENOSPC, syscall.EDQUOT} {
		response := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, uploadPath, nil)
		(&HTTPHandler{}).writeServiceError(response, request, fmt.Errorf("write upload: %w", cause))
		if response.Code != http.StatusInsufficientStorage || !strings.Contains(response.Body.String(), `"code":"STORAGE_FULL"`) {
			t.Fatalf("cause %v: response = %d %s", cause, response.Code, response.Body.String())
		}
	}
}
