# Application rollback

Inspect status and Helm history before choosing a revision:

```bash
npx @podosoft/podokit deploy status --profile production --json
helm history <release> --namespace <namespace> --kube-context <context>
```

Preview a rollback:

```bash
npx @podosoft/podokit deploy rollback --profile production --revision <number>
```

Show the target revision, current revision, context, namespace, warning, and generated plan hash. Obtain explicit approval, then pass that exact hash with `--confirm`.

Rollback changes only the application Helm release. It does not reverse database migrations, change the dependency release, delete PersistentVolumeClaims, or delete Secrets. If the old application is incompatible with the current database schema, do not roll back; prepare a forward fix instead.
