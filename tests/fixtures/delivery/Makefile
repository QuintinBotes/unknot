VERSION := 1.0
.PHONY: all build test deploy

all: build test

build: deps
	go build ./...

deps:
	go mod download

test: build
	go test ./...

deploy: build
	helm upgrade --install api ./chart
