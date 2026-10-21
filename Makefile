PYTHON ?= python3

.PHONY: deps deps-dev sync sync-dev test api-test dev demo demo-api demo-web eval-fidelity clean

# Compile locked requirements from .in files
deps:
	$(PYTHON) -m piptools compile --generate-hashes --strip-extras requirements.in -o requirements.txt

deps-dev:
	$(PYTHON) -m piptools compile --generate-hashes --strip-extras requirements-dev.in -o requirements-dev.txt

# Install exactly what's locked (use in CI/prod)
sync:
	$(PYTHON) -m piptools sync requirements.txt

sync-dev:
	$(PYTHON) -m piptools sync requirements-dev.txt

# Run tests (pytest.ini testpaths: tests + api/tests)
test:
	set -a && . ./.env.example && set +a && $(PYTHON) -m pytest -q

# Run dev server (--reload is dev-only, do NOT use in prod)
dev:
	$(PYTHON) -m uvicorn api.main:app --reload

# Local Supabase + schema + demo login + sample recipes + env files (no paid keys)
demo:
	./scripts/demo.sh

# Demo settings are exported without replacing the user's .env files.
demo-api:
	set -a && . ./.env.demo && set +a && $(PYTHON) -m uvicorn api.main:app --host 127.0.0.1

demo-web:
	set -a && . ./tastelog-web/.env.demo.local && set +a && cd tastelog-web && npm run dev -- --hostname 127.0.0.1

# Capture-fidelity eval with .env exported: the Anthropic SDK reads
# ANTHROPIC_API_KEY from the process environment, the harness never does.
# Spends money (about 40 calls per full run). ARGS passes harness flags, e.g.
#   make eval-fidelity PYTHON=api/.venv/bin/python ARGS="--arm production --runs 1 --case garlic_aioli"
eval-fidelity:
	set -a && . ./.env && set +a && $(PYTHON) tests/eval/fidelity/run_capture_fidelity.py $(ARGS)

# Run API tests from scratch (creates venv if needed, syncs deps, runs pytest)
api-test:
	./scripts/test-api.sh

# Clean compiled files (rarely needed)
clean:
	rm -f requirements.txt requirements-dev.txt
