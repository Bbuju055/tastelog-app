PYTHON ?= python3

.PHONY: deps deps-dev sync sync-dev test api-test dev clean

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

# Run API tests from scratch (creates venv if needed, syncs deps, runs pytest)
api-test:
	./scripts/test-api.sh

# Clean compiled files (rarely needed)
clean:
	rm -f requirements.txt requirements-dev.txt
