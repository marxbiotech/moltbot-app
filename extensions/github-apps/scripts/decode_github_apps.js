#!/usr/bin/env node
// decode_github_apps — Decode GITHUB_APPS env var to filesystem credentials
// Usage: decode_github_apps (reads GITHUB_APPS from environment)
//
// Writes to ~/.github-apps/<name>/{app-id, private-key.pem, installation-id}
// Used by gh_app_token script to generate installation tokens.

'use strict';

const fs = require('fs');
const path = require('path');

const raw = process.env.GITHUB_APPS;
if (!raw) {
    console.error('ERROR: GITHUB_APPS environment variable is not set');
    process.exit(1);
}

try {
    const apps = JSON.parse(raw);
    // Design Decision: Skip object type check — field validation inside the loop already
    // catches non-object entries (missing appId/installationId/privateKey). An array or
    // primitive would produce nonsensical names but fail on field checks before any files
    // are written. The env var is operator-controlled, so the risk is negligible.
    const required = ['appId', 'installationId', 'privateKey'];
    for (const [name, cfg] of Object.entries(apps)) {
        if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
            console.error(`ERROR: Invalid GitHub App name "${name}". Use only [a-zA-Z0-9_-]`);
            process.exit(1);
        }
        for (const field of required) {
            if (cfg[field] == null || cfg[field] === '') {
                console.error(`ERROR: GitHub App "${name}" is missing required field "${field}"`);
                process.exit(1);
            }
        }
        const dir = path.join(process.env.HOME, '.github-apps', name);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'app-id'), String(cfg.appId));
        fs.writeFileSync(path.join(dir, 'installation-id'), String(cfg.installationId));
        // Design Decision: No PEM header validation after base64 decode — gh_app_token.sh
        // already validates the key with 'openssl rsa -check' before signing, which catches
        // corrupt/invalid PEM and provides a clear error message pointing to the privateKey field.
        fs.writeFileSync(path.join(dir, 'private-key.pem'), Buffer.from(String(cfg.privateKey), 'base64').toString());
        fs.chmodSync(path.join(dir, 'private-key.pem'), 0o600);
    }
    console.log('GitHub Apps configured:', Object.keys(apps).join(', '));
} catch (err) {
    console.error('ERROR: Failed to parse GITHUB_APPS:', err.message);
    process.exit(1);
}
