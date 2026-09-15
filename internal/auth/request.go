package auth

import (
	"context"
	"net/http"
	"strings"
)

type AuthMethod string

const (
	AuthMethodCookie AuthMethod = "cookie"
	AuthMethodBearer AuthMethod = "bearer"
)

type RequestAuth struct {
	Account    Account
	Session    Session
	Method     AuthMethod
	Credential string
	DeviceID   string
}

func (s *Service) AuthenticateRequest(ctx context.Context, r *http.Request) (RequestAuth, error) {
	if value := strings.TrimSpace(r.Header.Get("Authorization")); value != "" {
		parts := strings.Fields(value)
		if len(parts) > 0 && strings.EqualFold(parts[0], "Bearer") {
			if len(parts) != 2 || parts[1] == "" {
				return RequestAuth{}, ErrUnauthorized
			}
			principal, err := s.CurrentBearer(ctx, parts[1])
			if err != nil {
				return RequestAuth{}, err
			}
			return RequestAuth{
				Account:    principal.Account,
				Method:     AuthMethodBearer,
				Credential: parts[1],
				DeviceID:   principal.DeviceID,
			}, nil
		}
	}

	token := SessionTokenFromRequest(r)
	account, session, err := s.Current(ctx, token)
	if err != nil {
		return RequestAuth{}, err
	}
	return RequestAuth{
		Account:    account,
		Session:    session,
		Method:     AuthMethodCookie,
		Credential: token,
	}, nil
}

func (s *Service) AuthorizeWrite(r *http.Request, authenticated RequestAuth) error {
	if authenticated.Method == AuthMethodBearer {
		return nil
	}
	if authenticated.Method != AuthMethodCookie {
		return ErrCSRF
	}
	return s.ValidateCSRF(authenticated.Session, r.Header.Get(CSRFHeaderName()))
}
