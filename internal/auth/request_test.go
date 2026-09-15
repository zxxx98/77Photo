package auth

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestAuthenticateRequestSeparatesBearerAndCookie(t *testing.T) {
	service, account := newMobileAuthService(t)
	mobile, err := service.CreateMobileSession(context.Background(), account.ID, MobileDeviceInput{
		Name: "Pixel", Platform: "android", AppVersion: "1",
	})
	if err != nil {
		t.Fatal(err)
	}
	_, cookieSession, err := service.Authenticate(context.Background(), account.Username, "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}

	cookieReq := httptest.NewRequest(http.MethodGet, "/api/v1/photos", nil)
	cookieReq.AddCookie(&http.Cookie{Name: SessionCookieName(), Value: cookieSession.Token})
	cookieAuth, err := service.AuthenticateRequest(cookieReq.Context(), cookieReq)
	if err != nil {
		t.Fatalf("cookie authentication error = %v", err)
	}
	if cookieAuth.Method != AuthMethodCookie || cookieAuth.Credential != cookieSession.Token || cookieAuth.DeviceID != "" || cookieAuth.Account.ID != account.ID {
		t.Fatalf("cookie authentication = %+v", cookieAuth)
	}

	bearerReq := httptest.NewRequest(http.MethodGet, "/api/v1/photos", nil)
	bearerReq.Header.Set("Authorization", "Bearer "+mobile.AccessToken)
	bearerReq.AddCookie(&http.Cookie{Name: SessionCookieName(), Value: cookieSession.Token})
	bearerAuth, err := service.AuthenticateRequest(bearerReq.Context(), bearerReq)
	if err != nil {
		t.Fatalf("bearer authentication error = %v", err)
	}
	if bearerAuth.Method != AuthMethodBearer || bearerAuth.Credential != mobile.AccessToken || bearerAuth.DeviceID != mobile.Device.ID || bearerAuth.Account.ID != account.ID {
		t.Fatalf("bearer authentication = %+v", bearerAuth)
	}
}

func TestAuthenticateRequestDoesNotFallBackFromInvalidBearer(t *testing.T) {
	service, account := newMobileAuthService(t)
	_, cookieSession, err := service.Authenticate(context.Background(), account.Username, "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/v1/photos", nil)
	req.Header.Set("Authorization", "Bearer invalid-token")
	req.AddCookie(&http.Cookie{Name: SessionCookieName(), Value: cookieSession.Token})
	if _, err := service.AuthenticateRequest(req.Context(), req); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("invalid bearer authentication error = %v, want ErrUnauthorized", err)
	}
}

func TestAuthorizeWriteSeparatesCookieAndBearer(t *testing.T) {
	service, account := newMobileAuthService(t)
	mobile, err := service.CreateMobileSession(context.Background(), account.ID, MobileDeviceInput{
		Name: "Pixel", Platform: "android", AppVersion: "1",
	})
	if err != nil {
		t.Fatal(err)
	}

	bearerReq := httptest.NewRequest(http.MethodPost, "/api/v1/photos/upload", nil)
	bearerReq.Header.Set("Authorization", "Bearer "+mobile.AccessToken)
	bearer, err := service.AuthenticateRequest(bearerReq.Context(), bearerReq)
	if err != nil || bearer.Method != AuthMethodBearer {
		t.Fatalf("bearer = %+v, %v", bearer, err)
	}
	if err := service.AuthorizeWrite(bearerReq, bearer); err != nil {
		t.Fatal(err)
	}

	_, cookieSession, err := service.Authenticate(context.Background(), account.Username, "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	cookieReq := httptest.NewRequest(http.MethodPost, "/api/v1/photos/upload", nil)
	cookieReq.AddCookie(&http.Cookie{Name: SessionCookieName(), Value: cookieSession.Token})
	cookieAuth, err := service.AuthenticateRequest(cookieReq.Context(), cookieReq)
	if err != nil {
		t.Fatalf("cookie authentication error = %v", err)
	}
	if err := service.AuthorizeWrite(cookieReq, cookieAuth); !errors.Is(err, ErrCSRF) {
		t.Fatalf("cookie without csrf = %v, want ErrCSRF", err)
	}
}
