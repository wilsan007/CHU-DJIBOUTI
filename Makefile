.PHONY: help install check lint format typecheck test seed check-repo migrate api

help: ## Liste les commandes disponibles
	@grep -E '^[a-z-]+:.*##' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  make %-12s %s\n", $$1, $$2}'

install: ## Installe les dépendances
	pnpm install --frozen-lockfile

check: ## Lance tous les contrôles (style, types, tests, dépôt)
	pnpm run check

lint: ## Analyse du code
	pnpm run lint

format: ## Reformate le code
	pnpm run format

typecheck: ## Vérifie les types
	pnpm run typecheck

test: ## Lance les tests
	pnpm run test

check-repo: ## Vérifie qu'aucun secret n'est dans le dépôt
	pnpm run check:repo

seed: ## Génère les données fictives dans tools/seed/out
	pnpm run seed

migrate: ## Applique les migrations (DATABASE_MIGRATOR_URL obligatoire)
	pnpm --filter @chu/api migrate

api: ## Démarre le noyau applicatif (voir services/api/README.md)
	pnpm --filter @chu/api start

# Les commandes `make up`, `make down`, `make smoke`, `make backup` et
# `make restore` arrivent avec la phase 1 (étapes 5.2 à 5.10 du plan).
