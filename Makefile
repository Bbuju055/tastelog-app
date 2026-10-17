PYTHON ?= python3

.PHONY: deps deps-dev sync sync-dev test api-test dev demo demo-api clean

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
	$(PYTHON) -m pytest -v

# Run dev server (--reload is dev-only, do NOT use in prod)
dev:
	$(PYTHON) -m uvicorn api.main:app --reload

# Local Supabase + schema + demo login + sample recipes + env files (no paid keys)
demo:
	./scripts/demo.sh

# Dev server with .env exported into the process environment: the Claude stub
# switch and the schema readiness guard read os.environ, not the dotenv file.
demo-api:
	set -a && . ./.env && set +a && $(PYTHON) -m uvicorn api.main:app --reload

# Run API tests from scratch (creates venv if needed, syncs deps, runs pytest)
api-test:
	./scripts/test-api.sh

# Clean compiled files (rarely needed)
clean:
	rm -f requirements.txt requirements-dev.txt
