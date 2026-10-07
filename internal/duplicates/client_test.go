package duplicates

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/zxxx98/77Photo/internal/faces"
)

func TestWorkerProtocolRejectsWrongModelNonFiniteAndInvalidLocalFeatures(t *testing.T) {
	for _, mode := range []string{"valid", "wrong_model", "zero_norm", "nan", "bad_local"} {
		t.Run(mode, func(t *testing.T) {
			v := make([]float32, 16)
			v[0] = 1
			a := Analysis{Profile: testProfile, RequestID: "photo", Encoding: "float32-le-base64", Local: json.RawMessage(`{"points":"","descriptors":""}`)}
			switch mode {
			case "wrong_model":
				a.Model = "face-model"
			case "zero_norm":
				v[0] = 0
			case "nan":
				v[0] = float32(math.NaN())
			case "bad_local":
				a.Local = json.RawMessage(`null`)
			}
			a.Embedding = base64.StdEncoding.EncodeToString(vectorBytes(v))
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer "+strings.Repeat("t", 32) {
					t.Error("missing worker authorization")
				}
				if e := r.ParseMultipartForm(8 << 20); e != nil || r.FormValue("request_id") != "photo" || r.FormValue("pipeline_id") != testProfile.Pipeline {
					t.Error("invalid multipart request")
				}
				if r.MultipartForm != nil {
					defer r.MultipartForm.RemoveAll()
				}
				_ = json.NewEncoder(w).Encode(a)
			}))
			defer server.Close()
			c := NewClient(faces.Config{URL: server.URL, Token: strings.Repeat("t", 32), Timeout: time.Second})
			_, e := c.Analyze(context.Background(), "photo", testProfile, []byte("preview"))
			if (e == nil) != (mode == "valid") {
				t.Fatalf("analysis %s: %v", mode, e)
			}
		})
	}
}
