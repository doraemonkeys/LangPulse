package ingest

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/langpulse/collector/quality"
)

func TestHeartbeatRunAndSendJSONErrorPaths(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/internal/quality-runs/run-1/heartbeat":
			_, _ = writer.Write([]byte(`{"run":{"run_id":"run-1","attempt_no":1,"status":"running","observed_at":"2026-04-07T10:00:00Z","lease_expires_at":"invalid"}}`))
		case "/internal/quality-runs/run-1/rows:batch":
			writer.WriteHeader(http.StatusInternalServerError)
			_, _ = writer.Write([]byte(`temporary failure`))
		default:
			t.Fatalf("unexpected path %q", request.URL.Path)
		}
	}))
	defer server.Close()

	client, err := NewClient(server.URL, "secret", WithHTTPClient(server.Client()))
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}

	_, err = client.HeartbeatRun(context.Background(), "run-1")
	if err == nil || !strings.Contains(err.Error(), "parse heartbeat lease_expires_at") {
		t.Fatalf("HeartbeatRun() error = %v, want malformed timestamp error", err)
	}

	err = client.UpsertRows(context.Background(), []quality.RowUpsert{{
		RunID:          "run-1",
		LanguageID:     "go",
		ThresholdValue: 0,
		Count:          1,
		CollectedAt:    time.Now().UTC(),
	}})
	if err == nil || !strings.Contains(err.Error(), "temporary failure") {
		t.Fatalf("UpsertRows() error = %v, want sendJSON API error", err)
	}
}

func TestUpsertRowsRejectsEmptyAndCrossRunBatches(t *testing.T) {
	client, err := NewClient("https://example.com", "secret")
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}

	if err := client.UpsertRows(context.Background(), nil); err == nil || !strings.Contains(err.Error(), "at least one row") {
		t.Fatalf("UpsertRows(empty) error = %v, want empty-batch rejection", err)
	}

	err = client.UpsertRows(context.Background(), []quality.RowUpsert{
		{RunID: "run-a", LanguageID: "go", ThresholdValue: 0, Count: 1, CollectedAt: time.Now().UTC()},
		{RunID: "run-b", LanguageID: "go", ThresholdValue: 10, Count: 2, CollectedAt: time.Now().UTC()},
	})
	if err == nil || !strings.Contains(err.Error(), "mixed run_id in batch") {
		t.Fatalf("UpsertRows(mixed run_id) error = %v, want cross-run rejection", err)
	}
}

func TestUpsertRowsSuccessAndTransparentErrorPropagation(t *testing.T) {
	testCases := []struct {
		name       string
		statusCode int
		body       string
		wantStatus int
		wantCode   string
	}{
		{
			name:       "transparent propagation for 400",
			statusCode: http.StatusBadRequest,
			body:       `{"error":{"code":"unknown_language","message":"language not active"}}`,
			wantStatus: http.StatusBadRequest,
			wantCode:   "unknown_language",
		},
		{
			name:       "transparent propagation for 429",
			statusCode: http.StatusTooManyRequests,
			body:       `{"error":{"code":"rate_limited","message":"slow down"}}`,
			wantStatus: http.StatusTooManyRequests,
			wantCode:   "rate_limited",
		},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				if request.URL.EscapedPath() != "/internal/quality-runs/run-1/rows:batch" || request.Method != http.MethodPost {
					t.Fatalf("unexpected request %s %s", request.Method, request.URL.EscapedPath())
				}
				writer.WriteHeader(testCase.statusCode)
				_, _ = writer.Write([]byte(testCase.body))
			}))
			defer server.Close()

			client, err := NewClient(server.URL, "secret", WithHTTPClient(server.Client()))
			if err != nil {
				t.Fatalf("NewClient() error = %v", err)
			}

			err = client.UpsertRows(context.Background(), []quality.RowUpsert{{
				RunID:          "run-1",
				LanguageID:     "go",
				ThresholdValue: 10,
				Count:          4,
				CollectedAt:    time.Date(2026, 4, 7, 9, 0, 0, 0, time.UTC),
			}})

			var apiErr *APIError
			if !errors.As(err, &apiErr) {
				t.Fatalf("UpsertRows() error = %T, want *APIError", err)
			}
			if apiErr.StatusCode != testCase.wantStatus || apiErr.Code != testCase.wantCode {
				t.Fatalf("APIError = %#v, want status=%d code=%q", apiErr, testCase.wantStatus, testCase.wantCode)
			}
		})
	}
}

func TestUpsertRowsSendsSinglePOSTWithAllRows(t *testing.T) {
	var (
		capturedPath   string
		capturedMethod string
		capturedRows   []any
	)

	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		capturedPath = request.URL.EscapedPath()
		capturedMethod = request.Method

		payload := mustDecodeJSONMap(t, request.Body, "rows:batch")
		rows, ok := payload["rows"].([]any)
		if !ok {
			t.Fatalf("rows payload = %#v, want array", payload)
		}
		capturedRows = rows

		mustEncodeJSONMap(t, writer, map[string]any{
			"run": map[string]any{
				"run_id":           "run-42",
				"attempt_no":       1,
				"status":           "running",
				"observed_at":      "2026-04-07T10:00:00Z",
				"lease_expires_at": "2026-04-07T10:10:00Z",
				"actual_rows":      3,
			},
		}, "rows:batch")
	}))
	defer server.Close()

	client, err := NewClient(server.URL, "secret", WithHTTPClient(server.Client()))
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}

	collectedAt := time.Date(2026, 4, 7, 10, 0, 0, 0, time.UTC)
	rows := []quality.RowUpsert{
		{RunID: "run-42", LanguageID: "go", ThresholdValue: 0, Count: 100, CollectedAt: collectedAt},
		{RunID: "run-42", LanguageID: "go", ThresholdValue: 10, Count: 55, CollectedAt: collectedAt},
		{RunID: "run-42", LanguageID: "rust", ThresholdValue: 0, Count: 33, CollectedAt: collectedAt},
	}

	if err := client.UpsertRows(context.Background(), rows); err != nil {
		t.Fatalf("UpsertRows() error = %v", err)
	}

	if capturedMethod != http.MethodPost || capturedPath != "/internal/quality-runs/run-42/rows:batch" {
		t.Fatalf("request = %s %s, want POST /internal/quality-runs/run-42/rows:batch", capturedMethod, capturedPath)
	}

	if len(capturedRows) != 3 {
		t.Fatalf("len(rows) = %d, want 3", len(capturedRows))
	}
}
