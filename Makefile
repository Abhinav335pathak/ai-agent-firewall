.PHONY: help setup up down logs test demo demo-auto reset isolation smoke clean

help:
	@echo "make setup      create .env from .env.example (first time only)"
	@echo "make up         build and start the whole stack"
	@echo "make test       policy validation + unit tests (needs Node 20+)"
	@echo "make demo       run the 4 agent scenarios (you approve in the app/dashboard)"
	@echo "make demo-auto  run the scenarios hands-free (robot reviewer, asserts results)"
	@echo "make reset      restore the company DB and clear the feed"
	@echo "make isolation  prove the agent cannot reach the data tier"
	@echo "make smoke      black-box checks against the running stack"
	@echo "make logs       follow all container logs"
	@echo "make down       stop the stack (keeps data)"
	@echo "make clean      stop the stack and DELETE all data volumes"

setup:
	@test -f .env && echo ".env already exists" || (cp .env.example .env && echo "created .env")

up: setup
	docker compose up -d --build --wait
	@echo "Dashboard: http://localhost/company-status"

down:
	docker compose down

clean:
	docker compose down -v

logs:
	docker compose logs -f --tail=50

test:
	cd firewall-proxy && (if [ -f package-lock.json ]; then npm ci; else npm install; fi) && npm run validate-policy && npm test

demo:
	node agent-simulator/simulate.js --url http://localhost

demo-auto:
	ADMIN_TOKEN=$$(grep '^ADMIN_TOKEN=' .env | cut -d= -f2) node agent-simulator/simulate.js --url http://localhost --auto-approve --assert --delay 500

reset:
	ADMIN_TOKEN=$$(grep '^ADMIN_TOKEN=' .env | cut -d= -f2) ./scripts/reset.sh http://localhost

isolation:
	./scripts/prove-isolation.sh

smoke:
	./scripts/smoke-test.sh http://localhost
