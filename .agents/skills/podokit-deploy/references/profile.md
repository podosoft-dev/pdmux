# Deployment profile

The profile at `.podokit/deploy/<name>.json` is application-owned and contains no
secret values. It declares a `driver`, and that decides the shape of the rest of the
document.

## kubernetes-helm (default)

Initialize it with an explicit kubeconfig context:

```bash
bunx --bun @podosoft/podokit deploy init --profile production --context production --host app.example.com
```

Review these fields before planning:

- `target`: context, cluster fingerprint, namespace, release
- `release`: API/web repositories and stable SemVer tag pattern
- `exposure`: Ingress or NodePort. Ingress routes `/` to web and routes only the
  exact paths in `webSocketPaths` directly to API. The list is empty by default;
  root, prefixes, patterns, queries, encoded separators, and traversal are invalid.
  `apiPaths` lists static prefixes under `/api/` (such as `/api/files/uploads/`)
  for bodies above the web `BODY_SIZE_LIMIT`; a second Ingress with a Traefik
  `stripPrefix` Middleware sends them to API without `/api`. It needs a
  Traefik-served IngressClass, and `/api/auth` is rejected. `podo deploy init`
  and `podo add` fill in the paths installed modules declare (file-upload:
  `/api/files/uploads/`); keep them. `edgeProxies` counts the reverse proxies in
  front of the Ingress controller or NodePort (default 0); the web server then
  trusts that many plus the controller in `X-Forwarded-For`. Never set
  `XFF_DEPTH`, `ADDRESS_HEADER`, `TRUSTED_PROXY_HOPS`, or `TRUSTED_PROXY_HEADER`
  in `runtimeConfig`; the profile refuses them.
- `workloads`: API/web replicas and resources plus an optional worker
- `dependencies`: PostgreSQL, Redis, and object storage mode, image, Secret name, and storage.
  PostgreSQL also takes `maxConnections` (default 100) and `appPools` for pools the
  application opens itself; the doctor and the plan check the connection budget
  against them, so lower `DB_POOL_MAX`/`DB_AUTH_POOL_MAX` or replicas when they warn.
- `secrets`: API/optional web Secret names and required key names, plus image-pull Secret
- `runtimeConfig`: non-sensitive environment values only
- `verification`: HTTPS origin and checks with exact statuses and optional JSON fields

The cluster namespace and referenced Secrets must already exist. PodoKit asks `kubectl` to output only Secret key names and never prints or stores their values; the Kubernetes client still materializes the Secret while evaluating that output.

Required keys:

| Secret | Required keys |
| --- | --- |
| API | Profile-declared keys plus enabled dependency connection keys: `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `REDIS_PASSWORD`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` |
| web | Only explicitly declared web keys; omitted by default |
| PostgreSQL dependency | `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` |
| Redis dependency | `REDIS_PASSWORD` |
| Object storage dependency | `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` |
| image pull | A `kubernetes.io/dockerconfigjson` Secret |

Use `inCluster` when the generated Helm release should manage a dependency, `external` when application configuration points to an existing service, and `disabled` only when the application does not require it.

Use the same stable SemVer tag for API and web. `latest`, branch tags, and empty tags are rejected. Planning resolves every deployed tag to an immutable registry digest through Docker Buildx.

## docker-compose

Initialize it with an explicit Docker context. The context may be local or `ssh://`,
and it is pinned by a fingerprint of the endpoint plus the daemon ID, so repointing
it at a different host invalidates the profile instead of deploying somewhere else.

```bash
bunx --bun @podosoft/podokit deploy init \
  --profile production \
  --driver docker-compose \
  --context production \
  --host app.example.com \
  --secrets-dir /etc/podokit/example-app
```

The fields that differ from the Kubernetes driver:

- `target`: Docker context, endpoint fingerprint, Compose project name
- `exposure`: `bindAddress` and `port`, plus an exact `webSocketPaths` allowlist,
  an `apiPaths` prefix list, `trustedProxyCidrs`, and `gatewayImage`. With both
  lists empty, web owns the published port. With paths, an internal gateway owns
  it, sends exact WebSocket paths to API, sends `apiPaths` prefixes to API with
  `/api` removed, and sends every other request to web. Forwarding headers are trusted
  only from the direct proxy CIDRs in `trustedProxyCidrs`; leave it empty without an
  external proxy. `edgeProxies` counts the reverse proxies in front of the published
  port (default 1); with the gateway it must match `trustedProxyCidrs`, which the
  doctor checks. The bind address defaults to `127.0.0.1`, because the expected
  front door is a trusted reverse proxy — binding every interface publishes the app
  before TLS exists.
- `workloads`: replicas plus Compose `cpus` and `memory` limits
- `dependencies`: `managed`, `external`, or `disabled`, each with a named Docker
  volume and the path of its env file on the target host
- `secrets`: env-file paths and required key names, plus `registryLogin`

Credentials live in env files **on the target host**, never in the profile and never
in the rendered Compose project. The doctor reads only the key names, in a throwaway
container that mounts the file read-only. Create those files with the host's own
secret tooling before deploying; PodoKit does not write them.

Required keys:

| Env file | Required keys |
| --- | --- |
| API | Profile-declared keys plus enabled dependency connection keys: `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `REDIS_PASSWORD`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` |
| web | Only explicitly declared web keys; omitted by default |
| PostgreSQL dependency | `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` |
| Redis dependency | `REDIS_PASSWORD` |
| Object storage dependency | `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` |

Data volumes are declared `external`, so `docker compose down -v` cannot delete the
database. Editing an env file changes the containers' rollout label, so the next
apply actually restarts them instead of leaving stale environment values running.
The gateway image is resolved to an immutable digest during planning. The external
TLS proxy keeps one upstream; do not duplicate the WebSocket path split there.
