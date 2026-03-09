---
name: web_deploy
description: Trigger and monitor MARX Biotech web deploy via GitHub Actions. Use when the user asks to deploy, redeploy, or check deploy status for staging/preview/production environments.
command-dispatch: agent
command-arg-mode: raw
user-invocable: false
---

# Web Deploy — MARX Biotech

Trigger the `web-deploy.yml` workflow in the env repo to redeploy the static website (S3 + CloudFront invalidation) for a given environment. This is used when CMS content changes and the site needs to be regenerated — no code change required.

## Authentication

Use the `gh_app_token` script to get a GitHub App installation token:

```bash
GH_TOKEN=$(gh_app_token marx-env)
```

This token authenticates as the `for-gitops-env-repo` GitHub App, which has permission to trigger workflows and push to the env repo.

## Trigger Deploy

```bash
GH_TOKEN=$(gh_app_token marx-env) gh workflow run web-deploy.yml \
  --repo marxbiotech/www-marxbiotech-com-env \
  -f environment=<ENV>
```

Where `<ENV>` is one of: `staging`, `preview`, `production`.

## Monitor Deploy Status

After triggering, wait a few seconds then check status:

```bash
GH_TOKEN=$(gh_app_token marx-env) gh run list \
  --repo marxbiotech/www-marxbiotech-com-env \
  --workflow web-deploy.yml \
  --limit 1
```

To watch a specific run until completion:

```bash
GH_TOKEN=$(gh_app_token marx-env) gh run watch <RUN_ID> \
  --repo marxbiotech/www-marxbiotech-com-env
```

## Environment Details

| Environment | Domain | Notes |
|---|---|---|
| staging | starkerneldev.com | 開發測試，自動部署 |
| preview | preview.marxbiotech.com | 正式資料 preview，需 review |
| production | marxbiotech.com | 正式環境 |

## Important Notes

- Web deploy regenerates static HTML from CMS content using the existing web-builder Docker image
- It does NOT deploy new code — for code changes, use the app repo CI/CD pipeline
- The workflow bumps `deploy-trigger.auto.tfvars` then pushes to main, which triggers `terraform apply`
- Token is short-lived (1 hour) — get a fresh one for each operation
