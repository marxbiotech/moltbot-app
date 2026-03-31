# ssh-tools

OpenClaw plugin for SSH key diagnostics.

## Commands

| Command | Description |
|---------|-------------|
| `/ssh_check` | Diagnose SSH key health — presence, permissions, known_hosts, GitHub connectivity |

## Key Provisioning

SSH keys are provisioned externally via **K8s Secret** with `subPath` mount:

```yaml
volumes:
  - name: ssh-key
    secret:
      secretName: moltbot-ssh-key
      defaultMode: 0600
volumeMounts:
  - name: ssh-key
    mountPath: /home/node/.ssh/id_ed25519
    subPath: ssh-privatekey
    readOnly: true
```

Public key is tracked in moltbot-env (per-environment) or mounted via ConfigMap.

## Requirements

- `ssh-keygen` (fingerprint display), `ssh` (connectivity test) — provided by `openssh-client`
