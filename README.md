# bruh

Personal AI agent on Cloudflare + mobile client.

## Structure

```
bruh/
├── server/    # MoltWorker fork — CF Worker + Sandbox agent
└── mobile/    # Expo app (coming soon)
```

## Server (MoltWorker fork)

Forked from [cloudflare/moltworker](https://github.com/cloudflare/moltworker). Runs [OpenClaw](https://github.com/openclaw/openclaw) in a Cloudflare Sandbox container.

See [server/README.md](./server/README.md) for setup and deployment.

## Mobile (Expo)

Cross-platform mobile client. Coming soon.
