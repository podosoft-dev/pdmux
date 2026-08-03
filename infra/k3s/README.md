# Example k3s manifests

These are **illustrative**. `podo deploy` does not read or apply them.

For a real deployment, initialize a profile and let PodoKit render the manifests it
will actually apply — with image digests, probes, disruption budgets, a migration
Job, and a confirmation hash:

```bash
podo deploy init --profile production --context production --host app.example.com
podo deploy render --profile production --release v1.2.3
```

Keep these files if you want a starting point for hand-managed manifests, or delete
the directory if you deploy with `podo deploy`. If you do apply them by hand, replace
every `example.com` and `ghcr.io/example/...` placeholder first, and note that the
image tags below are placeholders too: the deployment tooling rejects `latest`,
branch tags, and empty tags, and so should you.
