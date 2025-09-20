.PHONY: up test e2e

up:
	pnpm dev

test:
	pnpm test

e2e:
	pnpm turbo run test --filter=examples-echo
