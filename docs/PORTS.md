# Local Ports

| Service | Port | Notes |
| --- | --- | --- |
| Web | 3000 | Next.js app from `pnpm dev:web` |
| API | 4000 | Fastify control plane and embedded local runner from `pnpm dev:api` |
| Worker | none | Polls the API from `pnpm dev:worker`; no listener |
| Postgres | 5432 | Optional Docker middleware from `infra/docker-compose.yml` |
| Redis | 6379 | Optional Docker middleware from `infra/docker-compose.yml` |
| MinIO API | 9000 | Optional Docker artifact storage API |
| MinIO Console | 9001 | Optional Docker artifact storage console |

The API, web app, and worker are started with pnpm scripts. Docker compose only provides optional middleware and does not run application containers.
