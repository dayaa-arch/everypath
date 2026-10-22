package greet

import "testing"

func TestHello(t *testing.T) {
	if Hello("a") != "hello, a" {
		t.Fatal("unexpected greeting")
	}
}
