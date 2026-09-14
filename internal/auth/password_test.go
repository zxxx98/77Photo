package auth

import (
	"strings"
	"testing"
)

func TestPasswordHashUsesArgon2idAndVerifies(t *testing.T) {
	password := "correct horse battery staple"
	hash, err := HashPassword(password)
	if err != nil {
		t.Fatalf("HashPassword() error = %v", err)
	}
	if len(hash) < 40 || hash[:10] != "$argon2id$" {
		t.Fatalf("hash = %q, want argon2id PHC string", hash)
	}
	if ok, err := VerifyPassword(hash, password); err != nil || !ok {
		t.Fatalf("VerifyPassword(correct) = (%v, %v), want (true, nil)", ok, err)
	}
	if ok, err := VerifyPassword(hash, "wrong password"); err != nil || ok {
		t.Fatalf("VerifyPassword(wrong) = (%v, %v), want (false, nil)", ok, err)
	}
	otherHash, err := HashPassword(password)
	if err != nil {
		t.Fatal(err)
	}
	if hash == otherHash {
		t.Fatal("two password hashes are identical; salts must be independent")
	}
}

func TestValidateCredentialsUsesCharacterLimits(t *testing.T) {
	if err := ValidateCredentials(strings.Repeat("界", 64), strings.Repeat("合", 12)); err != nil {
		t.Fatalf("valid Unicode credentials rejected: %v", err)
	}
	if err := ValidateCredentials(strings.Repeat("界", 65), strings.Repeat("合", 12)); err == nil {
		t.Fatal("65-character username accepted")
	}
	if err := ValidateCredentials("owner", strings.Repeat("合", 11)); err == nil {
		t.Fatal("11-character password accepted")
	}
	if err := ValidateCredentials("owner", strings.Repeat("合", 257)); err == nil {
		t.Fatal("257-character password accepted")
	}
}
